//! Local, read-only scan of a project's `docs/design/` folder (plus a shallow scan for stray
//! `.pen` files elsewhere under the project root). Used by the Design tab to list/locate design
//! assets — including Pencil (`.pen`) files — without ever opening or parsing them.

use serde::Serialize;
use std::path::{Path, PathBuf};
use std::time::UNIX_EPOCH;

/// Directory names skipped while walking for stray `.pen` files outside `docs/design/`.
const SKIP_DIRS: &[&str] = &["node_modules", ".git", "target", "build", "dist"];

/// Maximum depth (relative to the project root) walked when looking for stray `.pen` files.
const MAX_SCAN_DEPTH: usize = 3;

/// Hard cap on the number of entries returned, so a huge tree can't blow up the response.
const MAX_ENTRIES: usize = 100;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum AssetKind {
    Pen,
    Markdown,
    Other,
}

#[derive(Debug, Clone, Serialize)]
pub struct DesignAssetEntry {
    pub name: String,
    pub relative_path: String,
    pub absolute_path: String,
    pub kind: AssetKind,
    pub size: u64,
    /// Last-modified time as a Unix timestamp (seconds), if the filesystem reports one.
    pub modified: Option<i64>,
}

#[derive(Debug, Clone, Serialize)]
pub struct DesignAssets {
    pub docs_dir_exists: bool,
    pub docs_dir: String,
    pub entries: Vec<DesignAssetEntry>,
}

/// Classifies a file by its extension. Exposed for testing and for anyone extending the kind
/// list later.
pub fn classify(name: &str) -> AssetKind {
    let ext = Path::new(name)
        .extension()
        .and_then(|e| e.to_str())
        .map(|e| e.to_lowercase());
    match ext.as_deref() {
        Some("pen") => AssetKind::Pen,
        Some("md") | Some("markdown") => AssetKind::Markdown,
        _ => AssetKind::Other,
    }
}

/// Resolves `subpath` against `root` and guarantees the result stays inside `root` — rejects
/// `..` escapes and symlink escapes. Mirrors `git_browser::resolve_subpath`'s guard logic (that
/// function is git_browser-private and additionally requires the target to be a directory, so
/// this is a standalone copy rather than a call-through).
fn resolve_subpath(root: &Path, subpath: &str) -> anyhow::Result<PathBuf> {
    let candidate = if subpath.trim().is_empty() {
        root.to_path_buf()
    } else {
        root.join(subpath.trim_start_matches('/'))
    };

    let resolved = std::fs::canonicalize(&candidate)
        .map_err(|e| anyhow::anyhow!("path does not exist: {} ({e})", candidate.display()))?;
    let root_canonical = std::fs::canonicalize(root)
        .map_err(|e| anyhow::anyhow!("project root does not exist: {} ({e})", root.display()))?;

    if !resolved.starts_with(&root_canonical) {
        anyhow::bail!("path escapes the project root");
    }
    Ok(resolved)
}

fn entry_for(root_canonical: &Path, path: &Path) -> Option<DesignAssetEntry> {
    let metadata = std::fs::metadata(path).ok()?;
    if !metadata.is_file() {
        return None;
    }
    let name = path.file_name()?.to_string_lossy().to_string();
    let relative_path = path
        .strip_prefix(root_canonical)
        .unwrap_or(path)
        .to_string_lossy()
        .replace('\\', "/");
    let modified = metadata
        .modified()
        .ok()
        .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
        .map(|d| d.as_secs() as i64);

    Some(DesignAssetEntry {
        name: name.clone(),
        relative_path,
        absolute_path: path.to_string_lossy().to_string(),
        kind: classify(&name),
        size: metadata.len(),
        modified,
    })
}

/// Walks `dir`, collecting every file directly inside `docs/design/` (no depth limit — it's a
/// dedicated design folder, expected to be shallow and hand-curated).
fn collect_docs_design(root_canonical: &Path, dir: &Path, out: &mut Vec<DesignAssetEntry>) {
    let Ok(read_dir) = std::fs::read_dir(dir) else { return };
    let mut children: Vec<_> = read_dir.filter_map(|e| e.ok()).collect();
    children.sort_by_key(|e| e.file_name());

    for entry in children {
        if out.len() >= MAX_ENTRIES {
            return;
        }
        let path = entry.path();
        let file_type = match entry.file_type() {
            Ok(t) => t,
            Err(_) => continue,
        };
        if file_type.is_dir() {
            let name = entry.file_name().to_string_lossy().to_string();
            if SKIP_DIRS.contains(&name.as_str()) {
                continue;
            }
            collect_docs_design(root_canonical, &path, out);
        } else if let Some(item) = entry_for(root_canonical, &path) {
            out.push(item);
        }
    }
}

/// Depth-limited walk of `dir` (relative depth `depth`, 0 at `root`) collecting stray `.pen`
/// files outside `docs/design/` — e.g. a design file living next to the code it describes.
fn collect_stray_pen(root_canonical: &Path, dir: &Path, depth: usize, out: &mut Vec<DesignAssetEntry>) {
    if depth > MAX_SCAN_DEPTH || out.len() >= MAX_ENTRIES {
        return;
    }
    let Ok(read_dir) = std::fs::read_dir(dir) else { return };
    for entry in read_dir.filter_map(|e| e.ok()) {
        if out.len() >= MAX_ENTRIES {
            return;
        }
        let path = entry.path();
        let file_type = match entry.file_type() {
            Ok(t) => t,
            Err(_) => continue,
        };
        let name = entry.file_name().to_string_lossy().to_string();
        if file_type.is_dir() {
            if SKIP_DIRS.contains(&name.as_str()) || name == "design" {
                // "design" under docs/ is already covered by collect_docs_design; skip it here
                // to avoid duplicate entries when docs/design/ itself is within scan depth.
                if path.file_name().and_then(|n| n.to_str()) == Some("design")
                    && path.parent().and_then(|p| p.file_name()).and_then(|n| n.to_str()) == Some("docs")
                {
                    continue;
                }
                if SKIP_DIRS.contains(&name.as_str()) {
                    continue;
                }
            }
            collect_stray_pen(root_canonical, &path, depth + 1, out);
        } else if classify(&name) == AssetKind::Pen {
            if let Some(item) = entry_for(root_canonical, &path) {
                out.push(item);
            }
        }
    }
}

/// Scans `root` (a project's registered filesystem path) for design assets: everything under
/// `docs/design/` if it exists, plus a depth-limited scan for stray `.pen` files elsewhere.
/// Never fails the caller — an unreadable/missing folder just yields an empty result.
pub fn scan(root: &Path) -> DesignAssets {
    let root_canonical = match std::fs::canonicalize(root) {
        Ok(p) => p,
        Err(_) => {
            return DesignAssets { docs_dir_exists: false, docs_dir: String::new(), entries: Vec::new() };
        }
    };

    let docs_dir_path = match resolve_subpath(&root_canonical, "docs/design") {
        Ok(p) if p.is_dir() => Some(p),
        _ => None,
    };

    let mut entries = Vec::new();
    let docs_dir_exists = docs_dir_path.is_some();
    let docs_dir = docs_dir_path
        .as_ref()
        .map(|p| p.to_string_lossy().to_string())
        .unwrap_or_default();

    if let Some(ref dir) = docs_dir_path {
        collect_docs_design(&root_canonical, dir, &mut entries);
    }
    collect_stray_pen(&root_canonical, &root_canonical, 0, &mut entries);

    entries.truncate(MAX_ENTRIES);

    DesignAssets { docs_dir_exists, docs_dir, entries }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn classifies_pen_markdown_and_other() {
        assert_eq!(classify("ui.pen"), AssetKind::Pen);
        assert_eq!(classify("UI.PEN"), AssetKind::Pen);
        assert_eq!(classify("README.md"), AssetKind::Markdown);
        assert_eq!(classify("notes.markdown"), AssetKind::Markdown);
        assert_eq!(classify("diagram.png"), AssetKind::Other);
        assert_eq!(classify("noext"), AssetKind::Other);
    }

    #[test]
    fn resolve_subpath_rejects_path_escape() {
        let tmp = std::env::temp_dir().join(format!("design_assets_test_{}", std::process::id()));
        let root = tmp.join("root");
        let outside = tmp.join("outside");
        std::fs::create_dir_all(&root).unwrap();
        std::fs::create_dir_all(&outside).unwrap();

        // A symlink inside root that points outside root must not be treated as in-bounds.
        let link = root.join("escape");
        #[cfg(unix)]
        {
            std::os::unix::fs::symlink(&outside, &link).unwrap();
            let result = resolve_subpath(&root, "escape");
            assert!(result.is_err(), "symlink escape should be rejected, got {result:?}");
        }

        let result = resolve_subpath(&root, "../outside");
        assert!(result.is_err(), "`..` escape should be rejected, got {result:?}");

        std::fs::remove_dir_all(&tmp).ok();
    }

    #[test]
    fn scan_missing_docs_dir_returns_empty_without_error() {
        let tmp = std::env::temp_dir().join(format!("design_assets_scan_test_{}", std::process::id()));
        std::fs::create_dir_all(&tmp).unwrap();

        let result = scan(&tmp);
        assert!(!result.docs_dir_exists);
        assert!(result.entries.is_empty());

        std::fs::remove_dir_all(&tmp).ok();
    }

    #[test]
    fn scan_finds_pen_file_under_docs_design() {
        let tmp = std::env::temp_dir().join(format!("design_assets_scan_pen_{}", std::process::id()));
        let docs_design = tmp.join("docs").join("design");
        std::fs::create_dir_all(&docs_design).unwrap();
        std::fs::write(docs_design.join("ui.pen"), b"encrypted-bytes").unwrap();
        std::fs::write(docs_design.join("README.md"), b"# design docs").unwrap();

        let result = scan(&tmp);
        assert!(result.docs_dir_exists);
        assert_eq!(result.entries.len(), 2);
        let pen = result.entries.iter().find(|e| e.name == "ui.pen").unwrap();
        assert_eq!(pen.kind, AssetKind::Pen);
        assert!(pen.absolute_path.ends_with("docs/design/ui.pen"));

        std::fs::remove_dir_all(&tmp).ok();
    }
}
