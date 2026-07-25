//! Local, read-only git browsing for a project's folder: a GitHub-style file/folder table
//! with last-commit info, and the raw commit graph (hash/parents/refs) for a Sourcetree-style
//! DAG view. Shells out to `git` the same way `indexer::collect_git_history` does — including
//! the `safe.directory` override, since indexed folders are often owned by another user/container.

use anyhow::{bail, Context, Result};
use serde::Serialize;
use std::path::{Path, PathBuf};

/// Returns true if `canonical_path` looks like the root of a git working tree.
pub fn has_git_repo(canonical_path: &Path) -> bool {
    canonical_path.join(".git").exists()
}

#[derive(Debug, Clone, Serialize)]
pub struct LastCommit {
    pub hash: String,
    pub author: String,
    pub date: String,
    pub subject: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct FileEntry {
    pub name: String,
    pub is_dir: bool,
    pub last_commit: Option<LastCommit>,
}

#[derive(Debug, Clone, Serialize)]
pub struct CommitNode {
    pub hash: String,
    pub short_hash: String,
    pub parents: Vec<String>,
    pub author: String,
    pub date: String,
    pub subject: String,
    pub refs: Vec<String>,
}

fn git_command(repo_root: &Path) -> std::process::Command {
    let mut cmd = std::process::Command::new("git");
    cmd.arg("-C")
        .arg(repo_root)
        .arg("-c")
        .arg(format!("safe.directory={}", repo_root.display()));
    cmd
}

/// Resolves `subpath` (as given by a client, e.g. `"src/components"`) against `repo_root` and
/// guarantees the result stays inside `repo_root` — rejects `..` escapes and symlink escapes.
fn resolve_subpath(repo_root: &Path, subpath: &str) -> Result<PathBuf> {
    let candidate = if subpath.trim().is_empty() {
        repo_root.to_path_buf()
    } else {
        repo_root.join(subpath.trim_start_matches('/'))
    };

    let resolved = std::fs::canonicalize(&candidate)
        .with_context(|| format!("path does not exist: {}", candidate.display()))?;
    let repo_root_canonical = std::fs::canonicalize(repo_root)
        .with_context(|| format!("repo root does not exist: {}", repo_root.display()))?;

    if !resolved.starts_with(&repo_root_canonical) {
        bail!("path escapes the project root");
    }
    if !resolved.is_dir() {
        bail!("path is not a directory");
    }
    Ok(resolved)
}

/// Last commit that touched `relative_path` (relative to `repo_root`), if any.
fn last_commit_for(repo_root: &Path, relative_path: &str) -> Option<LastCommit> {
    let output = git_command(repo_root)
        .args(["log", "-1", "--format=%h%x00%an%x00%aI%x00%s", "--", relative_path])
        .output()
        .ok()?;
    if !output.status.success() {
        return None;
    }
    let stdout = String::from_utf8_lossy(&output.stdout);
    let line = stdout.trim();
    if line.is_empty() {
        return None;
    }
    let mut parts = line.splitn(4, '\x00');
    let (hash, author, date, subject) = (parts.next()?, parts.next()?, parts.next()?, parts.next()?);
    Some(LastCommit {
        hash: hash.to_string(),
        author: author.to_string(),
        date: date.to_string(),
        subject: subject.to_string(),
    })
}

/// Lists `subpath` within `repo_root`, directories first then files, each annotated with the
/// last commit that touched it. One `git log` subprocess per entry — acceptable for the folder
/// sizes this browses; not worth a caching layer for an MVP.
pub fn list_directory(repo_root: &Path, subpath: &str) -> Result<Vec<FileEntry>> {
    let dir = resolve_subpath(repo_root, subpath)?;
    let repo_root_canonical = std::fs::canonicalize(repo_root)?;

    let mut dirs = Vec::new();
    let mut files = Vec::new();
    for entry in std::fs::read_dir(&dir)? {
        let entry = entry?;
        let name = entry.file_name().to_string_lossy().to_string();
        if name == ".git" {
            continue;
        }
        let is_dir = entry.file_type().map(|t| t.is_dir()).unwrap_or(false);
        let full_path = dir.join(&name);
        let relative_path = full_path
            .strip_prefix(&repo_root_canonical)
            .unwrap_or(&full_path)
            .to_string_lossy()
            .replace('\\', "/");
        let last_commit = last_commit_for(repo_root, &relative_path);
        let item = FileEntry { name, is_dir, last_commit };
        if is_dir { dirs.push(item) } else { files.push(item) }
    }

    dirs.sort_by(|a, b| a.name.to_lowercase().cmp(&b.name.to_lowercase()));
    files.sort_by(|a, b| a.name.to_lowercase().cmp(&b.name.to_lowercase()));
    dirs.extend(files);
    Ok(dirs)
}

/// The last `limit` commits across all branches, with parent hashes (for merge edges) and ref
/// decorations (branch/tag names), for rendering a commit graph. Never fails the caller on a
/// git error — an empty history is preferable to a broken page.
pub fn commit_graph(repo_root: &Path, limit: usize) -> Vec<CommitNode> {
    let output = git_command(repo_root)
        .args([
            "log",
            "--all",
            "-n",
            &limit.to_string(),
            "--pretty=format:%x01%H%x00%h%x00%P%x00%an%x00%aI%x00%s%x00%D",
        ])
        .output();

    let output = match output {
        Ok(o) if o.status.success() => o,
        _ => return Vec::new(),
    };

    let stdout = String::from_utf8_lossy(&output.stdout);
    let mut commits = Vec::new();
    for record in stdout.split('\x01').skip(1) {
        let mut parts = record.splitn(6, '\x00');
        let (hash, short_hash, parents, author, date, rest) = match (
            parts.next(), parts.next(), parts.next(), parts.next(), parts.next(), parts.next(),
        ) {
            (Some(h), Some(sh), Some(p), Some(a), Some(d), Some(r)) => (h, sh, p, a, d, r),
            _ => continue,
        };
        // `rest` is "subject%x00refs" but subject may itself be empty; split on the last \0.
        let (subject, refs) = match rest.rsplit_once('\x00') {
            Some((s, r)) => (s, r),
            None => (rest, ""),
        };
        let parents: Vec<String> = parents.split(' ').filter(|s| !s.is_empty()).map(|s| s.to_string()).collect();
        let refs: Vec<String> = refs
            .split(", ")
            .map(|s| s.trim())
            .filter(|s| !s.is_empty())
            .map(|s| s.trim_start_matches("HEAD -> ").to_string())
            .collect();

        commits.push(CommitNode {
            hash: hash.to_string(),
            short_hash: short_hash.to_string(),
            parents,
            author: author.to_string(),
            date: date.to_string(),
            subject: subject.trim().to_string(),
            refs,
        });
    }
    commits
}
