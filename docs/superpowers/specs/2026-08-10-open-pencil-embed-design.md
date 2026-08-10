# OpenPencil Embed in Project Designs

**Date:** 2026-08-10
**Status:** Approved design, not yet implemented

## Goal

Add [OpenPencil](https://github.com/open-pencil) as a UI/UX design surface inside the
project detail page (`/projects/{id}` → Designs tab), alongside the existing draw.io,
mermaid, and React Flow diagram types. Users and agents create and edit real UI/UX
designs without leaving OpenMemory.

The integration follows the pattern already established by the draw.io integration:
vendor an open-source editor, self-host it, embed it in an iframe, and drive it over a
postMessage protocol. It is **not** a rewrite of OpenPencil and **not** a link-out.

## Hard requirements

1. **100% offline at runtime.** No request leaves the machine while the editor is in
   use. Enforced by CSP, not by configuration alone.
2. **No regression to existing diagram types.** draw.io, mermaid, React Flow, and the
   derived architecture canvas keep working unchanged.
3. **Design records stay small.** The `project_designs.source` column continues to hold
   kilobyte-scale text for every diagram type, including this one.

Network access at Docker image *build* time is acceptable (`bun install`,
`canvaskit-wasm` download). Only the running application is guaranteed offline.

## Key findings that shaped this design

These were verified against the OpenPencil checkout at `~/projects/open-pencil` and are
the reason several obvious-looking approaches were rejected.

### `.pen` is import-only — the native format is `.fig`

`penFormat` in `packages/core/src/io/formats.ts:201` is
`role: 'interchange-document'` with `support: { readDocument: true }`. There is no
`.pen` writer anywhere in the repository — `packages/pen/src/index.ts` exports only
`parsePenFile` and `readPenFile`.

OpenPencil's native round-trippable format is `.fig` (`figFormat`,
`role: 'native-document'`, `readDocument` + `writeDocument`), which is **binary**
(`application/octet-stream`), produced by `exportFigFile()` via a worker.

Any design that assumes we can save `.pen` JSON is unimplementable.

### `.fig` files are far too large for the `source` column

Real fixtures in the OpenPencil repo (sizes read from their git-lfs pointers):

| fixture | size |
|---|---|
| `tests/fixtures/gold-preview.fig` | 0.5 MB |
| `tests/fixtures/material3.fig` | 54.7 MB |
| `tests/fixtures/nuxtui.fig` | 81.7 MB |

Base64 adds ~33%, so a single design could push **~109 MB** through a JSON request
body, into a `TEXT` column that today holds kilobyte-scale mermaid and mxGraph strings,
and into a React state string. Storing `.fig` in `source` is rejected.

### There is no autosave-to-server today

In `components/project-design-panel.tsx:455`, draw.io's `autosave` message only updates
local React state (`editForm.source`). Persistence is an explicit **Save** button →
`handleSave()` → `flushSource()` → a single `PUT`/`POST`. This design matches that flow
exactly rather than introducing a new autosave path.

### No `SharedArrayBuffer`

OpenPencil uses ordinary module workers with transferables, not `SharedArrayBuffer`.
No COOP/COEP cross-origin-isolation headers are required to iframe it — a real
embedding risk that turns out not to apply.

### Three runtime network dependencies must be closed

| source | location | default |
|---|---|---|
| Web fonts (google, fontsource, bunny, fontshare) | `packages/core/src/text/web-fonts.ts:12`, key at `constants.ts:342` | **enabled** (`op-online-fonts-enabled`, default `true`) |
| CJK fallback fonts (Noto Sans SC/TC/JP/KR) | `packages/core/src/text/fallbacks.ts:109` — declared as `remoteFamilies` | fetched on demand |
| Iconify icon collections and search | `packages/core/src/icons/api.ts:5` | live fetch |

Everything else is already local: CanvasKit `.wasm` resolves same-origin from
`BASE_URL` (`packages/core/src/canvaskit.ts:20`) and is copied into `public/` by
`vite/canvaskit-assets.ts`; Inter and NotoNaskhArabic ship as `.ttf` in `public/`.
AI providers, Unsplash/Pexels, and Recraft/fal vectorize are opt-in and inert without
credentials.

## Architecture

Three new pieces, plus small edits to existing files.

```
┌─ OpenMemory web (Next.js) ─────────────────────────────┐
│  project-design-panel.tsx                              │
│    └── pencil-diagram.tsx  ──iframe──┐                 │
└──────────────────────────────────────┼─────────────────┘
                                       │ postMessage
┌─ open-pencil service (nginx) ────────▼─────────────────┐
│  src/embed/  — minimal editor shell, CSP-locked        │
│    └── storage adapter ──HTTP──┐                       │
└────────────────────────────────┼───────────────────────┘
                                 │
┌─ OpenMemory server (Rust) ─────▼───────────────────────┐
│  /api/projects/{id}/designs/{did}/blob  (GET/PUT)      │
│    └── /data/design-blobs/{design_id}.fig  (volume)    │
└────────────────────────────────────────────────────────┘
```

### 1. Embed shell (new, in the OpenPencil checkout)

A new `src/embed/` Vite entrypoint: `createEditor()` plus a canvas via
`@open-pencil/vue`, with no tabs, file browser, settings, or desktop chrome. The Vue
SDK is explicitly designed for this — `packages/docs/programmable/index.md` describes
OpenPencil as "a toolkit: something you can embed into other products."

It speaks a postMessage protocol modeled on draw.io's, so `pencil-diagram.tsx` can
mirror `drawio-diagram.tsx` closely:

| message | direction | payload |
|---|---|---|
| `ready` | embed → parent | — |
| `load` | parent → embed | `{ documentId, blobUrl, theme }` — a *reference*, not bytes |
| `save` | parent → embed | request to flush |
| `saved` | embed → parent | `{ documentId }` after bytes are written to storage |
| `error` | embed → parent | `{ error }` |

The embed must satisfy OpenPencil's `bun run check` gate, including Steiger
architecture lint and its import-boundary rules.

### 2. Storage: custom provider, no S3 credentials in the browser

`StorageAdapter` (`src/app/integrations/storage/types.ts`) is a plain interface —
`getDocument(id) → Uint8Array`, `putDocument(id, bytes, metadata)`, `deleteDocument`,
optional thumbnails, progress callbacks — resolved through `storageProviderRegistry`.
`createActiveStorageAdapter()` builds one from
`{ preferences, credentials: CredentialResolver, profileId }`, and `CredentialResolver`
is a one-method interface (`resolve(ref) => Promise<string | null>`).

The embed therefore registers a small **`openmemory` storage provider** whose adapter
`GET`s and `PUT`s against OpenMemory's own API. The OpenMemory server persists bytes to
a mounted volume at `/data/design-blobs/{design_id}.fig`.

This is chosen over pointing OpenPencil's built-in S3 adapter directly at object storage
(which `client.ts:37` does support — path-style URLs explicitly work with MinIO)
because the S3 route would require handing S3 credentials to frontend-reachable
JavaScript. The custom provider keeps all credentials server-side.

**Why a filesystem volume rather than MinIO.** Once the custom provider is chosen, the
OpenMemory server is already the component carrying the bytes, so the backing store is
a private implementation detail. `apps/server/Cargo.toml` has no S3 client — only
`reqwest` — so MinIO would mean adding either the heavy `aws-sdk-s3` dependency tree or
hand-rolled SigV4, plus an eighth container alongside postgres, opensearch, redis,
falkordb, drawio, web, and server. A volume needs neither. Postgres `BYTEA` was also
rejected: it is transactionally tidy but puts 80 MB blobs into the WAL and every backup.

Swapping the volume for S3 later is a change confined to the blob handler.

It also bypasses the settings UI and the WebCrypto/IndexedDB credential store
entirely: the embed is configured wholly by the parent at `load` time, and persists no
secrets in the browser.

### 3. Docker services

One new service in `docker-compose.yml`, following the existing `drawio` service
conventions (`profiles: [api]`, healthcheck, `127.0.0.1`-bound port):

- **`open-pencil`** — unlike draw.io's read-only static mount, this needs a build stage
  (`bun install` + Vite build of the embed entry), then nginx serves the output. Path
  configured via `OPEN_PENCIL_PATH` (defaults to a sibling checkout), mirroring
  `DRAWIO_WEBAPP_PATH`. Expect a substantially slower build than draw.io's file mount.

`openmemory-server` additionally gains a writable volume for `/data/design-blobs`. It
currently mounts only `${HOME}` read-only.

### 4. Offline enforcement

Configuration flags are necessary but not sufficient; the CSP is what makes offline a
property of the deployment rather than a toggle someone can flip.

- nginx serves the embed with
  `Content-Security-Policy: default-src 'self'; connect-src 'self'; font-src 'self'; img-src 'self' data:; script-src 'self' 'wasm-unsafe-eval'`
  A violation then fails loudly instead of silently leaking.
- Force `onlineFontsEnabled` to `false` and disable all four web-font providers.
- Exclude the icon picker, AI chat, vectorize, and WebRTC collaboration from the embed
  build.
- **Fonts: Latin only.** Ship the already-bundled Inter and NotoNaskhArabic; vendor no
  CJK fonts. Consequence, accepted: CJK text in a design renders with tofu or a system
  fallback. Reversible later by adding a `.ttf` to `public/` — no code change.

## Data flow

**Open:** panel reads the design record → `source` holds a JSON reference
(`{ providerId: 'openmemory', documentId }`) → `pencil-diagram.tsx` posts `load` with
that reference → embed's storage adapter `GET`s the blob endpoint → server streams
bytes from the blob volume → editor renders.

**Save:** user clicks OpenMemory's existing Save button → `handleSave()` calls
`flushSource()` → embed serializes via `writeDocument` (`exportFigFile`, thumbnail
disabled so CanvasKit is not required) → adapter `PUT`s bytes to the blob endpoint →
server writes the file to the blob volume → embed returns the reference →
`handleSave()` `PUT`/`POST`s the design record with that small reference as `source`.

Bytes never pass through the design record. `source` stays kilobyte-scale.

## Changes to existing code

| file | change |
|---|---|
| `apps/web/lib/pencil.ts` | **new** — mirrors `lib/drawio.ts`: reference parse/serialize, embed URL builder, message parser |
| `apps/web/components/pencil-diagram.tsx` | **new** — mirrors `drawio-diagram.tsx`: iframe, `flushSource()` handle, message listener, loading and error states |
| `apps/web/components/project-design-panel.tsx` | `computeEditorMode()` gains a `'pen'` branch; `handleSave()` gains a `pen` case alongside the existing `drawio` case |
| `apps/web/lib/design-meta.ts` | register the new kind/starter |
| `apps/server/src/main.rs` | add `'pen'` to the `diagram_type` allow-list (~lines 6256, 6304); add blob `GET`/`PUT` endpoints backed by the volume; register routes near line 1492 |
| `docker-compose.yml` | `open-pencil` service; writable blob volume on `openmemory-server`; wire `NEXT_PUBLIC_OPEN_PENCIL_URL` |

No database migration: `project_designs` is unchanged.

## Error handling

Mirrors `DrawioDiagram`:

- Loading spinner until `ready`; inline error panel on iframe load failure.
- CanvasKit/WASM init failure inside the embed surfaces via the `error` message.
- `flushSource()` carries a timeout guard matching draw.io's 5 s, rejecting any pending
  promise on unmount.
- Blob endpoint failures (disk full, oversized upload, permissions) surface as a toast and
  **abort the record save**, so a design record can never reference a blob that was
  never written.
- The blob endpoint enforces a maximum upload size, returning a clear error rather than
  allowing an unbounded write.

## Testing

`apps/web` has **no Playwright and no test runner** — `"test"` is
`echo 'no tests yet' && exit 0`. The actual convention is colocated `node:test` +
`node:assert` unit tests over pure functions, as in `lib/drawio.test.ts`.

- `apps/web/lib/pencil.test.ts` — mirrors `lib/drawio.test.ts`: reference
  parse/serialize round-trip, rejection of malformed references, embed URL construction,
  message parsing including hostile input.
- Server-side tests for the blob endpoints (size limit, missing blob, project scoping)
  following existing Rust test conventions.
- Manual verification, since iframe and canvas behavior is not covered by the above:
  create a design, draw, save, reload, confirm it round-trips; and confirm with DevTools
  Network that **no external request is made** during a full editing session.

## Risks

- **Work lands mostly in the OpenPencil repo**, not in OpenMemory. The embed entrypoint
  is genuinely new code that must pass that repo's `bun run check`, Steiger architecture
  lint, and import-boundary rules.
- **Docker build cost.** Vite + WASM build is far heavier than draw.io's static mount and
  will slow first-time stack startup.
- **Upstream drift.** The embed entry lives in a checkout that can move underneath us;
  the postMessage contract and storage-provider registration are the coupling points to
  re-verify after an OpenPencil update.
- **`.fig` is binary and opaque.** Unlike mermaid or mxGraph XML, design content is not
  diffable, greppable, or agent-editable as text. Agent editing would go through
  OpenPencil's own MCP/CLI surface, not by manipulating `source`.

## Out of scope

- Agent-driven editing of `.fig` designs from OpenMemory (OpenPencil ships its own MCP
  server and CLI for that).
- Importing `.pen` files (read-only in OpenPencil; possible later as one-way import).
- Real-time collaboration (WebRTC, explicitly excluded to hold the offline guarantee).
- Thumbnail previews of `.fig` designs in the design list.
