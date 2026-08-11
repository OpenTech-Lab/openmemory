//! Local, read-only git browsing for a project's folder: a GitHub-style file/folder table
//! with last-commit info, and the raw commit graph (hash/parents/refs) for a Sourcetree-style
//! DAG view. Shells out to `git` the same way `indexer::collect_git_history` does — including
//! the `safe.directory` override, since indexed folders are often owned by another user/container.

use anyhow::{bail, Context, Result};
use serde::Serialize;
use std::collections::HashMap;
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

#[derive(Debug, Clone, Serialize)]
pub struct ChangedFile {
    pub path: String,
    pub status: String,
    pub index_status: String,
    pub worktree_status: String,
    pub additions: usize,
    pub deletions: usize,
    pub is_untracked: bool,
}

#[derive(Debug, Clone, Serialize)]
pub struct WorkingTreeChanges {
    pub branch: String,
    pub files: Vec<ChangedFile>,
    /// The diff is used by the server-side AI suggestion flow, but is deliberately not exposed
    /// through the changes endpoint. A commit-message request should be the only path that sends
    /// project source to the configured LLM.
    #[serde(skip_serializing)]
    pub diff: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct CommitPushResult {
    pub branch: String,
    pub commit_hash: String,
    pub pushed: bool,
    pub push_error: Option<String>,
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

fn branch_name(repo_root: &Path) -> String {
    let output = git_command(repo_root)
        .args(["branch", "--show-current"])
        .output();
    if let Ok(output) = output {
        let branch = String::from_utf8_lossy(&output.stdout).trim().to_string();
        if !branch.is_empty() {
            return branch;
        }
    }

    let output = git_command(repo_root)
        .args(["rev-parse", "--short", "HEAD"])
        .output();
    match output {
        Ok(output) if output.status.success() => {
            let hash = String::from_utf8_lossy(&output.stdout).trim().to_string();
            if !hash.is_empty() { format!("detached at {hash}") } else { "detached HEAD".to_string() }
        }
        _ => "detached HEAD".to_string(),
    }
}

fn parse_numstat(output: &[u8]) -> HashMap<String, (usize, usize)> {
    let mut stats = HashMap::new();
    for line in String::from_utf8_lossy(output).lines() {
        let mut parts = line.split('\t');
        let additions = parts.next().and_then(|value| value.parse::<usize>().ok()).unwrap_or(0);
        let deletions = parts.next().and_then(|value| value.parse::<usize>().ok()).unwrap_or(0);
        let Some(path) = parts.next() else { continue };
        stats.insert(path.to_string(), (additions, deletions));
    }
    stats
}

fn diff_numstat(repo_root: &Path) -> HashMap<String, (usize, usize)> {
    let output = git_command(repo_root)
        .args(["diff", "--no-ext-diff", "--no-renames", "--numstat", "HEAD", "--"])
        .output();
    if let Ok(output) = output {
        if output.status.success() {
            return parse_numstat(&output.stdout);
        }
    }

    // An unborn repository has no HEAD. Combine the staged and unstaged views in that case.
    let mut stats = HashMap::new();
    for args in [
        ["diff", "--no-ext-diff", "--no-renames", "--numstat", "--"].as_slice(),
        ["diff", "--cached", "--no-ext-diff", "--no-renames", "--numstat", "--"].as_slice(),
    ] {
        if let Ok(output) = git_command(repo_root).args(args).output() {
            for (path, (additions, deletions)) in parse_numstat(&output.stdout) {
                let entry = stats.entry(path).or_insert((0, 0));
                entry.0 += additions;
                entry.1 += deletions;
            }
        }
    }
    stats
}

fn append_capped(target: &mut String, text: &str, max_bytes: usize) {
    if target.len() >= max_bytes { return; }
    let remaining = max_bytes - target.len();
    if text.len() <= remaining {
        target.push_str(text);
        return;
    }
    let mut end = remaining;
    while end > 0 && !text.is_char_boundary(end) { end -= 1; }
    target.push_str(&text[..end]);
    target.push_str("\n[diff truncated]\n");
}

fn working_tree_diff(repo_root: &Path, files: &[ChangedFile]) -> String {
    const MAX_DIFF_BYTES: usize = 60_000;
    let mut diff = String::new();

    let tracked = git_command(repo_root)
        .args(["diff", "--no-ext-diff", "--no-renames", "--unified=3", "HEAD", "--"])
        .output();
    if let Ok(output) = tracked {
        if output.status.success() {
            append_capped(&mut diff, &String::from_utf8_lossy(&output.stdout), MAX_DIFF_BYTES);
        } else {
            for args in [
                ["diff", "--no-ext-diff", "--no-renames", "--unified=3", "--"].as_slice(),
                ["diff", "--cached", "--no-ext-diff", "--no-renames", "--unified=3", "--"].as_slice(),
            ] {
                if let Ok(output) = git_command(repo_root).args(args).output() {
                    append_capped(&mut diff, &String::from_utf8_lossy(&output.stdout), MAX_DIFF_BYTES);
                }
            }
        }
    }

    for file in files.iter().filter(|file| file.is_untracked) {
        let full_path = repo_root.join(&file.path);
        let Ok(bytes) = std::fs::read(&full_path) else {
            append_capped(&mut diff, &format!("\n[untracked file unavailable: {}]\n", file.path), MAX_DIFF_BYTES);
            continue;
        };
        let Ok(contents) = String::from_utf8(bytes) else {
            append_capped(&mut diff, &format!("\n[untracked binary file: {}]\n", file.path), MAX_DIFF_BYTES);
            continue;
        };
        let mut synthetic = format!("diff --git a/{0} b/{0}\nnew file mode 100644\n--- /dev/null\n+++ b/{0}\n@@ -0,0 +1,", file.path);
        let line_count = contents.lines().count().max(1);
        synthetic.push_str(&format!("{line_count} @@\n"));
        for line in contents.lines() {
            synthetic.push('+');
            synthetic.push_str(line);
            synthetic.push('\n');
        }
        append_capped(&mut diff, &synthetic, MAX_DIFF_BYTES);
    }

    diff
}

/// Returns the current working-tree changes, including tracked, staged, deleted, and untracked
/// files. This is intentionally read-only and uses porcelain output so the UI can mirror a
/// Source Control panel without asking the client to provide filesystem paths.
pub fn working_tree_changes(repo_root: &Path) -> Result<WorkingTreeChanges> {
    let output = git_command(repo_root)
        .args(["status", "--short", "--untracked-files=all", "--no-renames"])
        .output()
        .context("failed to read git status")?;
    if !output.status.success() {
        bail!("git status failed: {}", String::from_utf8_lossy(&output.stderr).trim());
    }

    let stats = diff_numstat(repo_root);
    let mut files = Vec::new();
    for line in String::from_utf8_lossy(&output.stdout).lines() {
        if line.len() < 3 { continue; }
        let status = line[..2].to_string();
        let path = line[3..].trim().to_string();
        if path.is_empty() { continue; }
        let (additions, deletions) = stats.get(&path).copied().unwrap_or((0, 0));
        files.push(ChangedFile {
            index_status: status[..1].to_string(),
            worktree_status: status[1..].to_string(),
            is_untracked: status == "??",
            status,
            path,
            additions,
            deletions,
        });
    }

    let diff = working_tree_diff(repo_root, &files);
    Ok(WorkingTreeChanges { branch: branch_name(repo_root), files, diff })
}

/// Stage all working-tree changes, create a commit, and push the current branch.
///
/// The project root comes from the server-side project registry; callers never provide a
/// filesystem path. Push failures are returned as a partial result because the local commit
/// may already exist and should be reported accurately to the UI.
pub fn commit_and_push(repo_root: &Path, message: &str) -> Result<CommitPushResult> {
    let message = message.trim();
    if message.is_empty() {
        bail!("commit message must not be empty");
    }
    if message.chars().count() > 2_000 {
        bail!("commit message must be 2,000 characters or fewer");
    }
    if !has_git_repo(repo_root) {
        bail!("not_a_git_repo");
    }

    let branch = branch_name(repo_root);

    let staged = git_command(repo_root)
        .args(["add", "--all"])
        .output()
        .context("failed to stage working-tree changes")?;
    if !staged.status.success() {
        bail!("git add failed");
    }

    let committed = git_command(repo_root)
        .arg("commit")
        .arg(format!("--message={message}"))
        .output()
        .context("failed to create git commit")?;
    let commit_hash = if committed.status.success() {
        let hash_output = git_command(repo_root)
            .args(["rev-parse", "HEAD"])
            .output()
            .context("failed to read created commit hash")?;
        if !hash_output.status.success() {
            bail!("commit created, but its hash could not be read");
        }
        String::from_utf8_lossy(&hash_output.stdout).trim().to_string()
    } else {
        let output = format!(
            "{}\n{}",
            String::from_utf8_lossy(&committed.stdout),
            String::from_utf8_lossy(&committed.stderr)
        );
        if !output.contains("nothing to commit") {
            bail!("git commit failed");
        }
        // A previous click may have created the commit even though its push failed.
        // Allow the same UI action to retry that push without creating a new commit.
        let hash_output = git_command(repo_root)
            .args(["rev-parse", "HEAD"])
            .output()
            .context("failed to read existing commit hash")?;
        if !hash_output.status.success() {
            bail!("no changes to commit");
        }
        String::from_utf8_lossy(&hash_output.stdout).trim().to_string()
    };

    let pushed = git_command(repo_root)
        .arg("push")
        .output()
        .context("failed to run git push")?;
    if !pushed.status.success() {
        return Ok(CommitPushResult {
            branch,
            commit_hash,
            pushed: false,
            push_error: Some("Commit created locally, but pushing the branch failed.".to_string()),
        });
    }

    Ok(CommitPushResult {
        branch,
        commit_hash,
        pushed: true,
        push_error: None,
    })
}
