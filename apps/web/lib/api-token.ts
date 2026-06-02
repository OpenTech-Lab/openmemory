import { readFileSync } from 'fs';
import { homedir } from 'os';
import path from 'path';

/**
 * Resolves the API token using the same priority order as the Rust server:
 * 1. OPENMEMORY_API_TOKEN env var (Docker, CI, explicit override)
 * 2. ~/.openmemory/api_token file (default for local dev)
 * 3. Hardcoded fallback (only if neither source exists)
 */
export function resolveApiToken(): string {
  if (process.env.OPENMEMORY_API_TOKEN) return process.env.OPENMEMORY_API_TOKEN;
  try {
    return readFileSync(path.join(homedir(), '.openmemory', 'api_token'), 'utf-8').trim();
  } catch {
    return 'dev-token-change-me';
  }
}
