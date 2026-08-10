# OpenPencil Embed: Interactivity + Transport Fix

**Date:** 2026-08-10
**Status:** Approved design, not yet implemented
**Supersedes gaps found in:** `2026-08-10-open-pencil-embed-design.md`, closed by the final
whole-branch reviews of `feat/open-pencil-embed` (OpenMemory) and
`feat/openmemory-embed-shell` (OpenPencil)

## Why this exists

The original embed plan (10 tasks, all individually reviewed and merged onto their feature
branches) shipped a working blob-storage backend, a reviewed postMessage protocol, and a
verified offline/security posture — but the final whole-branch review found the feature
does not work end-to-end:

1. **The canvas has no input wiring.** `EmbedShell.vue` calls `useCanvas` (render + hit-test)
   but never `useCanvasInput`/`useTextEdit`, and there's no toolbar. The editor renders but
   nothing can be drawn, selected, or typed. Every save round-trip verified so far moved an
   empty document.
2. **No working transport exists between the embed and OpenMemory.** No proxy route, and the
   embed's own offline CSP (`connect-src 'self'`) would block a cross-origin call to
   OpenMemory's origin even if one existed. The auth model (`credentials: 'include'`) also
   doesn't match OpenMemory's Bearer-token pattern.

Per-task review couldn't catch either: (1) was scoped as "canvas-only shell" in the original
brief without recognizing that rendering and interactivity are separate composables; (2) is a
seam between a server task (blob endpoints) and two embed tasks (storage adapter, bridge) that
no single task owned.

This spec also folds in every Important-tier finding from both final reviews, since they're
cheap relative to the two Critical items and touch the same files.

## Scope

- **In scope:** canvas interactivity (select/rectangle/text/pan-zoom), the toolbar to drive
  it, the transport fix, and all Important-tier findings below.
- **Out of scope (unchanged from the original spec):** full tool parity with the desktop app,
  agent-driven `.fig` editing, real-time collaboration, thumbnail previews.

## 1. Canvas interactivity

**`EmbedShell.vue`** gains the composables the app's own `EditorCanvas.vue` uses, minus the
app-specific parts (no collab awareness, no drag-and-drop, no two-layer scene/overlay split —
the embed renders on one canvas):

```
const { hitTestSectionTitle, hitTestComponentLabel, hitTestFrameTitle } =
  useCanvas(canvasRef, editor)
useCanvasInput(canvasRef, editor, hitTestSectionTitle, hitTestComponentLabel, hitTestFrameTitle)
useTextEdit(canvasRef, editor)
```

`useCanvasInput`'s five required args are exactly what `useCanvas` already returns plus the
`editor` instance already in scope — no new state to invent.

**CSS.** `embed.html` gets a rule making the canvas fill its container
(`#embed-root > canvas { width: 100%; height: 100%; display: block }`) — no Tailwind import
needed, matching the embed's existing "no `src/app.css`" posture.

**Toolbar.** New `EmbedToolbar.vue`, built on the existing headless `ToolbarRoot`
(`packages/vue/src/primitives/Toolbar/ToolbarRoot.vue` — already renderless, already handles
active-tool state and `editor.setTool()` via a scoped slot). Pass a filtered tool list instead
of the app's full `EDITOR_TOOLS`:

```ts
const MVP_TOOLS = EDITOR_TOOLS.filter(t => ['SELECT', 'RECTANGLE', 'TEXT', 'HAND'].includes(t.key))
```

`EmbedToolbar.vue` renders four buttons from `ToolbarRoot`'s scoped slot (`tools`,
`activeTool`, `actions.setTool`) — no new tool-state logic, only markup. Verify during
implementation whether `HAND`/pan-zoom needs explicit tool selection or works passively
via scroll/trackpad regardless of active tool; adjust the button set if the latter turns out
true (see Known Unknowns).

## 2. Transport: nginx reverse proxy, not a Next.js route

Rejected alternative: widen the embed's CSP to `connect-src 'self' <OpenMemory origin>` and
build a Next.js proxy route in `apps/web`. This keeps three separate concerns
(CSP exception, new route, CORS + credentials reconciliation) that all have to independently
succeed. The reverse-proxy approach collapses the seam to one config change and needs neither
a CSP exception nor CORS, since the embed's fetch never leaves its own origin.

**Mechanism:**
- `docker/open-pencil/nginx.conf` → `nginx.conf.template`, using nginx's official
  `docker-entrypoint.d/20-envsubst-on-templates.sh` mechanism (any `/etc/nginx/templates/*.template`
  is envsubst'd into `/etc/nginx/conf.d/` at container start).
- New `location /api/blob/` block, `proxy_pass http://openmemory-server:18080/projects/`
  (reachable by service name over the existing compose network), rewriting the path to match
  the Rust route (`/projects/:id/designs/:design_id/blob`).
- `proxy_set_header Authorization "Bearer ${OPENMEMORY_API_TOKEN}"` — nginx injects the token
  server-side from an env var; **the token never reaches the browser**, and the embed's fetch
  target becomes same-origin (`/api/blob/...` on its own `localhost:18082`), so `connect-src
  'self'` needs no change.
- `docker-compose.yml`: pass `OPENMEMORY_API_TOKEN` into the `open-pencil` service's
  `environment:` (it already exists as a compose-level variable for `web`/`openmemory-server`).
- `src/embed/storage/openmemory.ts`: `blobUrl()` becomes a same-origin relative path
  (`/api/blob/{projectId}/{designId}`... exact shape TBD at implementation, see Known
  Unknowns) instead of `${baseUrl}/api/projects/...`; drop `credentials: 'include'` entirely
  (auth is now nginx's job, not the browser's).
- `pencil-diagram.tsx`'s `load` postMessage no longer needs to send `baseUrl` — the embed
  talks to itself. Simplify the protocol accordingly (`projectId`/`designId` only).

## 3. Load-path completeness

`bridge.ts`'s `load` handler currently only calls `editor.replaceGraph(result.graph)`. Match
what the app's own load paths do (`src/app/document/io/imported-document.ts`,
`src/app/document/io/read.ts`): `computeAllLayouts(...)` before replacing → `editor.undo.clear()`
→ `clearSelection()` → `await editor.switchPage(pageId)` (this is also what triggers font
loading for the page, per `packages/core/src/editor/pages.ts`) → `editor.zoomToFit()`. Without
this, a reloaded design has stale layout, missing fonts, and content that may sit off-screen.

## 4. Remaining Important-tier fixes

- **PWA hijack risk.** `vite/pwa.ts`'s workbox config gets
  `navigateFallbackDenylist: [/^\/embed\.html$/]`, or the embed's Docker image excludes
  `index.html`/`sw.js` entirely from what nginx serves — whichever is simpler once the build
  output is inspected.
- **Dead theme param.** `dark=0|1` in the iframe `src` reloads the whole iframe on toggle
  (discarding unsaved work) and the embed never reads it anyway. Drop it from `pencilEmbedSrc()`
  and, if theme-following matters, send it over the existing postMessage channel instead
  (embed can react to a `theme` field on the `load` message, or a new lightweight message) —
  no iframe reload either way.
- **Orphaned blobs.** `delete_project_design` (`apps/server/src/main.rs`) gains a best-effort
  `remove_file(blob_path(...))` after the row delete succeeds.
- **`docker-compose.yml` `${PWD}` bug.** `build.dockerfile` and the `nginx.conf` bind-mount
  path use `${PWD}`, which resolves to the invoking shell's cwd, not the compose file's
  location — breaks under `docker compose -f /path/to/file ...`. Resolve relative to the
  compose file properly (Docker Compose resolves `dockerfile:` relative to `context:` when
  given as a bare relative path — restructure so the Dockerfile lives under the build context,
  or use an explicit `${OPENMEMORY_ROOT:-.}`-style variable documented in the compose file).

## Known Unknowns

Flagging rather than guessing, per this project's established practice:

1. **Exact `/api/blob/` path rewrite.** The Rust route is `/projects/:id/designs/:design_id/blob`
   (no `/api` prefix — that's a Next.js convention, not one the Rust server uses). The nginx
   `location`/`rewrite` needs to map `/api/blob/{projectId}/{designId}` → `/projects/{projectId}/designs/{designId}/blob`
   correctly, verified against nginx's actual rewrite semantics, not assumed.
2. **Whether `HAND` needs explicit selection for pan/zoom**, or whether scroll/trackpad pan
   and zoom work regardless of active tool (common in canvas editors) — check
   `useCanvasInput`'s implementation before committing to 4 toolbar buttons vs. 3.
3. **PWA fix mechanism** — denylist vs. excluding `index.html`/`sw.js` from the served image —
   decide based on what's actually simplest once `dist/` output is inspected during
   implementation.
4. **Theme-follow mechanism**, if kept at all — postMessage field on an existing message vs. a
   new message type. Minor implementation detail, not a design fork.

## Testing

- `useCanvasInput`/`useTextEdit`/toolbar wiring: no existing test infrastructure for
  `src/embed/**` interaction (confirmed absent in the original implementation). Manual
  browser verification is required here — this is exactly the gap that let the missing-input
  bug ship unnoticed; do not mark this done from `bun run check` alone.
- Transport: `docker compose exec open-pencil curl -s http://localhost/api/blob/<project>/<design>`
  style checks from inside the network, plus the real manual round-trip (draw, save, reload)
  that Task 10 of the original plan never got to run.
- Offline re-verification: confirm the nginx proxy addition doesn't introduce a new
  CSP-relevant directive — proxying to a docker-internal hostname is not a runtime network
  request to an external host, but state this explicitly in the plan's verification checklist
  so it isn't missed.
