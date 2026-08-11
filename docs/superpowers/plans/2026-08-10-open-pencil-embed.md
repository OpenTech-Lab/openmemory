# OpenPencil Embed Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Embed a self-hosted, fully-offline OpenPencil editor into the OpenMemory project Designs tab as a new `pen` diagram type, storing binary `.fig` documents on a server-side volume.

**Architecture:** A new minimal embed entrypoint in the OpenPencil checkout renders `createEditor()` + canvas via the `@open-pencil/vue` SDK and speaks a draw.io-style postMessage protocol. It persists `.fig` bytes through a custom `openmemory` storage provider that calls OpenMemory's own blob endpoints, so no credentials reach the browser. The OpenMemory design record stores only a small JSON reference in its existing `source` column.

**Tech Stack:** Vue 3 + Vite + CanvasKit (OpenPencil side); Next.js 16 / React 19 (OpenMemory web); Rust + axum 0.7 + sqlx (OpenMemory server); Docker Compose + nginx.

**Spec:** `docs/superpowers/specs/2026-08-10-open-pencil-embed-design.md`

## Global Constraints

- **100% offline at runtime.** No request may leave the machine during an editing session. Enforced by CSP at nginx, not by configuration alone. Network access at Docker *build* time is acceptable.
- **Fonts: Latin only.** Ship the already-bundled Inter and NotoNaskhArabic. Vendor no CJK fonts. CJK text rendering as tofu is an accepted consequence.
- **`project_designs.source` stays kilobyte-scale** for every diagram type. `.fig` bytes must never be written into it. No database migration.
- **No regression** to draw.io, mermaid, React Flow, or the derived architecture canvas.
- **OpenPencil repo rules:** all work must pass `bun run check` (oxlint type-aware + tsgo + Steiger architecture lint). Use public package exports only (`@open-pencil/vue`, `@open-pencil/core/...`) — never workspace internals. Do **not** import from `src/views/**`: the Steiger rule `no-views-imported-outside-entry` hardcodes its allowlist to `src/App.vue`, `src/main.ts`, `src/router.ts` (`tools/architecture/src/steiger-rules/index.ts:319-326`).
- **OpenMemory web has no test runner.** `"test"` is `echo 'no tests yet' && exit 0`. Tests are colocated `node:test` + `node:assert` files run directly with `node --test`, following `apps/web/lib/drawio.test.ts`.
- **The embed imports nothing that reaches the network.** No AI chat, collaboration/WebRTC, vectorize, or icon-picker modules — the icon subsystem fetches `api.iconify.design` at runtime (`packages/core/src/icons/api.ts:5`). The shell is canvas-only by construction; keep it that way.
- **Two repositories.** OpenMemory: `~/projects/openmemory`. OpenPencil: `~/projects/open-pencil`. Commit to each separately; never mix a commit across both.
- **Blob size ceiling:** 128 MB. Real `.fig` files reach 82 MB (`nuxtui.fig`).

---

## File Structure

**OpenMemory (`~/projects/openmemory`)**

| path | responsibility |
|---|---|
| `apps/server/src/design_blobs.rs` | **new** — blob read/write handlers over the volume; path safety; size limit |
| `apps/server/src/main.rs` | route registration, `VALID_DIAGRAM_TYPES`, module declaration |
| `apps/web/lib/pencil.ts` | **new** — pure helpers: reference parse/serialize, embed URL, message parsing |
| `apps/web/lib/pencil.test.ts` | **new** — `node:test` coverage of the above |
| `apps/web/components/pencil-diagram.tsx` | **new** — iframe host, `flushSource()` handle, message listener |
| `apps/web/components/project-design-panel.tsx` | `computeEditorMode()` + `handleSave()` + render branch |
| `apps/web/lib/design-meta.ts` | register the `pen` starter |
| `docker-compose.yml` | `open-pencil` service; blob volume on `openmemory-server` |
| `docker/open-pencil/Dockerfile` | **new** — build embed, serve via nginx |
| `docker/open-pencil/nginx.conf` | **new** — CSP enforcing offline |

**OpenPencil (`~/projects/open-pencil`)**

| path | responsibility |
|---|---|
| `embed.html` | **new** — second Vite entry HTML |
| `src/embed/main.ts` | **new** — mount, offline lockdown, boot |
| `src/embed/protocol.ts` | **new** — postMessage message types + parsing |
| `src/embed/bridge.ts` | **new** — wires protocol to editor load/save |
| `src/embed/storage/openmemory.ts` | **new** — `StorageAdapter` calling OpenMemory blob endpoints |
| `src/embed/EmbedShell.vue` | **new** — canvas-only shell |
| `vite.config.ts` | multi-entry `rollupOptions.input` |

`src/embed/` is a new top-level folder deliberately: Steiger's import rules key off `src/app/`, `src/components/`, and `src/views/` prefixes, so a sibling folder avoids inheriting constraints that do not apply to an embed entrypoint.

---

## Task 1: Blob storage endpoints

**Files:**
- Create: `apps/server/src/design_blobs.rs`
- Modify: `apps/server/src/main.rs` (module decl near other `mod` lines; routes near line 1492)

**Interfaces:**
- Consumes: `AppState { db, api_token, .. }` (`main.rs:71`), `is_authenticated(&HeaderMap, &str) -> bool`
- Produces: `GET /projects/:id/designs/:design_id/blob` → raw bytes; `PUT` same path → `{"ok":true}`. Handlers `get_design_blob`, `put_design_blob`. Constant `MAX_DESIGN_BLOB_BYTES: usize = 128 * 1024 * 1024`. Function `blob_path(root: &std::path::Path, design_id: Uuid) -> PathBuf`.

- [ ] **Step 1: Write the failing test**

Create `apps/server/src/design_blobs.rs` with only the test module:

```rust
#[cfg(test)]
mod tests {
    use super::*;
    use uuid::Uuid;

    #[test]
    fn blob_path_uses_design_id_as_filename() {
        let id = Uuid::parse_str("11111111-2222-3333-4444-555555555555").unwrap();
        let path = blob_path(std::path::Path::new("/data/design-blobs"), id);
        assert_eq!(
            path,
            std::path::PathBuf::from(
                "/data/design-blobs/11111111-2222-3333-4444-555555555555.fig"
            )
        );
    }

    #[test]
    fn blob_path_cannot_escape_root() {
        // A Uuid can only render as hex + dashes, so traversal is structurally
        // impossible. This test documents and locks that guarantee.
        let id = Uuid::new_v4();
        let root = std::path::Path::new("/data/design-blobs");
        let path = blob_path(root, id);
        assert!(path.starts_with(root));
        assert!(!path.to_string_lossy().contains(".."));
    }
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd ~/projects/openmemory && cargo test -p openmemory-server design_blobs`
Expected: FAIL — `cannot find function blob_path in this scope`.

(If the package name differs, get it from `apps/server/Cargo.toml`'s `[package] name`.)

- [ ] **Step 3: Write minimal implementation**

Add above the test module in `apps/server/src/design_blobs.rs`:

```rust
use std::path::{Path, PathBuf};

use axum::{
    body::Bytes,
    extract::{Path as AxumPath, State},
    http::{HeaderMap, StatusCode},
    response::IntoResponse,
    Json,
};
use tracing::error;
use uuid::Uuid;

use crate::{is_authenticated, AppState};

/// Upper bound on a single design document. Real `.fig` files reach ~82 MB.
pub const MAX_DESIGN_BLOB_BYTES: usize = 128 * 1024 * 1024;

/// Directory holding `.fig` documents, overridable for tests and local runs.
pub fn blob_root() -> PathBuf {
    std::env::var("OPENMEMORY_DESIGN_BLOB_DIR")
        .unwrap_or_else(|_| "/data/design-blobs".to_string())
        .into()
}

/// A `Uuid` renders only as hex and dashes, so the filename can never contain a
/// path separator or `..` — traversal is structurally impossible rather than filtered.
pub fn blob_path(root: &Path, design_id: Uuid) -> PathBuf {
    root.join(format!("{design_id}.fig"))
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cargo test -p openmemory-server design_blobs`
Expected: PASS, 2 tests.

- [ ] **Step 5: Add the handlers**

Append to `apps/server/src/design_blobs.rs`, above the test module:

```rust
/// Confirms the design exists and belongs to this project before any file touch,
/// so blob URLs cannot be used to probe or write across projects.
async fn design_exists(state: &AppState, project_id: Uuid, design_id: Uuid) -> Result<bool, sqlx::Error> {
    let row: Option<(Uuid,)> =
        sqlx::query_as("SELECT id FROM project_designs WHERE id = $1 AND project_id = $2")
            .bind(design_id)
            .bind(project_id)
            .fetch_optional(&state.db)
            .await?;
    Ok(row.is_some())
}

pub async fn get_design_blob(
    State(state): State<AppState>,
    headers: HeaderMap,
    AxumPath((project_id, design_id)): AxumPath<(Uuid, Uuid)>,
) -> impl IntoResponse {
    if !is_authenticated(&headers, &state.api_token) {
        return (StatusCode::UNAUTHORIZED, Json(serde_json::json!({"error": "unauthorized"}))).into_response();
    }

    match design_exists(&state, project_id, design_id).await {
        Ok(false) => {
            return (StatusCode::NOT_FOUND, Json(serde_json::json!({"error": "design not found"}))).into_response()
        }
        Err(e) => {
            error!("get_design_blob lookup error: {e}");
            return (StatusCode::INTERNAL_SERVER_ERROR, Json(serde_json::json!({"error": e.to_string()}))).into_response();
        }
        Ok(true) => {}
    }

    match tokio::fs::read(blob_path(&blob_root(), design_id)).await {
        Ok(bytes) => (
            StatusCode::OK,
            [(axum::http::header::CONTENT_TYPE, "application/octet-stream")],
            bytes,
        )
            .into_response(),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
            (StatusCode::NOT_FOUND, Json(serde_json::json!({"error": "blob not found"}))).into_response()
        }
        Err(e) => {
            error!("get_design_blob read error: {e}");
            (StatusCode::INTERNAL_SERVER_ERROR, Json(serde_json::json!({"error": e.to_string()}))).into_response()
        }
    }
}

pub async fn put_design_blob(
    State(state): State<AppState>,
    headers: HeaderMap,
    AxumPath((project_id, design_id)): AxumPath<(Uuid, Uuid)>,
    body: Bytes,
) -> impl IntoResponse {
    if !is_authenticated(&headers, &state.api_token) {
        return (StatusCode::UNAUTHORIZED, Json(serde_json::json!({"error": "unauthorized"}))).into_response();
    }

    if body.len() > MAX_DESIGN_BLOB_BYTES {
        return (
            StatusCode::PAYLOAD_TOO_LARGE,
            Json(serde_json::json!({
                "error": format!("design exceeds {} MB limit", MAX_DESIGN_BLOB_BYTES / (1024 * 1024))
            })),
        )
            .into_response();
    }

    match design_exists(&state, project_id, design_id).await {
        Ok(false) => {
            return (StatusCode::NOT_FOUND, Json(serde_json::json!({"error": "design not found"}))).into_response()
        }
        Err(e) => {
            error!("put_design_blob lookup error: {e}");
            return (StatusCode::INTERNAL_SERVER_ERROR, Json(serde_json::json!({"error": e.to_string()}))).into_response();
        }
        Ok(true) => {}
    }

    let root = blob_root();
    if let Err(e) = tokio::fs::create_dir_all(&root).await {
        error!("put_design_blob mkdir error: {e}");
        return (StatusCode::INTERNAL_SERVER_ERROR, Json(serde_json::json!({"error": e.to_string()}))).into_response();
    }

    // Write to a temp file then rename, so a failed or partial write can never leave a
    // corrupt document where a previously good one was.
    let final_path = blob_path(&root, design_id);
    let temp_path = root.join(format!("{design_id}.fig.tmp"));
    if let Err(e) = tokio::fs::write(&temp_path, &body).await {
        error!("put_design_blob write error: {e}");
        return (StatusCode::INTERNAL_SERVER_ERROR, Json(serde_json::json!({"error": e.to_string()}))).into_response();
    }
    if let Err(e) = tokio::fs::rename(&temp_path, &final_path).await {
        error!("put_design_blob rename error: {e}");
        return (StatusCode::INTERNAL_SERVER_ERROR, Json(serde_json::json!({"error": e.to_string()}))).into_response();
    }

    (StatusCode::OK, Json(serde_json::json!({"ok": true}))).into_response()
}
```

- [ ] **Step 6: Register the module and routes**

In `apps/server/src/main.rs`, add alongside the other `mod` declarations:

```rust
mod design_blobs;
```

Then after the existing design routes (near line 1492), add:

```rust
        .route(
            "/projects/:id/designs/:design_id/blob",
            get(design_blobs::get_design_blob).put(design_blobs::put_design_blob),
        )
```

Axum's default request body limit is 2 MB, which would reject every real design. Raise it for this route by adding to the same router chain:

```rust
        .layer(axum::extract::DefaultBodyLimit::max(design_blobs::MAX_DESIGN_BLOB_BYTES))
```

- [ ] **Step 7: Verify it compiles and tests pass**

Run: `cargo build -p openmemory-server && cargo test -p openmemory-server design_blobs`
Expected: builds clean; 2 tests pass.

- [ ] **Step 8: Commit**

```bash
cd ~/projects/openmemory
git add apps/server/src/design_blobs.rs apps/server/src/main.rs
git commit -m "feat(server): add design blob storage endpoints"
```

---

## Task 2: Accept the `pen` diagram type

**Files:**
- Modify: `apps/server/src/main.rs:348` (`VALID_DIAGRAM_TYPES`), and the two error strings at ~6256 and ~6304

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces: the API accepts `diagram_type: "pen"` on design create and update.

- [ ] **Step 1: Write the failing test**

Add to `apps/server/src/design_blobs.rs`'s test module:

```rust
    #[test]
    fn pen_is_an_accepted_diagram_type() {
        assert!(crate::VALID_DIAGRAM_TYPES.contains(&"pen"));
        // The pre-existing types must keep working.
        for existing in ["drawio", "mermaid", "reactflow"] {
            assert!(crate::VALID_DIAGRAM_TYPES.contains(&existing));
        }
    }
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cargo test -p openmemory-server pen_is_an_accepted`
Expected: FAIL on the `"pen"` assertion.

(If `VALID_DIAGRAM_TYPES` is private, mark it `pub(crate)` — it is a constant, so this is safe.)

- [ ] **Step 3: Write minimal implementation**

`apps/server/src/main.rs:348`:

```rust
const VALID_DIAGRAM_TYPES: &[&str] = &["drawio", "mermaid", "reactflow", "pen"];
```

Update both error strings (~6256, ~6304) so the message stays truthful:

```rust
            return (StatusCode::BAD_REQUEST, Json(serde_json::json!({"error": "diagram_type must be one of: drawio, mermaid, reactflow, pen"}))).into_response();
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cargo test -p openmemory-server pen_is_an_accepted`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
cd ~/projects/openmemory
git add apps/server/src/main.rs apps/server/src/design_blobs.rs
git commit -m "feat(server): accept pen diagram type"
```

---

## Task 3: `lib/pencil.ts` reference and message helpers

**Files:**
- Create: `apps/web/lib/pencil.ts`
- Create: `apps/web/lib/pencil.test.ts`

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces:
  - `PENCIL_EMBED_URL: string`
  - `type PencilRef = { providerId: 'openmemory' }`
  - `isPencilSource(source: string): boolean`
  - `parsePencilRef(source: string): PencilRef | null`
  - `serializePencilRef(ref: PencilRef): string`
  - `blankPencilSource(): string`
  - `pencilEmbedSrc(darkMode?: boolean): string`
  - `type PencilMessage = { event?: string; documentId?: string; error?: string }`
  - `parsePencilMessage(value: unknown): PencilMessage | null`

- [ ] **Step 1: Write the failing test**

Create `apps/web/lib/pencil.test.ts`:

```ts
import assert from 'node:assert/strict';
import test from 'node:test';
import {
  blankPencilSource,
  isPencilSource,
  parsePencilMessage,
  parsePencilRef,
  pencilEmbedSrc,
  serializePencilRef,
} from './pencil.ts';

test('pencil refs round-trip through serialize and parse', () => {
  const ref = { providerId: 'openmemory' as const };
  const parsed = parsePencilRef(serializePencilRef(ref));
  assert.deepEqual(parsed, ref);
});

test('blank source is a valid pencil ref', () => {
  const source = blankPencilSource();
  assert.equal(isPencilSource(source), true);
  assert.deepEqual(parsePencilRef(source), { providerId: 'openmemory' });
});

test('pencil source detection rejects other diagram formats', () => {
  assert.equal(isPencilSource('flowchart TD\n  A --> B'), false);
  assert.equal(isPencilSource('<mxfile host="OpenMemory"></mxfile>'), false);
  assert.equal(isPencilSource(''), false);
  assert.equal(isPencilSource('{"nodes":[],"edges":[]}'), false);
});

test('malformed refs parse to null rather than throwing', () => {
  assert.equal(parsePencilRef('not json'), null);
  assert.equal(parsePencilRef('{}'), null);
  assert.equal(parsePencilRef('{"providerId":"s3"}'), null);
  assert.equal(parsePencilRef('[]'), null);
  assert.equal(parsePencilRef('null'), null);
  assert.equal(parsePencilRef('42'), null);
});

test('embed src carries the embed path and theme', () => {
  const dark = pencilEmbedSrc(true);
  assert.equal(dark.includes('/embed.html'), true);
  assert.equal(dark.includes('dark=1'), true);
  assert.equal(pencilEmbedSrc(false).includes('dark=0'), true);
});

test('message parsing tolerates hostile input', () => {
  assert.deepEqual(parsePencilMessage('{"event":"ready"}'), {
    event: 'ready',
    documentId: undefined,
    error: undefined,
  });
  assert.equal(parsePencilMessage('not json'), null);
  assert.equal(parsePencilMessage(null), null);
  assert.equal(parsePencilMessage([]), null);
  assert.equal(parsePencilMessage(42), null);
  assert.deepEqual(parsePencilMessage({ event: 'saved', documentId: 'd1' }), {
    event: 'saved',
    documentId: 'd1',
    error: undefined,
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd ~/projects/openmemory/apps/web && node --test lib/pencil.test.ts`
Expected: FAIL — cannot resolve `./pencil.ts`.

- [ ] **Step 3: Write minimal implementation**

Create `apps/web/lib/pencil.ts`:

```ts
export const PENCIL_EMBED_URL =
  process.env.NEXT_PUBLIC_OPEN_PENCIL_URL?.replace(/\/$/, '') ?? 'http://localhost:18082';

/**
 * A `pen` design stores only a marker in `project_designs.source`. The `.fig` bytes live
 * on the server's blob volume — real design files reach ~82 MB and must never be inlined
 * into the source column alongside kilobyte-scale mermaid text.
 *
 * The marker deliberately carries no document id: the blob is addressed by the design id
 * in the route (`/projects/:id/designs/:design_id/blob`), so storing it here too would be
 * redundant state that could drift out of sync with the row it lives in.
 */
export interface PencilRef {
  providerId: 'openmemory';
}

export function serializePencilRef(ref: PencilRef): string {
  return JSON.stringify(ref);
}

export function parsePencilRef(source: string): PencilRef | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(source);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
  const record = parsed as Record<string, unknown>;
  if (record.providerId !== 'openmemory') return null;
  return { providerId: 'openmemory' };
}

export function isPencilSource(source: string): boolean {
  return parsePencilRef(source) !== null;
}

export function blankPencilSource(): string {
  return serializePencilRef({ providerId: 'openmemory' });
}

export function pencilEmbedSrc(darkMode = false): string {
  const params = new URLSearchParams({ dark: darkMode ? '1' : '0' });
  return `${PENCIL_EMBED_URL}/embed.html?${params.toString()}`;
}

export interface PencilMessage {
  event?: string;
  documentId?: string;
  error?: string;
}

export function parsePencilMessage(value: unknown): PencilMessage | null {
  let parsed = value;
  if (typeof value === 'string') {
    try {
      parsed = JSON.parse(value);
    } catch {
      return null;
    }
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
  const message = parsed as Record<string, unknown>;
  return {
    event: typeof message.event === 'string' ? message.event : undefined,
    documentId: typeof message.documentId === 'string' ? message.documentId : undefined,
    error: typeof message.error === 'string' ? message.error : undefined,
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd ~/projects/openmemory/apps/web && node --test lib/pencil.test.ts`
Expected: PASS, 6 tests.

- [ ] **Step 5: Commit**

```bash
cd ~/projects/openmemory
git add apps/web/lib/pencil.ts apps/web/lib/pencil.test.ts
git commit -m "feat(web): add pencil reference and message helpers"
```

---

## Task 4: OpenPencil embed shell

**Files:**
- Create: `~/projects/open-pencil/embed.html`
- Create: `~/projects/open-pencil/src/embed/EmbedShell.vue`
- Create: `~/projects/open-pencil/src/embed/main.ts`
- Modify: `~/projects/open-pencil/vite.config.ts` (add `build.rollupOptions.input`)

**Interfaces:**
- Consumes: `createEditor` from `@open-pencil/core/editor`; `provideEditor`, `useCanvas`, `useEditor` from `@open-pencil/vue`.
- Produces: a built `embed.html` that boots a canvas-only editor with all network access disabled. Exposes nothing to later tasks except the mount point; the bridge is wired in Task 6.

- [ ] **Step 1: Add the second Vite entry**

`vite.config.ts` — replace the existing `build` block:

```ts
  build: {
    chunkSizeWarningLimit: 2500,
    rollupOptions: {
      input: {
        main: resolve(__dirname, 'index.html'),
        embed: resolve(__dirname, 'embed.html')
      }
    }
  },
```

Add at the top of the file, with the other node imports:

```ts
import { resolve } from 'node:path'
```

- [ ] **Step 2: Create the entry HTML**

`embed.html`:

```html
<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0, viewport-fit=cover" />
    <title>OpenPencil Embed</title>
    <style>
      html, body, #embed-root { margin: 0; height: 100%; width: 100%; overflow: hidden; }
    </style>
  </head>
  <body>
    <div id="embed-root"></div>
    <script type="module" src="/src/embed/main.ts"></script>
  </body>
</html>
```

- [ ] **Step 3: Create the canvas-only shell**

`src/embed/EmbedShell.vue`. It uses only SDK primitives — no `src/views/**` import, which the Steiger `no-views-imported-outside-entry` rule forbids outside the three allowlisted entry files:

```vue
<script setup lang="ts">
import { ref } from 'vue'

import { useCanvas, useEditor } from '@open-pencil/vue'

const canvasRef = ref<HTMLCanvasElement | null>(null)
const editor = useEditor()

useCanvas(canvasRef, editor)
</script>

<template>
  <canvas ref="canvasRef" class="size-full" />
</template>
```

- [ ] **Step 4: Create the entry with offline lockdown**

`src/embed/main.ts`:

```ts
import { createApp, h } from 'vue'

import { createEditor } from '@open-pencil/core/editor'
import { provideEditor } from '@open-pencil/vue'

import EmbedShell from './EmbedShell.vue'

/**
 * The embed must make no network requests at runtime. nginx enforces this with CSP, but
 * these switches stop the app from *attempting* requests that would otherwise fail
 * loudly in the console and degrade the editing experience.
 *
 * Remote web fonts default to enabled (`op-online-fonts-enabled`), and the CJK fallback
 * manifest lists Noto Sans SC/TC/JP/KR as remote families, so both must be turned off
 * before the editor boots.
 */
function enforceOfflineMode(): void {
  window.localStorage.setItem('op-online-fonts-enabled', 'false')
  for (const provider of ['google', 'fontsource', 'bunny', 'fontshare']) {
    window.localStorage.setItem(`op-web-font-provider-${provider}`, 'false')
  }
}

enforceOfflineMode()

const editor = createEditor({ width: 1200, height: 800 })

const app = createApp({
  setup() {
    provideEditor(editor)
    return () => h(EmbedShell)
  }
})

app.mount('#embed-root')
```

The web-font provider localStorage keys are an assumption. Verify them against `packages/core/src/text/web-fonts.ts:93-118` (the `enabled` set and `settings[provider]` read) and correct the key names if they differ — the setting must actually take effect, not merely be written.

- [ ] **Step 5: Verify the build produces both entries**

Run: `cd ~/projects/open-pencil && bun run build:packages && bunx vite build`
Expected: `dist/index.html` and `dist/embed.html` both exist, and `dist/canvaskit.wasm` is present.

- [ ] **Step 6: Verify architecture and type gates pass**

Run: `cd ~/projects/open-pencil && bun run check`
Expected: PASS. If Steiger flags `src/embed/**`, fix the import rather than adding an ignore — the rules encode real boundaries.

- [ ] **Step 7: Commit**

```bash
cd ~/projects/open-pencil
git add embed.html src/embed vite.config.ts
git commit -m "feat(embed): add offline canvas-only embed entrypoint"
```

---

## Task 5: OpenMemory storage provider

**Files:**
- Create: `~/projects/open-pencil/src/embed/storage/openmemory.ts`

**Interfaces:**
- Consumes: `StorageAdapter`, `StorageDocument`, `StorageDocumentMetadata`, `StorageUsage`, `StorageConnectionResult` from `src/app/integrations/storage/types.ts`.
- Produces: `createOpenMemoryStorageAdapter(config: OpenMemoryStorageConfig): StorageAdapter` where `OpenMemoryStorageConfig = { baseUrl: string; projectId: string; designId: string }`.

- [ ] **Step 1: Write the implementation**

`src/embed/storage/openmemory.ts`:

```ts
import type {
  StorageAdapter,
  StorageConnectionResult,
  StorageDocument,
  StorageDocumentMetadata,
  StorageUsage
} from '@/app/integrations/storage/types'

export interface OpenMemoryStorageConfig {
  baseUrl: string
  projectId: string
  designId: string
}

/**
 * Persists `.fig` bytes through OpenMemory's own blob endpoints rather than talking to
 * object storage directly. OpenPencil's built-in S3 adapter would require handing S3
 * credentials to frontend-reachable JavaScript; routing through OpenMemory keeps every
 * credential server-side. The parent frame supplies the config at load time, so nothing
 * is persisted in browser storage.
 */
export function createOpenMemoryStorageAdapter(config: OpenMemoryStorageConfig): StorageAdapter {
  const blobUrl = () =>
    `${config.baseUrl.replace(/\/$/, '')}/api/projects/${config.projectId}/designs/${config.designId}/blob`

  return {
    async testConnection(): Promise<StorageConnectionResult> {
      const response = await fetch(blobUrl(), { method: 'HEAD', credentials: 'include' })
      // 404 means "no document saved yet", which is a healthy empty state.
      return response.ok || response.status === 404
        ? { ok: true, message: 'Connected to OpenMemory' }
        : { ok: false, message: `OpenMemory returned ${response.status}` }
    },

    async listDocuments(): Promise<StorageDocument[]> {
      // The embed is always scoped to exactly one design, so there is nothing to list.
      return []
    },

    async getDocument(): Promise<Uint8Array> {
      const response = await fetch(blobUrl(), { credentials: 'include' })
      if (response.status === 404) return new Uint8Array()
      if (!response.ok) throw new Error(`Failed to load design (${response.status})`)
      return new Uint8Array(await response.arrayBuffer())
    },

    async putDocument(_id: string, bytes: Uint8Array): Promise<void> {
      const response = await fetch(blobUrl(), {
        method: 'PUT',
        credentials: 'include',
        headers: { 'Content-Type': 'application/octet-stream' },
        body: bytes as BodyInit
      })
      if (!response.ok) {
        const detail = await response.text().catch(() => '')
        throw new Error(`Failed to save design (${response.status}) ${detail}`.trim())
      }
    },

    async deleteDocument(): Promise<void> {
      // Blob lifetime follows the design record, which OpenMemory deletes server-side.
    },

    async getDocumentMetadata(): Promise<StorageDocumentMetadata | null> {
      return null
    },

    async getUsage(): Promise<StorageUsage> {
      return { bytesUsed: 0, objectCount: 0, documentCount: 0 }
    }
  }
}
```

- [ ] **Step 2: Verify the adapter satisfies the interface**

Run: `cd ~/projects/open-pencil && bun run check`
Expected: PASS. If `tsgo` reports missing or mismatched members, reconcile against `src/app/integrations/storage/types.ts` — that interface is the contract, not this file.

- [ ] **Step 3: Commit**

```bash
cd ~/projects/open-pencil
git add src/embed/storage/openmemory.ts
git commit -m "feat(embed): add OpenMemory-backed storage adapter"
```

---

## Task 6: postMessage bridge

**Files:**
- Create: `~/projects/open-pencil/src/embed/protocol.ts`
- Create: `~/projects/open-pencil/src/embed/bridge.ts`
- Modify: `~/projects/open-pencil/src/embed/main.ts` (call the bridge)

**Interfaces:**
- Consumes: `createOpenMemoryStorageAdapter` (Task 5); `Editor` from `@open-pencil/core/editor`.
- Produces: `installBridge(editor: Editor): void`. Emits `ready`, `loaded`, `saved`, `error`; accepts `load` and `save`.

- [ ] **Step 1: Define the protocol**

`src/embed/protocol.ts`:

```ts
export interface EmbedLoadRequest {
  action: 'load'
  baseUrl: string
  projectId: string
  designId: string
}

export interface EmbedSaveRequest {
  action: 'save'
}

export type EmbedRequest = EmbedLoadRequest | EmbedSaveRequest

export interface EmbedEvent {
  event: 'ready' | 'loaded' | 'saved' | 'error'
  documentId?: string
  error?: string
}

export function parseEmbedRequest(value: unknown): EmbedRequest | null {
  let parsed = value
  if (typeof value === 'string') {
    try {
      parsed = JSON.parse(value)
    } catch {
      return null
    }
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null
  const record = parsed as Record<string, unknown>

  if (record.action === 'save') return { action: 'save' }
  if (record.action === 'load') {
    const { baseUrl, projectId, designId } = record
    if (typeof baseUrl !== 'string' || typeof projectId !== 'string' || typeof designId !== 'string') {
      return null
    }
    return { action: 'load', baseUrl, projectId, designId }
  }
  return null
}
```

- [ ] **Step 2: Implement the bridge**

`src/embed/bridge.ts`:

```ts
import { getCanvasKit } from '@open-pencil/core/canvaskit'
import type { Editor } from '@open-pencil/core/editor'
import { figFormat } from '@open-pencil/core/io'

import { parseEmbedRequest, type EmbedEvent } from './protocol'
import { createOpenMemoryStorageAdapter } from './storage/openmemory'

/**
 * The parent frame owns the record lifecycle: it tells us what to load, and asks us to
 * flush on save. We never write on our own schedule, mirroring how the draw.io embed is
 * driven by OpenMemory's Save button rather than autosaving to the server.
 */
export function installBridge(editor: Editor): void {
  let adapter: ReturnType<typeof createOpenMemoryStorageAdapter> | null = null
  let designId = ''

  const post = (message: EmbedEvent) => {
    window.parent.postMessage(JSON.stringify(message), '*')
  }

  window.addEventListener('message', (event: MessageEvent) => {
    const request = parseEmbedRequest(event.data)
    if (!request) return

    if (request.action === 'load') {
      designId = request.designId
      adapter = createOpenMemoryStorageAdapter({
        baseUrl: request.baseUrl,
        projectId: request.projectId,
        designId: request.designId
      })
      void (async () => {
        try {
          const bytes = await adapter.getDocument(request.designId)
          // An empty blob means a brand-new design: keep the editor's blank document.
          if (bytes.byteLength > 0) {
            const result = await figFormat.readDocument!({ data: bytes, name: `${designId}.fig` })
            editor.loadGraph(result.graph)
          }
          post({ event: 'loaded', documentId: designId })
        } catch (error) {
          post({ event: 'error', error: error instanceof Error ? error.message : String(error) })
        }
      })()
      return
    }

    if (request.action === 'save') {
      void (async () => {
        try {
          if (!adapter) throw new Error('Editor received save before load')
          const canvasKit = await getCanvasKit()
          const written = await figFormat.writeDocument!(
            editor.getGraph(),
            // Thumbnails would require a live renderer; the parent never uses them.
            { renderThumbnail: false },
            { canvasKit }
          )
          await adapter.putDocument(designId, written.data, {
            name: `${designId}.fig`,
            updatedAt: new Date().toISOString()
          })
          post({ event: 'saved', documentId: designId })
        } catch (error) {
          post({ event: 'error', error: error instanceof Error ? error.message : String(error) })
        }
      })()
    }
  })

  post({ event: 'ready' })
}
```

`editor.loadGraph()` and `editor.getGraph()` are the assumed graph accessors. Verify against `packages/core/src/editor/create.ts` and the graph-read action modules, and substitute the real names — do not invent an API. Likewise confirm `figFormat`'s export path from `@open-pencil/core/io`.

- [ ] **Step 3: Wire the bridge into the entry**

In `src/embed/main.ts`, add the import and call it after mount:

```ts
import { installBridge } from './bridge'
```

```ts
app.mount('#embed-root')

installBridge(editor)
```

- [ ] **Step 4: Verify gates pass**

Run: `cd ~/projects/open-pencil && bun run check && bunx vite build`
Expected: both PASS.

- [ ] **Step 5: Commit**

```bash
cd ~/projects/open-pencil
git add src/embed
git commit -m "feat(embed): add postMessage bridge for load and save"
```

---

## Task 7: `PencilDiagram` React component

**Files:**
- Create: `apps/web/components/pencil-diagram.tsx`

**Interfaces:**
- Consumes: `pencilEmbedSrc`, `parsePencilMessage`, `serializePencilRef` from `@/lib/pencil` (Task 3).
- Produces: `PencilDiagram` component and `PencilDiagramHandle { flushSource: () => Promise<string> }`. `flushSource()` resolves to the serialized `PencilRef` string to store in `source`.

- [ ] **Step 1: Write the component**

`apps/web/components/pencil-diagram.tsx`:

```tsx
'use client';

import { forwardRef, useEffect, useImperativeHandle, useMemo, useRef, useState } from 'react';
import { AlertTriangle, LoaderCircle } from 'lucide-react';
import { useTheme } from 'next-themes';
import { parsePencilMessage, pencilEmbedSrc, serializePencilRef } from '@/lib/pencil';

interface PencilDiagramProps {
  projectId: string;
  designId: string;
  title?: string;
}

export interface PencilDiagramHandle {
  flushSource: () => Promise<string>;
}

export const PencilDiagram = forwardRef<PencilDiagramHandle, PencilDiagramProps>(
  function PencilDiagram({ projectId, designId, title = 'OpenPencil design' }, ref) {
    const { resolvedTheme } = useTheme();
    const isDark = resolvedTheme === 'dark';
    const iframeRef = useRef<HTMLIFrameElement>(null);
    const pendingSaveRef = useRef<{
      resolve: (source: string) => void;
      reject: (error: Error) => void;
      timeout: ReturnType<typeof setTimeout>;
    } | null>(null);
    const [isReady, setIsReady] = useState(false);
    const [error, setError] = useState<string | null>(null);

    const src = useMemo(() => pencilEmbedSrc(isDark), [isDark]);
    const targetOrigin = useMemo(() => new URL(src).origin, [src]);

    useImperativeHandle(
      ref,
      () => ({
        flushSource: () => {
          const frameWindow = iframeRef.current?.contentWindow;
          if (!frameWindow) return Promise.reject(new Error('Design editor is not ready'));

          return new Promise<string>((resolve, reject) => {
            pendingSaveRef.current?.reject(new Error('A newer save replaced this request'));
            // Saving serializes and uploads a document that can reach ~82 MB, so this
            // allows far more headroom than draw.io's 5s XML flush.
            const timeout = setTimeout(() => {
              pendingSaveRef.current = null;
              reject(new Error('Timed out while saving the design'));
            }, 60000);
            pendingSaveRef.current = { resolve, reject, timeout };
            frameWindow.postMessage(JSON.stringify({ action: 'save' }), targetOrigin);
          });
        },
      }),
      [targetOrigin],
    );

    useEffect(() => {
      setIsReady(false);
      setError(null);

      const handleMessage = (event: MessageEvent) => {
        const frameWindow = iframeRef.current?.contentWindow;
        if (!frameWindow || event.source !== frameWindow) return;
        if (event.origin !== targetOrigin) return;
        const message = parsePencilMessage(event.data);
        if (!message) return;

        if (message.event === 'ready') {
          frameWindow.postMessage(
            JSON.stringify({
              action: 'load',
              baseUrl: window.location.origin,
              projectId,
              designId,
            }),
            targetOrigin,
          );
          return;
        }

        if (message.event === 'loaded') {
          setIsReady(true);
          return;
        }

        if (message.event === 'saved') {
          const pending = pendingSaveRef.current;
          if (pending) {
            clearTimeout(pending.timeout);
            pendingSaveRef.current = null;
            pending.resolve(serializePencilRef({ providerId: 'openmemory' }));
          }
          return;
        }

        if (message.error) {
          setError(message.error);
          const pending = pendingSaveRef.current;
          if (pending) {
            clearTimeout(pending.timeout);
            pendingSaveRef.current = null;
            pending.reject(new Error(message.error));
          }
        }
      };

      window.addEventListener('message', handleMessage);
      return () => {
        window.removeEventListener('message', handleMessage);
        const pending = pendingSaveRef.current;
        if (pending) {
          clearTimeout(pending.timeout);
          pendingSaveRef.current = null;
          pending.reject(new Error('Design editor closed before saving'));
        }
      };
    }, [designId, projectId, src, targetOrigin]);

    return (
      <div className="relative h-full min-h-[360px] overflow-hidden rounded-lg border border-border/80 bg-background shadow-[0_18px_60px_rgba(15,23,42,0.12)] dark:shadow-[0_18px_60px_rgba(0,0,0,0.42)]">
        {!isReady && !error && (
          <div className="absolute inset-0 z-10 flex items-center justify-center bg-background/95 text-muted-foreground">
            <div className="flex items-center gap-2 rounded-full border border-border bg-card px-4 py-2 text-sm text-card-foreground shadow-sm">
              <LoaderCircle className="h-4 w-4 animate-spin text-sky-600" />
              Loading design studio…
            </div>
          </div>
        )}
        {error && (
          <div className="absolute inset-0 z-20 flex items-center justify-center bg-background p-6 text-center text-sm text-red-700 dark:text-red-300">
            <div className="max-w-md rounded-lg border border-red-200 bg-red-50 p-4 dark:border-red-900 dark:bg-red-950/40">
              <AlertTriangle className="mx-auto mb-2 h-6 w-6" />
              <p className="font-semibold">Couldn&apos;t load the design editor</p>
              <p className="mt-1 text-xs text-red-600 dark:text-red-400">{error}</p>
            </div>
          </div>
        )}
        <iframe
          ref={iframeRef}
          src={src}
          title={`Edit ${title}`}
          className="h-full w-full border-0 bg-background"
          allow="clipboard-read; clipboard-write; fullscreen"
          allowFullScreen
          onError={() => setError('The configured OpenPencil service could not be reached.')}
        />
      </div>
    );
  },
);
```

- [ ] **Step 2: Verify it type-checks**

Run: `cd ~/projects/openmemory/apps/web && npx tsc --noEmit`
Expected: no errors from `components/pencil-diagram.tsx`.

- [ ] **Step 3: Commit**

```bash
cd ~/projects/openmemory
git add apps/web/components/pencil-diagram.tsx
git commit -m "feat(web): add PencilDiagram embed component"
```

---

## Task 8: Wire `pen` into the design panel

**Files:**
- Modify: `apps/web/components/project-design-panel.tsx` (`DesignEditorMode` type and `computeEditorMode` near line 76; `handleSave` at line 455; the editor render branch)
- Modify: `apps/web/lib/design-meta.ts`

**Interfaces:**
- Consumes: `PencilDiagram`, `PencilDiagramHandle` (Task 7); `blankPencilSource` (Task 3).
- Produces: a working `pen` design type in the UI.

- [ ] **Step 1: Extend the editor mode**

In `project-design-panel.tsx`, update the type and function (currently at lines 76-82):

```ts
type DesignEditorMode = 'drawio' | 'pencil' | 'canvas' | 'arch' | 'mermaid';

function computeEditorMode(diagramType: DesignDiagramType, source: string): DesignEditorMode {
  if (diagramType === 'drawio') return 'drawio';
  if (diagramType === 'pen') return 'pencil';
  if (diagramType === 'reactflow') return 'canvas';
  return isArchitectureSource(source) ? 'arch' : 'mermaid';
}
```

Add `'pen'` to `DESIGN_DIAGRAM_TYPES` in `apps/web/lib/design-graph.ts` so `DesignDiagramType` includes it.

- [ ] **Step 2: Add the ref and save branch**

Add alongside the existing `drawioEditorRef`:

```ts
  const pencilEditorRef = useRef<PencilDiagramHandle>(null);
```

In `handleSave` (line 455), add a branch before the `reactflow` case:

```ts
      if (editForm.diagramType === 'drawio') {
        source = await drawioEditorRef.current?.flushSource() ?? editForm.source;
      } else if (editForm.diagramType === 'pen') {
        // On create there is no embed mounted yet, so just store the marker; the user
        // reopens the design to draw. On update, pull from the embed: flushSource()
        // uploads the .fig bytes and resolves only once the blob is safely written, so a
        // failed upload rejects here and abandons the record save rather than leaving the
        // row pointing at a blob that was never written.
        source = editDesign
          ? await pencilEditorRef.current!.flushSource()
          : blankPencilSource();
      } else if (editForm.diagramType === 'reactflow') {
```

Import the component and helpers at the top:

```ts
import { PencilDiagram, type PencilDiagramHandle } from '@/components/pencil-diagram';
import { blankPencilSource } from '@/lib/pencil';
```

- [ ] **Step 3: Render the editor**

A `pen` design needs its record to exist before the embed can address its blob, because the blob URL is keyed by `design_id`. In the editor dialog, render the embed only for a saved design:

```tsx
{editorMode === 'pencil' && (
  editDesign ? (
    <PencilDiagram
      ref={pencilEditorRef}
      projectId={projectId}
      designId={editDesign.id}
      title={editForm.title}
    />
  ) : (
    <div className="flex h-full min-h-[360px] items-center justify-center rounded-lg border border-border/80 bg-muted/30 p-6 text-center text-sm text-muted-foreground">
      Save this design first — the editor opens once the design has an ID.
    </div>
  )
)}
```

The create path is already handled by the `editDesign` guard added to `handleSave` in Step 2, which stores the marker when no embed is mounted.

- [ ] **Step 4: Register the label and format-change behavior**

All four format pickers (lines 750, 864, 973, 1114) render from `DESIGN_DIAGRAM_TYPES.map(...)` with `DIAGRAM_TYPE_LABELS[type]`, so adding `'pen'` to the array in Step 1 surfaces it everywhere automatically. It needs a label — `DIAGRAM_TYPE_LABELS` at `project-design-panel.tsx:130` is typed `Record<DesignDiagramType, string>`, so the build fails until this is added:

```ts
  pen: 'OpenPencil',
```

`handleFormatChange` (line 436) also needs a `pen` branch, otherwise switching format clears `source` to `''`, which is not a valid pencil reference:

```ts
  const handleFormatChange = (diagramType: DesignDiagramType) => {
    const nextSource = diagramType === 'drawio'
      ? drawioStarterSource(editForm.kind)
      : diagramType === 'mermaid'
        ? (STARTER_TEMPLATES[editForm.kind as DesignKind] ?? '')
        : diagramType === 'pen'
          ? blankPencilSource()
          : '';
```

`STARTER_TEMPLATES` in `lib/design-meta.ts` is keyed by `DesignKind`, not by diagram type, so it needs no new entry.

- [ ] **Step 5: Verify**

Run: `cd ~/projects/openmemory/apps/web && npx tsc --noEmit && node --test lib/pencil.test.ts`
Expected: no type errors; 6 tests pass.

- [ ] **Step 6: Commit**

```bash
cd ~/projects/openmemory
git add apps/web/components/project-design-panel.tsx apps/web/lib/design-meta.ts apps/web/lib/design-graph.ts
git commit -m "feat(web): wire pen diagram type into design panel"
```

---

## Task 9: Docker service with offline CSP

**Files:**
- Create: `docker/open-pencil/Dockerfile`
- Create: `docker/open-pencil/nginx.conf`
- Modify: `docker-compose.yml`

**Interfaces:**
- Consumes: the `embed.html` build output (Task 4).
- Produces: `http://localhost:18082/embed.html`, and `NEXT_PUBLIC_OPEN_PENCIL_URL` wired into the web service.

- [ ] **Step 1: Write the Dockerfile**

`docker/open-pencil/Dockerfile`:

```dockerfile
# Builds the OpenPencil embed from a checkout mounted at build time. Unlike the draw.io
# service, which serves a prebuilt static webapp directly, OpenPencil is a Vite + WASM
# app and must be compiled. Network is required here at BUILD time only; the resulting
# image serves entirely offline.
FROM oven/bun:1.3.10 AS build
WORKDIR /app
COPY . .
RUN bun install --frozen-lockfile
RUN bun run build:packages && bunx vite build

FROM nginx:1.27-alpine
COPY --from=build /app/dist /usr/share/nginx/html
COPY docker/open-pencil/nginx.conf /etc/nginx/conf.d/default.conf
```

- [ ] **Step 2: Write the nginx config enforcing offline**

`docker/open-pencil/nginx.conf`:

```nginx
server {
    listen 80;
    server_name _;
    root /usr/share/nginx/html;

    # The offline guarantee. Configuration flags inside the app stop it from *trying* to
    # reach the network; this stops it from *succeeding* if a future upstream change
    # reintroduces a fetch. 'wasm-unsafe-eval' is required to instantiate CanvasKit.
    add_header Content-Security-Policy "default-src 'self'; connect-src 'self'; font-src 'self'; img-src 'self' data: blob:; script-src 'self' 'wasm-unsafe-eval'; style-src 'self' 'unsafe-inline'; frame-ancestors *" always;

    location / {
        try_files $uri $uri/ =404;
    }

    types {
        application/wasm wasm;
    }
}
```

`frame-ancestors *` is required because OpenMemory embeds this in an iframe. The service is bound to `127.0.0.1`, so it is not reachable off-host.

- [ ] **Step 3: Add the compose service**

In `docker-compose.yml`, after the `drawio` service:

```yaml
  # Local-only OpenPencil embed. Unlike the draw.io service, which mounts a prebuilt
  # static webapp read-only, this must compile the Vite + WASM app, so expect a slow
  # first build. Set OPEN_PENCIL_PATH if the checkout is not a sibling of this repo.
  open-pencil:
    profiles: [api]
    build:
      context: ${OPEN_PENCIL_PATH:-../open-pencil}
      dockerfile: ${PWD}/docker/open-pencil/Dockerfile
    ports:
      - "127.0.0.1:${OPEN_PENCIL_PORT:-18082}:80"
    healthcheck:
      test: ["CMD-SHELL", "wget -q -O /dev/null http://localhost/embed.html || exit 1"]
      interval: 5s
      timeout: 5s
      retries: 10
    restart: unless-stopped
```

Add to the `web` service's `build.args` and `environment`:

```yaml
      NEXT_PUBLIC_OPEN_PENCIL_URL: ${NEXT_PUBLIC_OPEN_PENCIL_URL:-http://localhost:18082}
```

Add to `web`'s `depends_on`:

```yaml
      open-pencil:
        condition: service_healthy
```

Add the blob volume to `openmemory-server` (it currently mounts only `${HOME}` read-only):

```yaml
    volumes:
      - ${HOME}:${HOME}:ro
      - design-blobs:/data/design-blobs
```

And set its env:

```yaml
      OPENMEMORY_DESIGN_BLOB_DIR: /data/design-blobs
```

Declare the volume at the file's top-level `volumes:` block:

```yaml
  design-blobs:
```

- [ ] **Step 4: Build and verify the service serves the embed**

Run:
```bash
cd ~/projects/openmemory
docker compose --profile api build open-pencil
docker compose --profile api up -d open-pencil
curl -sI http://localhost:18082/embed.html | head -1
curl -sI http://localhost:18082/embed.html | grep -i content-security-policy
```
Expected: `HTTP/1.1 200 OK`, and a CSP header containing `connect-src 'self'`.

- [ ] **Step 5: Commit**

```bash
cd ~/projects/openmemory
git add docker/open-pencil docker-compose.yml
git commit -m "feat(docker): add offline open-pencil embed service"
```

---

## Task 10: End-to-end and offline verification

**Files:** none created; this task proves the feature works.

**Interfaces:**
- Consumes: everything above.

- [ ] **Step 1: Bring the stack up**

Run:
```bash
cd ~/projects/openmemory
docker compose --profile api up -d
curl -s http://localhost:18080/health
```
Expected: `{"status":"ok"}`.

- [ ] **Step 2: Run every automated test**

Run:
```bash
cd ~/projects/openmemory && cargo test -p openmemory-server design_blobs
cd ~/projects/openmemory/apps/web && node --test lib/pencil.test.ts lib/drawio.test.ts
cd ~/projects/open-pencil && bun run check
```
Expected: all pass. `drawio.test.ts` is included deliberately — it proves the existing diagram types did not regress.

- [ ] **Step 3: Exercise the blob endpoints directly**

Run, substituting a real project and design id and the API token:
```bash
TOKEN="$OPENMEMORY_API_TOKEN"
head -c 1048576 /dev/urandom > /tmp/test.fig
curl -s -X PUT -H "Authorization: Bearer $TOKEN" \
  --data-binary @/tmp/test.fig \
  "http://localhost:18080/projects/$PROJECT_ID/designs/$DESIGN_ID/blob"
curl -s -H "Authorization: Bearer $TOKEN" \
  "http://localhost:18080/projects/$PROJECT_ID/designs/$DESIGN_ID/blob" -o /tmp/roundtrip.fig
cmp /tmp/test.fig /tmp/roundtrip.fig && echo "BLOB ROUND-TRIP OK"
```
Expected: `BLOB ROUND-TRIP OK`. Also confirm a bad design id returns 404 and that an unauthenticated request returns 401.

- [ ] **Step 4: Manual round-trip in the UI**

1. Open a project → Designs tab.
2. Create a design with type OpenPencil, title "Embed smoke test", and save.
3. Reopen it — the embed should load.
4. Draw a rectangle, click OpenMemory's Save.
5. Reload the page and reopen the design.

Expected: the rectangle is still there. Confirm in the database that the row stayed small:
```bash
docker compose exec postgres psql -U openmemory -d openmemory \
  -c "SELECT title, diagram_type, length(source) FROM project_designs WHERE diagram_type='pen';"
```
Expected: `length` is under 200 bytes — proof the bytes went to the volume, not the column.

- [ ] **Step 5: Prove it is offline**

With the design editor open, in DevTools → Network, filter to third-party requests and interact with the editor: draw, select, change colors, open the text tool, type text.

Expected: **zero requests to any non-localhost origin.** Also check the Console for CSP violation reports — any violation names a leak the app config missed, and must be fixed rather than allowlisted.

As a harder proof, disconnect the machine from the network entirely and repeat the round-trip in Step 4. It must work identically.

- [ ] **Step 6: Confirm no regression to existing diagram types**

Open one existing draw.io design, one mermaid design, and one React Flow design. Edit and save each.
Expected: all three behave exactly as before.

- [ ] **Step 7: Commit any fixes**

```bash
cd ~/projects/openmemory
git add -A
git commit -m "fix: address issues found in end-to-end verification"
```

---

## Verification Checklist

- [ ] `.fig` bytes never appear in `project_designs.source` (Task 10 Step 4)
- [ ] Blob round-trips byte-for-byte (Task 10 Step 3)
- [ ] Blob endpoints reject unauthenticated requests and cross-project ids (Task 10 Step 3)
- [ ] Oversized uploads are rejected with 413, not a truncated write (Task 1)
- [ ] Zero non-localhost requests during an editing session (Task 10 Step 5)
- [ ] CSP header present and violation-free (Task 9 Step 4, Task 10 Step 5)
- [ ] Works with the network physically disconnected (Task 10 Step 5)
- [ ] draw.io, mermaid, and React Flow designs unaffected (Task 10 Step 6)
- [ ] `bun run check` passes in the OpenPencil repo (Task 10 Step 2)
- [ ] No database migration was required

## Known Unknowns

These are assumptions the implementer must verify against source rather than trust. Each is flagged inline in its task.

1. **Editor graph accessors** (Task 6) — `editor.loadGraph()` / `editor.getGraph()` are assumed. Confirm against `packages/core/src/editor/create.ts`.
2. **Web-font provider localStorage keys** (Task 4) — the `op-web-font-provider-*` pattern is assumed. Confirm against `packages/core/src/text/web-fonts.ts:93-118`. The CSP is the real backstop, but the setting should genuinely take effect.
3. **`figFormat` export path** (Task 6) — assumed exported from `@open-pencil/core/io`.
4. **`writeDocument` without a renderer** (Task 6) — `renderThumbnail: false` should avoid needing a live renderer. If `exportFigFile` still requires one, the embed must pass its canvas renderer through.
5. **Rust package name** (Task 1) — `openmemory-server` is assumed; read `apps/server/Cargo.toml`.

If any assumption proves wrong, fix the plan's approach rather than working around it with a shim.
