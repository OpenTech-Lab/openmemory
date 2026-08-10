# OpenPencil Embed Interactivity + Transport Fix Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the OpenPencil embed actually usable — wire real pointer/keyboard/text input and a minimal toolbar into the canvas, and fix the embed↔OpenMemory transport so save/load genuinely works — closing the two Critical and five Important findings from the final whole-branch review of the original embed plan.

**Architecture:** Add the app's own interaction composables (`useCanvasInput`, `useTextEdit`) to the embed shell, plus a headless-toolbar-driven tool picker limited to `SELECT`/`RECTANGLE`/`TEXT`. Replace the embed's direct cross-origin fetch to OpenMemory with a same-origin nginx reverse proxy that injects the Bearer token server-side via envsubst — eliminating the CSP/CORS/credentials triangle entirely rather than patching each corner.

**Tech Stack:** Vue 3 (OpenPencil embed); nginx (reverse proxy + envsubst templating); Rust/axum (OpenMemory server); Next.js/React (OpenMemory web, minor changes only).

**Prior work:** `docs/superpowers/plans/2026-08-10-open-pencil-embed.md` (10 tasks, all merged onto
`feat/open-pencil-embed` / `feat/openmemory-embed-shell`, not yet merged to `main`/`master`).
**Spec:** `docs/superpowers/specs/2026-08-10-open-pencil-embed-interactivity-design.md`

## Global Constraints

- **100% offline at runtime**, unchanged from the original plan. The reverse-proxy approach must not weaken `connect-src 'self'` in the embed's CSP — verify this explicitly, don't just assume it holds.
- **Two repositories**, unchanged convention: OpenMemory work happens in `~/projects/openmemory-worktrees/open-pencil-embed` (branch `feat/open-pencil-embed`); OpenPencil work happens in `~/projects/open-pencil-worktrees/openmemory-embed-shell` (branch `feat/openmemory-embed-shell`). Never mix a commit across both.
- **MVP tool scope**: `SELECT`, `RECTANGLE`, `TEXT` only. Pan/zoom needs no toolbar entry — `useCanvasInput` wires `setupPanZoom` unconditionally regardless of active tool (verified: `packages/vue/src/canvas/useCanvasInput.ts:298`, called once at setup, not gated by `HAND`). Do not add `FRAME`, `PEN`, or `HAND` tools — out of scope per the interactivity spec.
- **No new test infrastructure requirement beyond what's stated per task.** `src/embed/**` has no existing interaction tests; this plan does not invent a new test harness — manual browser verification is required for the interactivity tasks specifically, and is not optional (this is the exact gap that let the missing-input bug ship unnoticed the first time).
- **`bun run check`** (OpenPencil repo: oxlint type-aware + tsgo + Steiger) and **`npx tsc --noEmit`** (OpenMemory `apps/web`) remain the compile-time gates, same as the original plan.

---

## File Structure

**OpenPencil (`~/projects/open-pencil-worktrees/openmemory-embed-shell`)**

| path | responsibility |
|---|---|
| `src/embed/EmbedShell.vue` | gains `useCanvasInput` + `useTextEdit` wiring; renders `EmbedToolbar` |
| `src/embed/EmbedToolbar.vue` | **new** — thin visual wrapper around the existing headless `ToolbarRoot`, MVP tool set only |
| `embed.html` | gains a CSS rule so the canvas fills its container |
| `src/embed/bridge.ts` | `load` handler gains full document-load sequence (layout/undo/selection/page/zoomToFit); `storage/openmemory.ts` config drops `baseUrl` |
| `src/embed/protocol.ts` | `EmbedLoadRequest` drops `baseUrl` (no longer needed — same-origin now) |
| `src/embed/storage/openmemory.ts` | `blobUrl()` becomes a same-origin relative path; drop `credentials: 'include'` |
| `vite/pwa.ts` | `navigateFallbackDenylist` added |
| `docker/open-pencil/nginx.conf` | → **moved and renamed** to `docker/open-pencil/nginx.conf.template`; gains the `/api/blob/` reverse-proxy location |

**OpenMemory (`~/projects/openmemory-worktrees/open-pencil-embed`)**

| path | responsibility |
|---|---|
| `apps/web/lib/pencil.ts` | `pencilEmbedSrc()` drops the dead `dark` query param |
| `apps/web/components/pencil-diagram.tsx` | `load` postMessage drops `baseUrl` |
| `apps/server/src/main.rs` | `delete_project_design` gains blob-file cleanup |
| `docker-compose.yml` | `open-pencil` service: bind-mount fix, `OPENMEMORY_API_TOKEN` env, `depends_on: openmemory-server`, `${OPENMEMORY_ROOT:-.}` dockerfile path |

No database migration. No changes to `apps/server/src/design_blobs.rs` (the endpoint itself is correct; only its caller and the path to reach it change).

---

## Task 1: Canvas input wiring

**Files:**
- Modify: `src/embed/EmbedShell.vue`

**Interfaces:**
- Consumes: `useCanvas`, `useCanvasInput`, `useTextEdit`, `useEditor` from `@open-pencil/vue`.
- Produces: an interactive canvas — pointer/keyboard events reach the editor, text can be edited.

- [ ] **Step 1: Rewrite the shell to wire input**

Replace the full contents of `src/embed/EmbedShell.vue`:

```vue
<script setup lang="ts">
import { ref } from 'vue'

import { useCanvas, useCanvasInput, useEditor, useTextEdit } from '@open-pencil/vue'

const canvasRef = ref<HTMLCanvasElement | null>(null)
const editor = useEditor()

const { hitTestSectionTitle, hitTestComponentLabel, hitTestFrameTitle } = useCanvas(canvasRef, editor)
useCanvasInput(canvasRef, editor, hitTestSectionTitle, hitTestComponentLabel, hitTestFrameTitle)
useTextEdit(canvasRef, editor)
</script>

<template>
  <canvas ref="canvasRef" class="size-full" />
</template>
```

This mirrors the app's own `EditorCanvas.vue` minus its app-specific parts (no collab
awareness, no drag-and-drop, no two-layer scene/overlay split — the embed renders on one
canvas). `useCanvasInput`'s five parameters are exactly what `useCanvas` returns plus the
`editor` already in scope; `useCanvasInput` also wires pan/zoom (`setupPanZoom`)
unconditionally, so no `HAND` tool is required for panning or zooming to work.

- [ ] **Step 2: Verify it builds and type-checks**

Run: `cd ~/projects/open-pencil-worktrees/openmemory-embed-shell && bun run check && bunx vite build`
Expected: both PASS.

- [ ] **Step 3: Commit**

```bash
cd ~/projects/open-pencil-worktrees/openmemory-embed-shell
git add src/embed/EmbedShell.vue
git commit -m "fix(embed): wire pointer, keyboard, and text-edit input"
```

---

## Task 2: Minimal toolbar

**Files:**
- Create: `src/embed/EmbedToolbar.vue`
- Modify: `src/embed/EmbedShell.vue`
- Modify: `embed.html`

**Interfaces:**
- Consumes: `ToolbarRoot` from `@open-pencil/vue` (headless — takes a `tools` prop, yields `{ tools, activeTool, actions }` via scoped slot; `actions.setTool` calls `editor.setTool()` internally, confirmed at `packages/vue/src/primitives/Toolbar/ToolbarRoot.vue`). `EDITOR_TOOLS`, `EditorToolDef` from `@open-pencil/core/editor`.
- Produces: a 3-button toolbar (Select, Rectangle, Text) that actually switches the active tool.

- [ ] **Step 1: Write the toolbar component**

Create `src/embed/EmbedToolbar.vue`:

```vue
<script setup lang="ts">
import { EDITOR_TOOLS } from '@open-pencil/core/editor'
import { ToolbarRoot } from '@open-pencil/vue'

// MVP scope: selection, one shape tool, and text. Pan/zoom needs no toolbar entry —
// useCanvasInput wires it unconditionally regardless of active tool.
const MVP_TOOL_KEYS = ['SELECT', 'RECTANGLE', 'TEXT'] as const
const tools = EDITOR_TOOLS.filter((tool) => (MVP_TOOL_KEYS as readonly string[]).includes(tool.key))
</script>

<template>
  <ToolbarRoot :tools="tools" v-slot="{ tools: slotTools, activeTool, actions }">
    <div class="embed-toolbar">
      <button
        v-for="tool in slotTools"
        :key="tool.key"
        type="button"
        :class="{ active: tool.key === activeTool }"
        :title="`${tool.label} (${tool.shortcut})`"
        @click="actions.setTool(tool.key)"
      >
        {{ tool.label }}
      </button>
    </div>
  </ToolbarRoot>
</template>

<style scoped>
.embed-toolbar {
  position: absolute;
  top: 8px;
  left: 8px;
  z-index: 10;
  display: flex;
  gap: 4px;
  padding: 4px;
  background: rgba(30, 30, 30, 0.85);
  border-radius: 6px;
}
.embed-toolbar button {
  padding: 6px 10px;
  border: none;
  border-radius: 4px;
  background: transparent;
  color: #fff;
  cursor: pointer;
  font-size: 12px;
}
.embed-toolbar button.active {
  background: #3b82f6;
}
</style>
```

- [ ] **Step 2: Mount the toolbar in the shell**

Modify `src/embed/EmbedShell.vue` (from Task 1) — wrap the canvas in a positioned container and add the toolbar:

```vue
<script setup lang="ts">
import { ref } from 'vue'

import { useCanvas, useCanvasInput, useEditor, useTextEdit } from '@open-pencil/vue'

import EmbedToolbar from './EmbedToolbar.vue'

const canvasRef = ref<HTMLCanvasElement | null>(null)
const editor = useEditor()

const { hitTestSectionTitle, hitTestComponentLabel, hitTestFrameTitle } = useCanvas(canvasRef, editor)
useCanvasInput(canvasRef, editor, hitTestSectionTitle, hitTestComponentLabel, hitTestFrameTitle)
useTextEdit(canvasRef, editor)
</script>

<template>
  <div class="embed-shell">
    <EmbedToolbar />
    <canvas ref="canvasRef" class="embed-canvas" />
  </div>
</template>

<style scoped>
.embed-shell {
  position: relative;
  width: 100%;
  height: 100%;
}
.embed-canvas {
  width: 100%;
  height: 100%;
  display: block;
}
</style>
```

This also folds in the CSS-sizing fix (Important finding #3 from the final review): the
original `class="size-full"` was a Tailwind utility class that had no effect because the
embed never imports Tailwind's generated CSS. `.embed-canvas { width: 100%; height: 100% }`
in a `<style scoped>` block needs no build-time CSS pipeline — it's plain CSS, compiled by
Vue SFC handling that's already in place.

- [ ] **Step 3: Verify it builds and type-checks**

Run: `cd ~/projects/open-pencil-worktrees/openmemory-embed-shell && bun run check && bunx vite build`
Expected: both PASS.

- [ ] **Step 4: Commit**

```bash
cd ~/projects/open-pencil-worktrees/openmemory-embed-shell
git add src/embed/EmbedToolbar.vue src/embed/EmbedShell.vue
git commit -m "feat(embed): add minimal toolbar (select, rectangle, text)"
```

---

## Task 3: Complete the document-load path

**Files:**
- Modify: `src/embed/bridge.ts`

**Interfaces:**
- Consumes: `computeAllLayouts` from `@open-pencil/core/layout` (verified real export, used identically by the app's own `src/app/document/io/imported-document.ts`).
- Produces: a `load` handler that matches the app's own load sequence — no behavior change to the postMessage protocol itself.

- [ ] **Step 1: Replace the bare `replaceGraph` call with the full sequence**

In `src/embed/bridge.ts`, the `load` case currently does:

```ts
if (bytes.byteLength > 0) {
  if (!figFormat.readDocument) throw new Error('fig format cannot read documents')
  const result = await figFormat.readDocument({ data: bytes, name: `${designId}.fig` })
  editor.replaceGraph(result.graph)
}
```

Replace it with:

```ts
if (bytes.byteLength > 0) {
  if (!figFormat.readDocument) throw new Error('fig format cannot read documents')
  const result = await figFormat.readDocument({ data: bytes, name: `${designId}.fig` })
  const firstPage = result.graph.getPages()[0]
  if (firstPage) computeAllLayouts(result.graph, firstPage.id)
  editor.replaceGraph(result.graph)
  editor.undo.clear()
  editor.clearSelection()
  const pageId = firstPage?.id ?? editor.graph.rootId
  await editor.switchPage(pageId)
  // switchPage restores a per-page saved viewport but does not fit-to-content; give the
  // canvas one paint tick before measuring, matching the app's own
  // fitCurrentPageToViewport (src/app/document/io/browser.ts) — zoomToFit needs the
  // freshly-switched page's geometry to already be laid out and painted once.
  await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()))
  editor.zoomToFit()
}
```

Add the import at the top of `bridge.ts`:

```ts
import { computeAllLayouts } from '@open-pencil/core/layout'
```

This is a verbatim match of what the app's `applyImportedDocument()`
(`src/app/document/io/imported-document.ts`) plus `fitCurrentPageToViewport()`
(`src/app/document/io/browser.ts`) already do — both files live under `src/app/**`, which the
embed cannot import, so this replicates their logic using only public `@open-pencil/core`
exports rather than importing the app's own helper functions.

- [ ] **Step 2: Verify it builds and type-checks**

Run: `cd ~/projects/open-pencil-worktrees/openmemory-embed-shell && bun run check && bunx vite build`
Expected: both PASS.

- [ ] **Step 3: Commit**

```bash
cd ~/projects/open-pencil-worktrees/openmemory-embed-shell
git add src/embed/bridge.ts
git commit -m "fix(embed): complete document-load sequence (layout, undo, selection, viewport)"
```

---

## Task 4: PWA service-worker hijack fix

**Files:**
- Modify: `vite/pwa.ts`

**Interfaces:**
- Consumes: none new.
- Produces: a service worker that never intercepts navigation to `/embed.html`.

- [ ] **Step 1: Add the denylist**

In `vite/pwa.ts`, inside the `workbox` object:

```ts
    workbox: {
      maximumFileSizeToCacheInBytes: 12 * 1024 * 1024,
      globPatterns: ['**/*.{js,css,html,wasm,png,ico,ttf,webmanifest}'],
      navigateFallback: '/index.html',
      navigateFallbackDenylist: [/^\/embed\.html$/]
    },
```

This closes the path where a previously-registered service worker (scope `/`,
`navigateFallback: /index.html`) could intercept a navigation to `/embed.html` and silently
serve the full desktop app inside the iframe instead. The embed's own JS never registers the
service worker (registration only happens from `src/main.ts`, the main app's entry — untouched
by this change), but the same nginx image serves both `index.html` and `embed.html` from one
`dist/`, so a visit to `/` on the embed's own origin could register a SW that then also governs
`/embed.html` navigations. The denylist makes that impossible regardless of registration path.

- [ ] **Step 2: Verify it builds**

Run: `cd ~/projects/open-pencil-worktrees/openmemory-embed-shell && bunx vite build`
Expected: PASS. Confirm the generated service worker (check `dist/sw.js` or equivalent workbox
output) contains the denylist pattern — grep for `embed\\.html` in the built output.

- [ ] **Step 3: Commit**

```bash
cd ~/projects/open-pencil-worktrees/openmemory-embed-shell
git add vite/pwa.ts
git commit -m "fix(embed): prevent service worker from hijacking /embed.html navigation"
```

---

## Task 5: Drop the dead theme query param

**Files:**
- Modify: `apps/web/lib/pencil.ts` (OpenMemory repo)
- Modify: `apps/web/components/pencil-diagram.tsx` (OpenMemory repo)

**Interfaces:**
- Consumes: none new.
- Produces: `pencilEmbedSrc()` with no arguments; a stable iframe `src` that never changes when the user toggles OpenMemory's theme.

- [ ] **Step 1: Simplify `pencilEmbedSrc`**

In `apps/web/lib/pencil.ts`, replace:

```ts
export function pencilEmbedSrc(darkMode = false): string {
  const params = new URLSearchParams({ dark: darkMode ? '1' : '0' });
  return `${PENCIL_EMBED_URL}/embed.html?${params.toString()}`;
}
```

with:

```ts
export function pencilEmbedSrc(): string {
  return `${PENCIL_EMBED_URL}/embed.html`;
}
```

The embed never read the `dark` param (confirmed absent from `src/embed/**` and `embed.html`
by grep during the final review), so it had no visual effect — its only real effect was
forcing `pencil-diagram.tsx`'s `src` (and therefore the iframe itself) to change and reload
whenever OpenMemory's theme changed, discarding any unsaved in-progress edit. Theme-following
for the embed is out of scope for this plan (YAGNI — the embed's own UI is minimal chrome, not
worth a new protocol message for a cosmetic property nothing currently uses).

- [ ] **Step 2: Update the caller**

In `apps/web/components/pencil-diagram.tsx`, remove the now-unused theme plumbing:

```ts
    const { resolvedTheme } = useTheme();
    const isDark = resolvedTheme === 'dark';
```

and

```ts
    const src = useMemo(() => pencilEmbedSrc(isDark), [isDark]);
```

become:

```ts
    const src = useMemo(() => pencilEmbedSrc(), []);
```

Remove the now-unused `useTheme` import if nothing else in the file uses `resolvedTheme`/`isDark`
— check before deleting the import (`isDark` was used only in this one place per the current
file content).

- [ ] **Step 3: Verify it type-checks**

Run: `cd ~/projects/openmemory-worktrees/open-pencil-embed/apps/web && npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 4: Commit**

```bash
cd ~/projects/openmemory-worktrees/open-pencil-embed
git add apps/web/lib/pencil.ts apps/web/components/pencil-diagram.tsx
git commit -m "fix(web): stop reloading the pencil iframe on theme toggle"
```

---

## Task 6: nginx reverse proxy — replace direct cross-origin fetch

**Files:**
- Create: `docker/open-pencil/nginx.conf.template` (replaces `docker/open-pencil/nginx.conf` — OpenMemory repo)
- Modify: `docker-compose.yml` (OpenMemory repo)
- Modify: `src/embed/protocol.ts` (OpenPencil repo)
- Modify: `src/embed/bridge.ts` (OpenPencil repo)
- Modify: `src/embed/storage/openmemory.ts` (OpenPencil repo)
- Modify: `apps/web/components/pencil-diagram.tsx` (OpenMemory repo)

**Interfaces:**
- Consumes: nothing new from earlier tasks in this plan.
- Produces: the embed's storage adapter calls a same-origin path (`/api/blob/{projectId}/{designId}`); nginx forwards it to `openmemory-server:18080/projects/{projectId}/designs/{designId}/blob` with the Bearer token injected server-side.

This is the one task in this plan that must be done as a single unit across both repos — the
protocol change (dropping `baseUrl`) and the proxy that makes the shorter URL meaningful are
two halves of one change. Commit each repo's half separately, but implement and verify them
together before considering either done.

- [ ] **Step 1: Convert the nginx config to a template**

Rename `docker/open-pencil/nginx.conf` to `docker/open-pencil/nginx.conf.template` and replace
its contents:

```nginx
server {
    listen 80;
    listen [::]:80;
    server_name _;
    root /usr/share/nginx/html;

    client_max_body_size 128M;
    resolver 127.0.0.11 valid=10s;

    # The offline guarantee. Configuration flags inside the app stop it from *trying* to
    # reach the network; this stops it from *succeeding* if a future upstream change
    # reintroduces a fetch. 'wasm-unsafe-eval' is required to instantiate CanvasKit.
    # connect-src stays 'self': the embed's own fetch to /api/blob/... never leaves this
    # origin — nginx, not the browser, makes the cross-service hop below.
    add_header Content-Security-Policy "default-src 'self'; connect-src 'self'; font-src 'self'; img-src 'self' data: blob:; script-src 'self' 'wasm-unsafe-eval'; style-src 'self' 'unsafe-inline'; frame-ancestors *" always;

    # Proxies the embed's own same-origin fetch through to OpenMemory's Rust server,
    # injecting the Bearer token here (server-side, via envsubst below) so the token never
    # reaches the browser. `resolver` above is required specifically because this
    # proxy_pass target contains variables (nginx defers hostname resolution to request
    # time in that case, and request-time resolution needs an explicit resolver — Docker's
    # embedded DNS at 127.0.0.11 — rather than the static resolution used for a bare
    # hostname proxy_pass). Verified end-to-end against a live upstream during planning:
    # GET/PUT both round-trip correctly, auth header lands, $uri elsewhere in this file is
    # untouched by the envsubst pass since `uri` is never itself an environment variable.
    location ~ ^/api/blob/(?<project_id>[^/]+)/(?<design_id>[^/]+)$ {
        proxy_pass http://openmemory-server:18080/projects/$project_id/designs/$design_id/blob;
        proxy_set_header Authorization "Bearer ${OPENMEMORY_API_TOKEN}";
    }

    location / {
        try_files $uri $uri/ =404;
    }

    types {
        application/wasm wasm;
    }
}
```

- [ ] **Step 2: Update the Dockerfile's nginx config handling**

`docker/open-pencil/Dockerfile` currently doesn't `COPY` `nginx.conf` (it's bind-mounted at
runtime per the original Task 9). With the rename to `.template`, the bind-mount target must
change too — this is entirely a `docker-compose.yml` change (Step 3), not a Dockerfile change,
since nginx's official image auto-processes anything under `/etc/nginx/templates/*.template`
via its own entrypoint script (`20-envsubst-on-templates.sh`) — no custom ENTRYPOINT/CMD
needed. Confirmed: the Dockerfile's final stage is only `FROM nginx:1.27-alpine` + `COPY --from=build`,
no `ENTRYPOINT`/`CMD` override — the base image's own entrypoint runs untouched, no
Dockerfile change is required for this step.

- [ ] **Step 3: Update `docker-compose.yml`**

Modify the `open-pencil` service. Current relevant block:

```yaml
  open-pencil:
    profiles: [api]
    build:
      context: ${OPEN_PENCIL_PATH:-../open-pencil}
      dockerfile: ${PWD}/docker/open-pencil/Dockerfile
      args:
        OPENMEMORY_WEB_ORIGIN: ${OPENMEMORY_WEB_ORIGIN:-http://localhost:13000}
    ports:
      - "127.0.0.1:${OPEN_PENCIL_PORT:-18082}:80"
    volumes:
      - ${PWD}/docker/open-pencil/nginx.conf:/etc/nginx/conf.d/default.conf:ro
    healthcheck:
      test: ["CMD-SHELL", "wget -q -O /dev/null http://localhost/embed.html || exit 1"]
      interval: 5s
      timeout: 5s
      retries: 10
    restart: unless-stopped
```

Replace with:

```yaml
  open-pencil:
    profiles: [api]
    build:
      context: ${OPEN_PENCIL_PATH:-../open-pencil}
      # dockerfile: is resolved relative to `context:` (a sibling checkout, not this repo),
      # so it cannot be a bare relative path here — verified empirically during planning
      # that Compose has no built-in "relative to this compose file" variable for this
      # field specifically (unlike `context:` and `volumes:` host paths, which Compose DOES
      # resolve against the compose file's own directory regardless of invocation cwd).
      # OPENMEMORY_ROOT documents the real constraint (this compose file expects to be
      # invoked from the OpenMemory repo root) instead of silently depending on $PWD.
      dockerfile: ${OPENMEMORY_ROOT:-.}/docker/open-pencil/Dockerfile
      args:
        OPENMEMORY_WEB_ORIGIN: ${OPENMEMORY_WEB_ORIGIN:-http://localhost:13000}
    ports:
      - "127.0.0.1:${OPEN_PENCIL_PORT:-18082}:80"
    environment:
      # Injected into the nginx config by the base image's envsubst-on-templates
      # entrypoint (see nginx.conf.template) — never reaches the browser.
      OPENMEMORY_API_TOKEN: ${OPENMEMORY_API_TOKEN}
    volumes:
      # Bare relative path: Compose resolves this against the compose file's own
      # directory regardless of invocation cwd (verified empirically during planning),
      # unlike the dockerfile: path above. Mounted into /etc/nginx/templates/ (not
      # conf.d/) so the base image's own entrypoint script performs the envsubst pass.
      - ./docker/open-pencil/nginx.conf.template:/etc/nginx/templates/default.conf.template:ro
    depends_on:
      # proxy_pass's target contains variables (the path-rewrite captures), which makes
      # nginx defer DNS resolution to request time via the `resolver` directive rather
      # than resolving once at config load — but nginx still needs `openmemory-server` to
      # exist on the network. Verified during planning: a `proxy_pass` to a completely
      # unresolvable static hostname fails nginx startup outright; ordering after
      # openmemory-server's healthcheck avoids that failure mode in normal `docker compose
      # up` bring-up.
      openmemory-server:
        condition: service_healthy
    healthcheck:
      test: ["CMD-SHELL", "wget -q -O /dev/null http://localhost/embed.html || exit 1"]
      interval: 5s
      timeout: 5s
      retries: 10
    restart: unless-stopped
```

- [ ] **Step 4: Drop `baseUrl` from the protocol**

In OpenPencil's `src/embed/protocol.ts`:

```ts
export interface EmbedLoadRequest {
  action: 'load'
  projectId: string
  designId: string
}
```

Update `parseEmbedRequest`'s `load` branch to stop requiring/reading `baseUrl`:

```ts
  if (record.action === 'load') {
    const { projectId, designId } = record
    if (typeof projectId !== 'string' || typeof designId !== 'string') {
      return null
    }
    return { action: 'load', projectId, designId }
  }
```

- [ ] **Step 5: Update the storage adapter to use the same-origin path**

In OpenPencil's `src/embed/storage/openmemory.ts`:

```ts
export interface OpenMemoryStorageConfig {
  projectId: string
  designId: string
}
```

```ts
export function createOpenMemoryStorageAdapter(config: OpenMemoryStorageConfig): StorageAdapter {
  const blobUrl = () => `/api/blob/${config.projectId}/${config.designId}`
```

Drop `credentials: 'include'` from all three `fetch()` calls (`testConnection`, `getDocument`,
`putDocument`) — auth is now nginx's responsibility (it injects the Bearer token server-side),
not the browser's, and there is no cookie session for the embed's own origin to send.

- [ ] **Step 6: Update the bridge's `load` handler call site**

In OpenPencil's `src/embed/bridge.ts`, the `load` case currently does:

```ts
        adapter = createOpenMemoryStorageAdapter({
          baseUrl: request.baseUrl,
          projectId: request.projectId,
          designId: request.designId
        })
```

Drop `baseUrl`:

```ts
        adapter = createOpenMemoryStorageAdapter({
          projectId: request.projectId,
          designId: request.designId
        })
```

- [ ] **Step 7: Update the OpenMemory-side caller**

In OpenMemory's `apps/web/components/pencil-diagram.tsx`, the `ready` handler currently sends:

```ts
          frameWindow.postMessage(
            JSON.stringify({
              action: 'load',
              baseUrl: window.location.origin,
              projectId,
              designId,
            }),
            targetOrigin,
          );
```

Drop `baseUrl`:

```ts
          frameWindow.postMessage(
            JSON.stringify({
              action: 'load',
              projectId,
              designId,
            }),
            targetOrigin,
          );
```

- [ ] **Step 8: Verify the proxy end-to-end**

This step needs the real stack running, not just a build. From the OpenMemory worktree, with
`OPEN_PENCIL_PATH` pointed at the OpenPencil worktree (matching the original plan's Task 10
setup):

```bash
cd ~/projects/openmemory-worktrees/open-pencil-embed
export OPEN_PENCIL_PATH=/home/toyofumi/projects/open-pencil-worktrees/openmemory-embed-shell
export OPENMEMORY_ROOT=$(pwd)
docker compose --profile api up -d --build open-pencil
```

Then, with a real project/design id and the API token:

```bash
TOKEN="$OPENMEMORY_API_TOKEN"
head -c 1048576 /dev/urandom > /tmp/proxy-test.fig
curl -s -X PUT --data-binary @/tmp/proxy-test.fig \
  "http://localhost:18082/api/blob/$PROJECT_ID/$DESIGN_ID"
curl -s "http://localhost:18082/api/blob/$PROJECT_ID/$DESIGN_ID" -o /tmp/proxy-roundtrip.fig
cmp /tmp/proxy-test.fig /tmp/proxy-roundtrip.fig && echo "PROXY ROUND-TRIP OK"
```

Expected: `PROXY ROUND-TRIP OK`, with no `Authorization` header supplied by curl at all — proof
the token injection happens inside nginx, not the caller.

- [ ] **Step 9: Verify builds and type-checks in both repos**

Run:
```bash
cd ~/projects/open-pencil-worktrees/openmemory-embed-shell && bun run check && bunx vite build
cd ~/projects/openmemory-worktrees/open-pencil-embed/apps/web && npx tsc --noEmit
```
Expected: all PASS.

- [ ] **Step 10: Commit — one commit per repo**

```bash
cd ~/projects/open-pencil-worktrees/openmemory-embed-shell
git add src/embed/protocol.ts src/embed/bridge.ts src/embed/storage/openmemory.ts
git commit -m "fix(embed): call OpenMemory through the same-origin nginx proxy, not cross-origin"

cd ~/projects/openmemory-worktrees/open-pencil-embed
git add docker/open-pencil/nginx.conf.template docker-compose.yml apps/web/components/pencil-diagram.tsx
git rm docker/open-pencil/nginx.conf
git commit -m "feat(docker): reverse-proxy the embed's blob calls, injecting auth server-side"
```

---

## Task 7: Orphaned blob cleanup on delete

**Files:**
- Modify: `apps/server/src/main.rs` (OpenMemory repo)

**Interfaces:**
- Consumes: `blob_path`, `blob_root` from `crate::design_blobs` (already `pub`, built in the original plan's Task 1).
- Produces: `delete_project_design` removes the on-disk blob file (if any) after a successful row delete.

- [ ] **Step 1: Add cleanup to the delete handler**

Current `delete_project_design` (`apps/server/src/main.rs`):

```rust
async fn delete_project_design(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path((project_id, design_id)): Path<(Uuid, Uuid)>,
) -> impl IntoResponse {
    if !is_authenticated(&headers, &state.api_token) {
        return (StatusCode::UNAUTHORIZED, Json(serde_json::json!({"error": "unauthorized"}))).into_response();
    }

    let result = sqlx::query("DELETE FROM project_designs WHERE id = $1 AND project_id = $2 RETURNING id")
        .bind(design_id)
        .bind(project_id)
        .fetch_optional(&state.db)
        .await;

    match result {
        Ok(Some(_)) => Json(serde_json::json!({"deleted": design_id})).into_response(),
        Ok(None) => (StatusCode::NOT_FOUND, Json(serde_json::json!({"error": "design not found"}))).into_response(),
        Err(e) => {
            error!("delete_project_design error: {e}");
            (StatusCode::INTERNAL_SERVER_ERROR, Json(serde_json::json!({"error": e.to_string()}))).into_response()
        }
    }
}
```

Replace the `Ok(Some(_))` arm:

```rust
    match result {
        Ok(Some(_)) => {
            // Best-effort: a design's blob is optional (non-`pen` designs never had one,
            // and a `pen` design that was never saved has none either), so a missing file
            // is not an error. The row delete already succeeded and is not rolled back on
            // a cleanup failure — an orphaned blob is a disk-space leak, not a correctness
            // or security problem, so it must never block the delete response.
            let path = crate::design_blobs::blob_path(&crate::design_blobs::blob_root(), design_id);
            if let Err(e) = tokio::fs::remove_file(&path).await {
                if e.kind() != std::io::ErrorKind::NotFound {
                    error!("delete_project_design: failed to remove blob {path:?}: {e}");
                }
            }
            Json(serde_json::json!({"deleted": design_id})).into_response()
        }
        Ok(None) => (StatusCode::NOT_FOUND, Json(serde_json::json!({"error": "design not found"}))).into_response(),
        Err(e) => {
            error!("delete_project_design error: {e}");
            (StatusCode::INTERNAL_SERVER_ERROR, Json(serde_json::json!({"error": e.to_string()}))).into_response()
        }
    }
```

- [ ] **Step 2: Write a test**

Add to `apps/server/src/design_blobs.rs`'s existing test module:

```rust
    #[tokio::test]
    async fn removing_a_nonexistent_blob_is_not_an_error() {
        let dir = std::env::temp_dir().join(format!("blob-delete-test-{}", Uuid::new_v4()));
        let id = Uuid::new_v4();
        let path = blob_path(&dir, id);
        // The directory doesn't even exist yet — this must not panic or need special-casing
        // beyond the NotFound check already in delete_project_design.
        let result = tokio::fs::remove_file(&path).await;
        assert!(result.is_err());
        assert_eq!(result.unwrap_err().kind(), std::io::ErrorKind::NotFound);
    }
```

- [ ] **Step 3: Run the tests**

Run: `cd ~/projects/openmemory-worktrees/open-pencil-embed && cargo test -p openmemory-server design_blobs`
Expected: all pass, including the new test. (Confirm the actual package name from
`apps/server/Cargo.toml` if `openmemory-server` doesn't match.)

- [ ] **Step 4: Commit**

```bash
cd ~/projects/openmemory-worktrees/open-pencil-embed
git add apps/server/src/main.rs apps/server/src/design_blobs.rs
git commit -m "fix(server): clean up the blob file when a design is deleted"
```

---

## Verification Checklist

- [ ] A user can open a `pen` design, select the Rectangle tool, draw a rectangle, select the Text tool, add text, and switch back to Select to move them — all in a real browser.
- [ ] Save writes real content (not an empty document) — confirm via `curl`ing the blob endpoint directly after a save and checking its size is nonzero.
- [ ] Reload shows the same content, correctly positioned and with correct fonts (Task 3's load-path fix).
- [ ] Toggling OpenMemory's light/dark theme does not reload the embed iframe or discard unsaved work.
- [ ] `docker compose -f <absolute path to docker-compose.yml> --profile api config` succeeds when invoked from a directory other than the repo root (proves the path-resolution fix is real, not just "worked once from the right cwd").
- [ ] Visiting `http://localhost:18082/` directly (not through the OpenMemory iframe) and then navigating to `/embed.html` does not load the full desktop app — the PWA fix holds even if someone visits the embed's root by mistake.
- [ ] Deleting a `pen` design removes its blob file from `/data/design-blobs` on the server.
- [ ] DevTools Network panel, during a full draw-and-save session: zero requests to any non-`localhost:18082` origin — the reverse proxy must not have reintroduced a cross-origin call anywhere.
- [ ] `bun run check` passes in the OpenPencil repo; `npx tsc --noEmit` passes in `apps/web`; `cargo test -p openmemory-server` passes.
- [ ] No regression to draw.io, mermaid, or React Flow designs (open one of each, confirm still editable and savable).

## Known Unknowns

1. **Cargo package name** (Task 7) — `openmemory-server` is assumed from the original plan;
   confirm against `apps/server/Cargo.toml` if the test command fails to resolve the package.

Everything else in this plan — the nginx rewrite regex, the envsubst/`$uri` interaction, the
`resolver` requirement, the `dockerfile:`-vs-`volumes:` path-resolution difference, the
Dockerfile's entrypoint chain, the exact `useCanvasInput`/`useCanvas`/`useTextEdit`/`ToolbarRoot`
signatures, and the document-load sequence — was verified against real source or a real
running container during planning, not assumed.
