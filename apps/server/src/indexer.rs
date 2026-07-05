//! Self-contained repository indexer: walks a project directory, parses source files with
//! tree-sitter, and builds a NetworkX-node-link-compatible graph (same JSON shape the old
//! `/graphify` external tool produced) — no external tool or `graph.json` file required.
//!
//! Scope (see plan for the full rationale): real AST parsing for Rust/TypeScript/TSX/
//! JavaScript/Python; other recognized file types get a plain File node (no parsing).
//! `calls` edges are best-effort name matching against project-wide definitions, not full
//! type-resolved symbol resolution. `community` is derived from top-level directory
//! grouping, not real graph-modularity community detection.

use anyhow::{Context, Result};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::collections::{HashMap, HashSet};
use std::path::Path;
use tree_sitter::{Language, Parser, Query, QueryCursor};

/// Skip individual files above this size — avoids parsing generated/vendored giants.
const MAX_FILE_BYTES: u64 = 2 * 1024 * 1024;
/// Safety ceiling on total nodes — mirrors the FalkorDB supernode-cap lesson: cap first,
/// don't discover the failure mode in production.
const MAX_NODES: usize = 200_000;

const SENSITIVE_DIR_NAMES: &[&str] = &[
    ".ssh", ".gnupg", ".aws", ".gcloud", "secrets", ".secrets", "credentials",
];
const SENSITIVE_FILE_STEMS: &[&str] = &["id_rsa", "id_dsa", "id_ecdsa", "id_ed25519"];
const SENSITIVE_EXTENSIONS: &[&str] = &["pem", "key", "p12", "pfx"];

const EXTRA_IGNORE_DIRS: &[&str] = &[
    "target", "node_modules", ".git", "dist", "build", "__pycache__", ".venv", "venv",
];

/// Default number of recent commits to index as graph nodes. Overridable via
/// `OPENMEMORY_GIT_HISTORY_COMMITS` env var; `0` disables the feature entirely.
const DEFAULT_GIT_HISTORY_COMMITS: usize = 200;

#[derive(Clone, Copy)]
enum Lang {
    Rust,
    TypeScript,
    Tsx,
    JavaScript,
    Python,
}

struct FileClass {
    file_type: &'static str,
    language: Option<Lang>,
}

fn classify_extension(ext: &str) -> Option<FileClass> {
    Some(match ext {
        "rs" => FileClass { file_type: "code", language: Some(Lang::Rust) },
        "ts" => FileClass { file_type: "code", language: Some(Lang::TypeScript) },
        "tsx" => FileClass { file_type: "code", language: Some(Lang::Tsx) },
        "js" | "jsx" | "mjs" | "cjs" => FileClass { file_type: "code", language: Some(Lang::JavaScript) },
        "py" => FileClass { file_type: "code", language: Some(Lang::Python) },
        "go" | "java" | "cpp" | "cc" | "c" | "h" | "hpp" | "rb" | "swift" | "kt" | "cs" | "php"
        | "lua" | "zig" | "sh" | "bash" | "json" | "toml" | "yaml" | "yml" =>
            FileClass { file_type: "code", language: None },
        "md" | "mdx" | "txt" | "rst" | "html" => FileClass { file_type: "document", language: None },
        "pdf" => FileClass { file_type: "paper", language: None },
        "png" | "jpg" | "jpeg" | "gif" | "webp" | "svg" => FileClass { file_type: "image", language: None },
        "mp4" | "mov" | "webm" | "mp3" => FileClass { file_type: "video", language: None },
        _ => return None,
    })
}

fn is_sensitive_path(rel: &str, file_stem: &str, ext: &str) -> bool {
    let lower = rel.to_lowercase();
    if SENSITIVE_DIR_NAMES.iter().any(|d| lower.split('/').any(|seg| seg == *d)) {
        return true;
    }
    if SENSITIVE_FILE_STEMS.contains(&file_stem) {
        return true;
    }
    if SENSITIVE_EXTENSIONS.contains(&ext) {
        return true;
    }
    if lower.contains("secret") || lower.contains("credential") || lower.contains("password") {
        return true;
    }
    false
}

struct Definition {
    id: String,
    name: String,
    line: usize,
    end_line: usize,
}

struct RawImport {
    from_file: String,
    // Candidate relative-path targets to try resolving against the actual file set,
    // in preference order.
    candidates: Vec<String>,
}

struct RawCall {
    from_id: String,
    callee_name: String,
}

/// A call site's line, resolved after all of a file's definitions are known — attributed to
/// its innermost enclosing definition (by smallest containing line range), or the bare file
/// when no definition contains it (e.g. top-level/module-scope code).
struct PendingCallSite {
    line: usize,
    callee_name: String,
}

struct ParseResult {
    definitions: Vec<Definition>,
    imports: Vec<RawImport>,
    calls: Vec<RawCall>,
}

fn ts_language(lang: Lang) -> Language {
    match lang {
        Lang::Rust => tree_sitter_rust::language(),
        Lang::TypeScript => tree_sitter_typescript::language_typescript(),
        Lang::Tsx => tree_sitter_typescript::language_tsx(),
        Lang::JavaScript => tree_sitter_javascript::language(),
        Lang::Python => tree_sitter_python::language(),
    }
}

// Adapted from each grammar's bundled queries/tags.scm (dropping doc-comment association
// predicates, which we don't need).
fn extraction_query_source(lang: Lang) -> &'static str {
    match lang {
        Lang::Rust => {
            r#"
            (struct_item name: (type_identifier) @def.name) @def.struct
            (enum_item name: (type_identifier) @def.name) @def.enum
            (trait_item name: (type_identifier) @def.name) @def.interface
            (declaration_list (function_item name: (identifier) @def.name) @def.method)
            (function_item name: (identifier) @def.name) @def.function
            (mod_item name: (identifier) @import.mod !body)
            (call_expression function: (identifier) @call.name)
            (call_expression function: (field_expression field: (field_identifier) @call.name))
            "#
        }
        Lang::TypeScript | Lang::Tsx => {
            r#"
            (interface_declaration name: (type_identifier) @def.name) @def.interface
            (class_declaration name: (_) @def.name) @def.class
            (method_definition name: (property_identifier) @def.name) @def.method
            (function_declaration name: (identifier) @def.name) @def.function
            (import_statement source: (string) @import.path)
            (call_expression function: (identifier) @call.name)
            (call_expression function: (member_expression property: (property_identifier) @call.name))
            "#
        }
        Lang::JavaScript => {
            r#"
            (class_declaration name: (_) @def.name) @def.class
            (method_definition name: (property_identifier) @def.name) @def.method
            (function_declaration name: (identifier) @def.name) @def.function
            (import_statement source: (string) @import.path)
            (call_expression function: (identifier) @call.name)
            (call_expression function: (member_expression property: (property_identifier) @call.name))
            "#
        }
        Lang::Python => {
            r#"
            (class_definition name: (identifier) @def.name) @def.class
            (function_definition name: (identifier) @def.name) @def.function
            (import_statement name: (dotted_name) @import.path)
            (import_from_statement module_name: (dotted_name) @import.path)
            (call function: (identifier) @call.name)
            (call function: (attribute attribute: (identifier) @call.name))
            "#
        }
    }
}

fn def_kind_for_capture(name: &str) -> Option<&'static str> {
    match name {
        "def.function" => Some("function"),
        "def.method" => Some("method"),
        "def.class" => Some("class"),
        "def.struct" => Some("struct"),
        "def.enum" => Some("enum"),
        "def.interface" => Some("interface"),
        _ => None,
    }
}

fn parse_source(rel: &str, source: &str, lang: Lang) -> Result<ParseResult> {
    let language = ts_language(lang);
    let mut parser = Parser::new();
    parser.set_language(&language).context("failed to load grammar")?;
    let tree = parser.parse(source, None).context("tree-sitter failed to parse file")?;
    let query = Query::new(&language, extraction_query_source(lang)).context("invalid extraction query")?;
    let capture_names = query.capture_names();
    let bytes = source.as_bytes();

    let mut definitions: Vec<Definition> = Vec::new();
    let mut imports = Vec::new();
    let mut call_sites: Vec<PendingCallSite> = Vec::new();

    let mut cursor = QueryCursor::new();
    for m in cursor.matches(&query, tree.root_node(), bytes) {
        // Find the definition-kind capture (a whole-definition node) and its paired name
        // capture within the same match.
        let mut def_kind: Option<&'static str> = None;
        let mut def_start: usize = 0;
        let mut def_end: usize = 0;
        let mut name_text: Option<&str> = None;
        let mut import_text: Option<&str> = None;
        let mut call_text: Option<&str> = None;
        let mut call_line: usize = 0;
        let mut mod_no_body_name: Option<&str> = None;

        for cap in m.captures {
            let cap_name = capture_names[cap.index as usize];
            let text = cap.node.utf8_text(bytes).ok();
            match cap_name {
                "def.name" => name_text = text,
                "import.path" => import_text = text,
                "call.name" => {
                    call_text = text;
                    call_line = cap.node.start_position().row + 1;
                }
                "import.mod" => mod_no_body_name = text,
                other => {
                    if let Some(kind) = def_kind_for_capture(other) {
                        def_kind = Some(kind);
                        def_start = cap.node.start_position().row + 1;
                        def_end = cap.node.end_position().row + 1;
                    }
                }
            }
        }

        if let (Some(kind), Some(name)) = (def_kind, name_text) {
            definitions.push(Definition {
                id: format!("{rel}::{kind}:{name}@L{def_start}"),
                name: name.to_string(),
                line: def_start,
                end_line: def_end,
            });
        }
        if let Some(raw) = import_text {
            let cleaned = raw.trim_matches(|c| c == '"' || c == '\'' || c == '`');
            imports.push(RawImport {
                from_file: rel.to_string(),
                candidates: resolve_import_candidates(rel, cleaned, lang),
            });
        }
        if let Some(name) = mod_no_body_name {
            // `mod foo;` — maps to a sibling file `foo.rs` or `foo/mod.rs`.
            let dir = Path::new(rel).parent().unwrap_or_else(|| Path::new(""));
            imports.push(RawImport {
                from_file: rel.to_string(),
                candidates: vec![
                    join_rel(dir, &format!("{name}.rs")),
                    join_rel(dir, &format!("{name}/mod.rs")),
                ],
            });
        }
        if let Some(name) = call_text {
            call_sites.push(PendingCallSite { line: call_line, callee_name: name.to_string() });
        }
    }

    // Attribute each call site to its innermost enclosing definition (smallest containing
    // line range) rather than the bare file — falls back to the file when no definition
    // contains the call (e.g. top-level/module-scope code).
    let calls: Vec<RawCall> = call_sites
        .into_iter()
        .map(|site| {
            let enclosing = definitions
                .iter()
                .filter(|d| d.line <= site.line && site.line <= d.end_line)
                .min_by_key(|d| d.end_line.saturating_sub(d.line));
            let from_id = enclosing.map(|d| d.id.clone()).unwrap_or_else(|| rel.to_string());
            RawCall { from_id, callee_name: site.callee_name }
        })
        .collect();

    Ok(ParseResult { definitions, imports, calls })
}

fn join_rel(dir: &Path, name: &str) -> String {
    if dir.as_os_str().is_empty() {
        name.to_string()
    } else {
        format!("{}/{}", dir.to_string_lossy(), name)
    }
}

fn resolve_import_candidates(from_rel: &str, raw: &str, lang: Lang) -> Vec<String> {
    match lang {
        Lang::TypeScript | Lang::Tsx | Lang::JavaScript => {
            if !(raw.starts_with("./") || raw.starts_with("../")) {
                return vec![]; // bare specifier — external package, not resolvable in-project
            }
            let dir = Path::new(from_rel).parent().unwrap_or_else(|| Path::new(""));
            let joined = normalize_path(&dir.join(raw));
            let mut out = Vec::new();
            for ext in ["ts", "tsx", "js", "jsx"] {
                out.push(format!("{joined}.{ext}"));
            }
            for ext in ["ts", "tsx", "js", "jsx"] {
                out.push(format!("{joined}/index.{ext}"));
            }
            out.push(joined);
            out
        }
        Lang::Python => {
            let parts: Vec<&str> = raw.split('.').collect();
            let base = parts.join("/");
            vec![format!("{base}.py"), format!("{base}/__init__.py")]
        }
        Lang::Rust => vec![],
    }
}

fn normalize_path(p: &Path) -> String {
    let mut out: Vec<String> = Vec::new();
    for comp in p.components() {
        match comp {
            std::path::Component::ParentDir => { out.pop(); }
            std::path::Component::CurDir => {}
            std::path::Component::Normal(s) => out.push(s.to_string_lossy().to_string()),
            _ => {}
        }
    }
    out.join("/")
}

/// Read recent git commit history from `repo_root` and turn it into commit nodes plus
/// `modified` edges pointing at file nodes already discovered in this index run. Never
/// fails the caller — any git error (not a repo, git missing, unparseable output) yields
/// an empty history, since a stale/absent history is far less harmful than a broken index.
fn collect_git_history(repo_root: &Path, node_ids: &HashSet<String>) -> (Vec<Value>, Vec<Value>) {
    let max_commits: usize = std::env::var("OPENMEMORY_GIT_HISTORY_COMMITS")
        .ok()
        .and_then(|v| v.parse().ok())
        .unwrap_or(DEFAULT_GIT_HISTORY_COMMITS);
    if max_commits == 0 {
        return (Vec::new(), Vec::new());
    }

    // \x01 delimits commit records, \x00 delimits header fields within a record.
    // %h=abbrev hash, %an=author name, %aI=author date (ISO 8601), %s=subject.
    let output = std::process::Command::new("git")
        .arg("-C")
        .arg(repo_root)
        .arg("-c")
        .arg(format!("safe.directory={}", repo_root.display()))
        .args([
            "log",
            "-n",
            &max_commits.to_string(),
            "--pretty=format:%x01%h%x00%an%x00%aI%x00%s",
            "--name-only",
        ])
        .output();

    let output = match output {
        Ok(o) if o.status.success() => o,
        Ok(o) => {
            tracing::debug!(
                "indexer: git log exited non-zero (likely not a git repo): {}",
                String::from_utf8_lossy(&o.stderr)
            );
            return (Vec::new(), Vec::new());
        }
        Err(e) => {
            tracing::debug!("indexer: git log failed to run: {e}");
            return (Vec::new(), Vec::new());
        }
    };

    let stdout = String::from_utf8_lossy(&output.stdout);
    let mut nodes = Vec::new();
    let mut edges = Vec::new();
    let mut seen_commit_edges: HashSet<(String, String)> = HashSet::new();

    for record in stdout.split('\x01').skip(1) {
        let mut lines = record.lines();
        let header = match lines.next() {
            Some(h) => h,
            None => continue,
        };
        let mut parts = header.splitn(4, '\x00');
        let (hash, author, date, subject) = match (parts.next(), parts.next(), parts.next(), parts.next()) {
            (Some(h), Some(a), Some(d), Some(s)) => (h, a, d, s),
            _ => continue,
        };

        let commit_id = format!("commit:{hash}");
        let label: String = subject.chars().take(100).collect();
        nodes.push(json!({
            "id": commit_id,
            "label": label,
            "file_type": "commit",
            "author": author,
            "date": date,
        }));

        for file_line in lines {
            let file_line = file_line.trim();
            if file_line.is_empty() || !node_ids.contains(file_line) {
                continue;
            }
            let key = (commit_id.clone(), file_line.to_string());
            if seen_commit_edges.insert(key) {
                edges.push(json!({
                    "source": commit_id,
                    "target": file_line,
                    "relation": "modified",
                }));
            }
        }
    }

    (nodes, edges)
}

/// Walk `path`, parse recognized source files, and build a NetworkX node-link graph.
/// Returns `(graph_json, sha256_hex_hash, size_bytes, canonical_path)` — same signature as
/// the old `project_graphs::load_graph_json`, so call sites only swap which function they call.
pub async fn index_project(path: &str) -> Result<(Value, String, u64, String)> {
    let path = path.to_string();
    tokio::task::spawn_blocking(move || index_project_blocking(&path))
        .await
        .context("indexing task panicked")?
}

fn index_project_blocking(path: &str) -> Result<(Value, String, u64, String)> {
    let canonical = std::fs::canonicalize(path)
        .with_context(|| format!("Path does not exist or is not accessible: {path}"))?;
    if !canonical.is_dir() {
        anyhow::bail!("Path is not a directory: {}", canonical.display());
    }

    let mut nodes: Vec<Value> = Vec::new();
    let mut node_ids: HashSet<String> = HashSet::new();
    let mut edges: Vec<Value> = Vec::new();
    let mut defs_by_name: HashMap<String, Vec<String>> = HashMap::new();
    let mut pending_imports: Vec<RawImport> = Vec::new();
    let mut pending_calls: Vec<RawCall> = Vec::new();
    let mut truncated = false;

    let mut walker = ignore::WalkBuilder::new(&canonical);
    walker.hidden(true); // skip dotfiles/dirs (.git, .venv, etc.) by default
    // NOTE: WalkBuilder::filter_entry stores a single filter — registering it multiple
    // times overwrites rather than accumulates, so all excluded dir names are checked
    // together in one closure.
    walker.filter_entry(|entry| {
        entry
            .file_name()
            .to_str()
            .map(|n| !EXTRA_IGNORE_DIRS.contains(&n))
            .unwrap_or(true)
    });

    // Phase 1: walk + filter, collecting candidate files. Community ids are assigned from
    // the sorted set of directories afterward (not walk order, which the filesystem doesn't
    // guarantee is stable run-to-run) so re-indexing an unchanged tree yields the same hash.
    struct Candidate {
        rel: String,
        full_path: std::path::PathBuf,
        file_type: &'static str,
        language: Option<Lang>,
        parent_dir: String,
    }
    let mut candidates: Vec<Candidate> = Vec::new();
    let mut dirs: std::collections::BTreeSet<String> = std::collections::BTreeSet::new();

    for entry in walker.build() {
        if candidates.len() >= MAX_NODES {
            truncated = true;
            break;
        }
        let entry = match entry {
            Ok(e) => e,
            Err(_) => continue,
        };
        if entry.file_type().map(|t| !t.is_file()).unwrap_or(true) {
            continue;
        }

        let file_path = entry.path();
        let rel = match file_path.strip_prefix(&canonical) {
            Ok(r) => r.to_string_lossy().replace('\\', "/"),
            Err(_) => continue,
        };

        let ext = file_path
            .extension()
            .and_then(|e| e.to_str())
            .unwrap_or("")
            .to_lowercase();
        let stem = file_path
            .file_stem()
            .and_then(|s| s.to_str())
            .unwrap_or("")
            .to_lowercase();

        if is_sensitive_path(&rel, &stem, &ext) {
            continue;
        }
        let Some(class) = classify_extension(&ext) else { continue };

        let meta = match entry.metadata() {
            Ok(m) => m,
            Err(_) => continue,
        };
        if meta.len() > MAX_FILE_BYTES {
            continue;
        }

        // Full parent directory, not just the top-level segment — grouping by e.g. "apps"
        // alone collapses a whole monorepo into a handful of giant buckets. Per-directory
        // grouping keeps community aggregation meaningful at real project scale.
        let parent_dir = Path::new(&rel)
            .parent()
            .map(|p| p.to_string_lossy().to_string())
            .unwrap_or_default();
        dirs.insert(parent_dir.clone());

        candidates.push(Candidate {
            rel,
            full_path: file_path.to_path_buf(),
            file_type: class.file_type,
            language: class.language,
            parent_dir,
        });
    }

    let community_ids: HashMap<String, i64> = dirs
        .into_iter()
        .enumerate()
        .map(|(i, d)| (d, i as i64))
        .collect();

    // Phase 2: parse each candidate and build nodes/edges.
    for candidate in &candidates {
        let rel = &candidate.rel;
        let file_path = candidate.full_path.as_path();
        let community = *community_ids.get(&candidate.parent_dir).unwrap_or(&0);

        if node_ids.insert(rel.clone()) {
            let label = file_path.file_name().unwrap_or_default().to_string_lossy().to_string();
            nodes.push(json!({
                "id": rel,
                "label": label,
                "file_type": candidate.file_type,
                "community": community,
                "source_file": rel,
            }));
        }

        if let Some(lang) = candidate.language {
            let content = match std::fs::read_to_string(file_path) {
                Ok(c) => c,
                Err(_) => continue, // non-UTF8 or unreadable — skip parsing, keep the File node
            };
            match parse_source(rel, &content, lang) {
                Ok(result) => {
                    for def in result.definitions {
                        if node_ids.insert(def.id.clone()) {
                            nodes.push(json!({
                                "id": def.id,
                                "label": def.name,
                                "file_type": "code",
                                "community": community,
                                "source_file": rel,
                                "source_location": format!("L{}", def.line),
                            }));
                            edges.push(json!({
                                "source": rel,
                                "target": def.id,
                                "relation": "contains",
                            }));
                            defs_by_name.entry(def.name).or_default().push(def.id);
                        }
                    }
                    pending_imports.extend(result.imports);
                    pending_calls.extend(result.calls);
                }
                Err(e) => {
                    tracing::warn!("indexer: failed to parse {rel}: {e}");
                }
            }
        }
    }

    // Resolve imports now that the full file set is known.
    let mut seen_import_edges: HashSet<(String, String)> = HashSet::new();
    for imp in pending_imports {
        if let Some(target) = imp.candidates.iter().find(|c| node_ids.contains(*c)) {
            let key = (imp.from_file.clone(), target.clone());
            if imp.from_file != *target && seen_import_edges.insert(key) {
                edges.push(json!({
                    "source": imp.from_file,
                    "target": target,
                    "relation": "imports",
                }));
            }
        }
    }

    // Best-effort CALLS edges: only when the callee name matches exactly one definition
    // project-wide (ambiguous names are dropped rather than guessed).
    let mut seen_call_edges: HashSet<(String, String)> = HashSet::new();
    for call in pending_calls {
        if let Some(targets) = defs_by_name.get(&call.callee_name) {
            if targets.len() == 1 && targets[0] != call.from_id {
                let key = (call.from_id.clone(), targets[0].clone());
                if seen_call_edges.insert(key) {
                    edges.push(json!({
                        "source": call.from_id,
                        "target": targets[0],
                        "relation": "calls",
                    }));
                }
            }
        }
    }

    // Git history: commit nodes + `modified` edges to files already discovered above.
    // Only wires edges to files that exist in this index run — deleted/renamed-away
    // paths are silently dropped rather than creating dangling edges.
    let (history_nodes, history_edges) = collect_git_history(&canonical, &node_ids);
    nodes.extend(history_nodes);
    edges.extend(history_edges);

    // Deterministic ordering so re-indexing with no file changes yields the same hash.
    nodes.sort_by(|a, b| a["id"].as_str().unwrap_or("").cmp(b["id"].as_str().unwrap_or("")));
    edges.sort_by(|a, b| {
        let ak = (a["source"].as_str().unwrap_or(""), a["target"].as_str().unwrap_or(""), a["relation"].as_str().unwrap_or(""));
        let bk = (b["source"].as_str().unwrap_or(""), b["target"].as_str().unwrap_or(""), b["relation"].as_str().unwrap_or(""));
        ak.cmp(&bk)
    });

    let graph = json!({ "nodes": nodes, "links": edges, "truncated": truncated });
    let bytes = serde_json::to_vec(&graph).context("failed to serialize graph")?;
    let mut hasher = Sha256::new();
    hasher.update(&bytes);
    let hash = format!("{:x}", hasher.finalize());
    let size = bytes.len() as u64;

    Ok((graph, hash, size, canonical.to_string_lossy().to_string()))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    fn write(dir: &Path, rel: &str, content: &str) {
        let p = dir.join(rel);
        if let Some(parent) = p.parent() {
            fs::create_dir_all(parent).unwrap();
        }
        fs::write(p, content).unwrap();
    }

    #[tokio::test]
    async fn indexes_rust_definitions_and_contains_edges() {
        let tmp = std::env::temp_dir().join(format!("indexer_test_rs_{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&tmp).unwrap();
        write(&tmp, "src/main.rs", "fn helper() {}\nfn main() { helper(); }\n");

        let (graph, _, _, _) = index_project(tmp.to_str().unwrap()).await.unwrap();

        let nodes = graph["nodes"].as_array().unwrap();
        let ids: Vec<&str> = nodes.iter().map(|n| n["id"].as_str().unwrap()).collect();
        assert!(ids.contains(&"src/main.rs"), "{ids:?}");
        assert!(ids.iter().any(|id| id.contains("function:helper")), "{ids:?}");
        assert!(ids.iter().any(|id| id.contains("function:main")), "{ids:?}");

        let edges = graph["links"].as_array().unwrap();
        let has_contains = edges.iter().any(|e| e["relation"] == "contains" && e["source"] == "src/main.rs");
        assert!(has_contains, "{edges:?}");
        let has_call = edges.iter().any(|e| e["relation"] == "calls");
        assert!(has_call, "expected a calls edge from main to helper: {edges:?}");

        fs::remove_dir_all(&tmp).ok();
    }

    #[tokio::test]
    async fn indexes_typescript_imports() {
        let tmp = std::env::temp_dir().join(format!("indexer_test_ts_{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&tmp).unwrap();
        write(&tmp, "src/util.ts", "export function add(a: number, b: number) { return a + b; }\n");
        write(&tmp, "src/index.ts", "import { add } from './util';\nfunction run() { return add(1, 2); }\n");

        let (graph, _, _, _) = index_project(tmp.to_str().unwrap()).await.unwrap();

        let edges = graph["links"].as_array().unwrap();
        let has_import = edges.iter().any(|e| {
            e["relation"] == "imports" && e["source"] == "src/index.ts" && e["target"] == "src/util.ts"
        });
        assert!(has_import, "{edges:?}");

        fs::remove_dir_all(&tmp).ok();
    }

    #[tokio::test]
    async fn skips_ignored_and_sensitive_paths() {
        let tmp = std::env::temp_dir().join(format!("indexer_test_ignore_{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&tmp).unwrap();
        write(&tmp, "src/main.rs", "fn main() {}\n");
        write(&tmp, "node_modules/pkg/index.js", "function evil() {}\n");
        write(&tmp, "target/debug/build.rs", "fn generated() {}\n");
        write(&tmp, ".ssh/id_rsa", "not a real key");

        let (graph, _, _, _) = index_project(tmp.to_str().unwrap()).await.unwrap();
        let ids: Vec<&str> = graph["nodes"].as_array().unwrap().iter().map(|n| n["id"].as_str().unwrap()).collect();
        assert!(ids.contains(&"src/main.rs"));
        assert!(!ids.iter().any(|id| id.starts_with("node_modules")), "{ids:?}");
        assert!(!ids.iter().any(|id| id.starts_with("target")), "{ids:?}");
        assert!(!ids.iter().any(|id| id.contains("id_rsa")), "{ids:?}");

        fs::remove_dir_all(&tmp).ok();
    }

    #[tokio::test]
    async fn hash_is_deterministic_across_runs() {
        let tmp = std::env::temp_dir().join(format!("indexer_test_hash_{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&tmp).unwrap();
        write(&tmp, "src/a.rs", "fn a() {}\n");
        write(&tmp, "src/b.rs", "fn b() {}\n");

        let (_, hash1, _, _) = index_project(tmp.to_str().unwrap()).await.unwrap();
        let (_, hash2, _, _) = index_project(tmp.to_str().unwrap()).await.unwrap();
        assert_eq!(hash1, hash2);

        fs::remove_dir_all(&tmp).ok();
    }

    #[tokio::test]
    async fn community_grouping_is_per_directory_not_top_level() {
        // Two files sharing a top-level dir ("apps") but in different subdirectories should
        // land in different communities — grouping by only the first path segment collapses
        // a whole monorepo into a handful of giant buckets (see: openmemory itself showing
        // 13 communities for ~6800 nodes before this fix).
        let tmp = std::env::temp_dir().join(format!("indexer_test_community_{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&tmp).unwrap();
        write(&tmp, "apps/server/src/main.rs", "fn main() {}\n");
        write(&tmp, "apps/web/util.ts", "export function f() {}\n");

        let (graph, _, _, _) = index_project(tmp.to_str().unwrap()).await.unwrap();
        let nodes = graph["nodes"].as_array().unwrap();
        let server_file = nodes.iter().find(|n| n["id"] == "apps/server/src/main.rs").unwrap();
        let web_file = nodes.iter().find(|n| n["id"] == "apps/web/util.ts").unwrap();
        assert_ne!(
            server_file["community"], web_file["community"],
            "files in different subdirectories under the same top-level dir must not share a community: {nodes:?}"
        );

        fs::remove_dir_all(&tmp).ok();
    }

    fn git(dir: &Path, args: &[&str]) {
        let status = std::process::Command::new("git")
            .arg("-C")
            .arg(dir)
            .args(args)
            .env("GIT_AUTHOR_NAME", "Test Author")
            .env("GIT_AUTHOR_EMAIL", "test@example.com")
            .env("GIT_COMMITTER_NAME", "Test Author")
            .env("GIT_COMMITTER_EMAIL", "test@example.com")
            .status()
            .expect("git command failed to run");
        assert!(status.success(), "git {args:?} failed");
    }

    #[tokio::test]
    async fn collects_git_commit_nodes_and_modified_edges() {
        let tmp = std::env::temp_dir().join(format!("indexer_test_git_{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&tmp).unwrap();
        write(&tmp, "src/main.rs", "fn main() {}\n");
        git(&tmp, &["init", "-q"]);
        git(&tmp, &["add", "."]);
        git(&tmp, &["commit", "-q", "-m", "initial commit"]);

        let (graph, _, _, _) = index_project(tmp.to_str().unwrap()).await.unwrap();

        let nodes = graph["nodes"].as_array().unwrap();
        let commit_node = nodes.iter().find(|n| n["file_type"] == "commit");
        assert!(commit_node.is_some(), "{nodes:?}");
        let commit_node = commit_node.unwrap();
        assert_eq!(commit_node["label"], "initial commit");
        assert_eq!(commit_node["author"], "Test Author");
        assert!(commit_node["date"].as_str().is_some());

        let commit_id = commit_node["id"].as_str().unwrap();
        let edges = graph["links"].as_array().unwrap();
        let has_modified = edges.iter().any(|e| {
            e["relation"] == "modified" && e["source"] == commit_id && e["target"] == "src/main.rs"
        });
        assert!(has_modified, "{edges:?}");

        fs::remove_dir_all(&tmp).ok();
    }

    #[tokio::test]
    async fn no_git_history_for_non_repo_directory() {
        let tmp = std::env::temp_dir().join(format!("indexer_test_nogit_{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&tmp).unwrap();
        write(&tmp, "src/main.rs", "fn main() {}\n");
        // Deliberately no `git init` — indexing a plain directory must not fail or produce
        // commit nodes.

        let (graph, _, _, _) = index_project(tmp.to_str().unwrap()).await.unwrap();
        let nodes = graph["nodes"].as_array().unwrap();
        assert!(!nodes.iter().any(|n| n["file_type"] == "commit"), "{nodes:?}");

        fs::remove_dir_all(&tmp).ok();
    }

    #[tokio::test]
    async fn git_history_disabled_via_env_var() {
        let tmp = std::env::temp_dir().join(format!("indexer_test_git_off_{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&tmp).unwrap();
        write(&tmp, "src/main.rs", "fn main() {}\n");
        git(&tmp, &["init", "-q"]);
        git(&tmp, &["add", "."]);
        git(&tmp, &["commit", "-q", "-m", "initial commit"]);

        // SAFETY: this test mutates process-wide env state. index_project spawns its work via
        // spawn_blocking onto a fresh blocking thread, so run this test with
        // `--test-threads=1` (or accept it may race other env-sensitive tests) to avoid
        // cross-test interference — see indexer.rs test module doc note below.
        std::env::set_var("OPENMEMORY_GIT_HISTORY_COMMITS", "0");
        let result = index_project(tmp.to_str().unwrap()).await;
        std::env::remove_var("OPENMEMORY_GIT_HISTORY_COMMITS");

        let (graph, _, _, _) = result.unwrap();
        let nodes = graph["nodes"].as_array().unwrap();
        assert!(!nodes.iter().any(|n| n["file_type"] == "commit"), "{nodes:?}");

        fs::remove_dir_all(&tmp).ok();
    }
}
