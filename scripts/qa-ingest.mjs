#!/usr/bin/env node

import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { extname, isAbsolute, relative, resolve } from 'node:path';
import { parseJUnit } from '../apps/web/lib/junit.ts';

const DEFAULT_URL = 'http://localhost:18080';
const REQUEST_TIMEOUT_MS = 3000;

const LANGUAGE_BY_EXTENSION = {
  '.c': 'c',
  '.cc': 'cpp',
  '.cpp': 'cpp',
  '.cxx': 'cpp',
  '.cs': 'csharp',
  '.css': 'css',
  '.go': 'go',
  '.h': 'c',
  '.hpp': 'cpp',
  '.html': 'html',
  '.java': 'java',
  '.js': 'javascript',
  '.jsx': 'javascript',
  '.json': 'json',
  '.kt': 'kotlin',
  '.md': 'markdown',
  '.mjs': 'javascript',
  '.mts': 'typescript',
  '.php': 'php',
  '.py': 'python',
  '.rb': 'ruby',
  '.rs': 'rust',
  '.sh': 'shell',
  '.sql': 'sql',
  '.swift': 'swift',
  '.ts': 'typescript',
  '.tsx': 'typescript',
  '.vue': 'vue',
  '.xml': 'xml',
  '.yaml': 'yaml',
  '.yml': 'yaml',
};

function usageError(message) {
  throw new Error(`${message}; usage: node scripts/qa-ingest.mjs --junit <path> --kind <kind> [--runner <s>] [--title <s>] [--no-sources] [--project-id <uuid>]`);
}

function parseArgs(argv) {
  const options = { junit: null, kind: null, runner: null, title: null, noSources: false, projectId: null };
  const valueOptions = new Map([
    ['--junit', 'junit'],
    ['--kind', 'kind'],
    ['--runner', 'runner'],
    ['--title', 'title'],
    ['--project-id', 'projectId'],
  ]);

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--no-sources') {
      options.noSources = true;
      continue;
    }
    const optionName = valueOptions.get(argument);
    if (!optionName) usageError(`unknown option ${argument}`);
    const value = argv[index + 1];
    if (!value || value.startsWith('--')) usageError(`${argument} requires a value`);
    options[optionName] = value;
    index += 1;
  }

  if (!options.junit) usageError('--junit is required');
  if (!options.kind) usageError('--kind is required');
  return options;
}

function resolveApiToken() {
  const environmentToken = process.env.OPENMEMORY_API_TOKEN?.trim();
  if (environmentToken) return environmentToken;

  const tokenPath = resolve(homedir(), '.openmemory', 'api_token');
  const fileToken = readFileSync(tokenPath, 'utf8').trim();
  if (!fileToken) throw new Error(`API token file at ${tokenPath} is empty`);
  return fileToken;
}

function apiBase() {
  return (process.env.OPENMEMORY_URL || DEFAULT_URL).replace(/\/+$/u, '');
}

async function requestJson(url, token, init = {}) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const response = await fetch(url, {
      ...init,
      signal: controller.signal,
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/json',
        ...(init.body === undefined ? {} : { 'Content-Type': 'application/json' }),
        ...(init.headers || {}),
      },
    });
    const body = await response.text();
    if (!response.ok) throw new Error(`${init.method || 'GET'} ${url} returned HTTP ${response.status}`);
    try {
      return body ? JSON.parse(body) : {};
    } catch {
      throw new Error(`${init.method || 'GET'} ${url} returned invalid JSON`);
    }
  } finally {
    clearTimeout(timeout);
  }
}

function normalizedPath(value) {
  const slashPath = value.replaceAll('\\', '/');
  if (slashPath === '/') return '/';
  return slashPath.replace(/\/+$/u, '');
}

function projectPathCandidates(project) {
  return [project.path, project.canonical_path]
    .filter((candidate) => typeof candidate === 'string' && candidate.trim() !== '')
    .map((candidate) => normalizedPath(candidate.trim()));
}

function pathIsWithin(candidate, cwd) {
  return cwd === candidate || (candidate === '/' ? cwd.startsWith('/') : cwd.startsWith(`${candidate}/`));
}

async function resolveProject(token, cwd, projectId) {
  if (projectId) return { id: projectId };

  const response = await requestJson(`${apiBase()}/projects`, token);
  const projects = response?.projects;
  if (!Array.isArray(projects)) throw new Error('GET /projects returned no projects array');

  const normalizedCwd = normalizedPath(resolve(cwd));
  let best = null;
  let bestLength = -1;
  for (const project of projects) {
    for (const candidate of projectPathCandidates(project)) {
      if (pathIsWithin(candidate, normalizedCwd) && candidate.length > bestLength) {
        best = project;
        bestLength = candidate.length;
      }
    }
  }
  if (!best?.id) throw new Error(`no registered project matches ${cwd}`);
  return best;
}

function gitValue(argumentsList, cwd) {
  try {
    return execFileSync('git', ['rev-parse', ...argumentsList], {
      cwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim() || null;
  } catch {
    return null;
  }
}

function repoRootFor(project, cwd) {
  const projectRoot = projectPathCandidates(project)[0];
  return resolve(projectRoot || gitValue(['--show-toplevel'], cwd) || cwd);
}

function candidateSourcePaths(file, cwd, repoRoot) {
  if (isAbsolute(file)) return [resolve(file)];
  return [resolve(cwd, file), resolve(repoRoot, file)];
}

function sourcePathFor(file, cwd, repoRoot, checkExisting = true) {
  const candidates = candidateSourcePaths(file, cwd, repoRoot);
  if (!checkExisting) {
    const cwdRelativeToRepo = normalizedPath(relative(repoRoot, cwd));
    const reportedPath = normalizedPath(file).replace(/^\.\//u, '');
    if (cwdRelativeToRepo && (reportedPath === cwdRelativeToRepo || reportedPath.startsWith(`${cwdRelativeToRepo}/`))) {
      return candidates[1];
    }
    return candidates[0];
  }
  for (const candidate of candidates) {
    try {
      readFileSync(candidate);
      return candidate;
    } catch {
      // The read below reports the original error if none of the likely roots works.
    }
  }
  return candidates[0];
}

function repoRelativePath(filePath, repoRoot) {
  const candidate = normalizedPath(relative(repoRoot, filePath));
  if (candidate && candidate !== '..' && !candidate.startsWith('../') && !isAbsolute(candidate)) return candidate;
  return normalizedPath(filePath).replace(/^\.\//u, '');
}

function languageFor(file) {
  return LANGUAGE_BY_EXTENSION[extname(file).toLowerCase()] || null;
}

function reportDurationMs(xml, cases) {
  const comment = /<!--\s*duration_ms\s+([0-9]+(?:\.[0-9]+)?)\s*-->/u.exec(xml);
  if (comment) return Math.round(Number(comment[1]));

  const root = /<testsuites\b[^>]*\btime\s*=\s*(?:"([^"]*)"|'([^']*)')/u.exec(xml);
  if (root) {
    const seconds = Number(root[1] ?? root[2]);
    if (Number.isFinite(seconds) && seconds >= 0) return Math.round(seconds * 1000);
  }

  const total = cases.reduce((sum, item) => sum + (item.duration_ms ?? 0), 0);
  return total > 0 ? Math.round(total) : null;
}

function attachSources(cases, cwd, repoRoot, noSources) {
  const sourceByPath = new Map();
  const preparedCases = cases.map((item) => {
    if (!item.file) {
      return { ...item, source_sha: null };
    }

    const absolutePath = sourcePathFor(item.file, cwd, repoRoot, !noSources);
    const file = repoRelativePath(absolutePath, repoRoot);
    let source = sourceByPath.get(absolutePath);
    if (!noSources && !source) {
      const bodyBytes = readFileSync(absolutePath);
      source = {
        source_sha: createHash('sha256').update(bodyBytes).digest('hex'),
        file,
        language: languageFor(file),
        body: bodyBytes.toString('utf8'),
        byte_size: bodyBytes.length,
      };
      sourceByPath.set(absolutePath, source);
    }

    return {
      suite: item.suite,
      name: item.name,
      file,
      status: item.status,
      duration_ms: item.duration_ms,
      failure_message: item.failure_message,
      failure_detail: item.failure_detail,
      source_sha: source?.source_sha ?? null,
      external_ref: null,
    };
  });

  return { cases: preparedCases, sources: noSources ? [] : [...sourceByPath.values()] };
}

async function ingest() {
  const options = parseArgs(process.argv.slice(2));
  const cwd = process.cwd();
  const xmlPath = resolve(cwd, options.junit);
  const xml = readFileSync(xmlPath, 'utf8');
  const parsed = parseJUnit(xml);
  if (parsed.errors.length > 0) throw new Error(`malformed JUnit report: ${parsed.errors[0]}`);

  const token = resolveApiToken();
  const project = await resolveProject(token, cwd, options.projectId);
  const repoRoot = repoRootFor(project, cwd);
  const gitCommit = gitValue(['HEAD'], cwd);
  const gitBranch = gitValue(['--abbrev-ref', 'HEAD'], cwd);
  const attached = attachSources(parsed.cases, cwd, repoRoot, options.noSources);
  const duration = reportDurationMs(xml, parsed.cases);

  const envelope = {
    title: options.title || `${options.kind} tests`,
    kind: options.kind,
    runner: options.runner,
    started_at: null,
    finished_at: null,
    duration_ms: duration,
    commit_sha: gitCommit,
    branch: gitBranch,
    event_id: null,
    task_id: null,
    external_ref: null,
    cases: attached.cases,
    metrics: [],
    sources: attached.sources,
  };

  await requestJson(`${apiBase()}/projects/${encodeURIComponent(project.id)}/qa/ingest`, token, {
    method: 'POST',
    body: JSON.stringify(envelope),
  });
}

function skippedReason(error) {
  const message = error instanceof Error ? error.message : String(error);
  return (message.replace(/\s+/gu, ' ').trim() || 'unknown error').slice(0, 500);
}

try {
  await ingest();
} catch (error) {
  console.error(`qa-ingest: skipped (${skippedReason(error)})`);
}
