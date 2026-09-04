# Run a QA plan for real, from the button

**Date:** 2026-09-04
**Status:** proposed
**Supersedes:** the copy-a-command behaviour added earlier today, which stays as a fallback.

## What changes

The **Run** button executes the plan and returns the recorded run. No copy, no paste.

## Why this is possible without new toolchains

The server container mounts `${HOME}:${HOME}:rw` (`docker-compose.yml:197`), and this
machine's toolchains all live under `$HOME`:

```
node   /home/toyofumi/.local/share/mise/installs/node/26.1.0/bin/node
pnpm   /home/toyofumi/.local/share/pnpm/pnpm
cargo  /home/toyofumi/.cargo/bin/cargo
```

Measured from inside the running container:

- `cargo --version` → **works today**
- `node --version` → fails on exactly one missing library:
  `error while loading shared libraries: libatomic.so.1`

So the only image change needed is the `libatomic1` package. The container then runs the
same Node the developer runs, with no duplicated toolchain to drift.

## Security posture — read this before implementing

This executes test code stored in a database row, inside a container with read-write
access to the whole home directory. That is a real risk and it was accepted deliberately:
the API is localhost-only and token-gated, the server already shells out to `git`, and the
plan bodies are authored by the same person who owns the machine.

The following are **not** optional, and are what keep it bounded:

1. **Never build a shell string.** Spawn `argv` directly (`Command::new(bin).arg(..)`).
   The plan body must never be interpreted by a shell. This is why the feature does not
   simply run the snippet the UI already generates.
2. **Runner comes from a fixed allowlist**, chosen from the plan's `kind`/`language` —
   never from anything in the plan body or the request payload.
3. **The written file must stay inside the project root.** Resolve the target, then
   verify with `canonicalize` + `starts_with(project_root)`, the same guard
   `upload_qa_evidence_file` uses. Reject `..`, absolute paths, and symlinks pointing out.
4. **Wall-clock timeout** (default 300s, env-tunable) and **captured-output cap** (1 MB
   per stream). A hung test must not hold a connection or fill memory forever.
5. **`is_authenticated` first**, like every other QA handler.

## 1. Image

`Dockerfile:25` runtime stage — add `libatomic1` to the existing apt install. One package,
no base-image change:

```dockerfile
RUN apt-get update \
    && apt-get install -y ca-certificates curl git libatomic1 \
    && rm -rf /var/lib/apt/lists/*
```

## 2. Runner resolution

A small table, each entry env-overridable so a machine with a different layout can point
at its own binaries:

| plan kind / language | binary (env override) | args |
|---|---|---|
| ts/js (`jest`, `other`) | `OPENMEMORY_QA_NODE_BIN`, default `node` | `--test --test-reporter=junit --test-reporter-destination=<junit> <file>` |
| `playwright` (ts/js) | `OPENMEMORY_QA_PLAYWRIGHT_BIN`, default `npx` | `playwright test <file> --reporter=junit` (env `PLAYWRIGHT_JUNIT_OUTPUT_NAME=<junit>`) |
| python | `OPENMEMORY_QA_PYTEST_BIN`, default `pytest` | `<file> --junitxml=<junit>` |
| `maestro` / yaml | `OPENMEMORY_QA_MAESTRO_BIN`, default `maestro` | `test <file> --format junit --output <junit>` |
| anything else | — | 422 with a readable reason, no execution |

`docker-compose.yml` sets `OPENMEMORY_QA_NODE_BIN` from `.env` so this machine points at
its mise node. Defaulting to the bare name keeps it working anywhere the binary is on PATH.

If the binary is missing or not executable, return **503** naming the binary and the env
var to set — never a generic 500.

## 3. `POST /projects/:id/qa/plans/:plan_id/run`

New handler in `main.rs`, registered next to the existing plans routes (`main.rs:1812`).

1. `is_authenticated(&headers, &state.api_token)`.
2. Load the plan (scoped to `project_id`) and the project row — the project's `path` is the
   working directory. 404 if either is missing; **422 if the project has no path**, since
   there is nowhere to run.
3. Compute the target path. Port the TypeScript logic in `apps/web/lib/qa-run-command.ts`
   — `originDirFromDescription`, `planSlug`, `planFileExtension` — to Rust so the UI's
   stated path and the server's actual path cannot drift. A duplicated plan runs beside
   its origin file, because its relative imports resolve nowhere else; a hand-written plan
   goes to `.qa-plans/`.
4. Guard the path (§Security 3), create parent dirs, write the body.
5. Spawn the runner with `cwd = project root`, under the timeout. Capture stdout/stderr,
   capped.
6. Read the JUnit file. If the runner produced none — it crashed before reporting — record
   a **failed** run whose single case carries the captured stderr, rather than returning a
   bare error. A run that fails to start is still a result worth keeping.
7. Ingest through the **existing** `qa_ingest` path in-process. Do not duplicate the insert
   logic; call the same function the HTTP ingest endpoint uses so cases, metrics, sources
   and retention all behave identically.
8. Return `{ run_id, status, passed, failed, skipped, duration_ms }`.

Delete the JUnit file afterwards; leave the written test file in place — the developer
will want to look at it, and for a duplicated plan it is now a real file in the tree.

## 4. UI

`qa-plans-panel.tsx`, in the existing Run dialog:

- Primary button becomes **Run now** → POSTs, disables with a spinner and a
  "Running…" label, and must not be double-submittable.
- On success: toast with the outcome (`6 passed`, `1 failed`), and an action that switches
  to the Runs tab with the new run selected. This needs `onOpenRun(runId)` threaded through
  `QaSection` exactly like the existing `onOpenPlan`, plus `focusRunId` on `QaPanel`.
- On failure: inline error inside the dialog, showing the server's message verbatim
  (including the 503 "set OPENMEMORY_QA_NODE_BIN" case). Never a silent close.
- **Keep "Copy command"** as the secondary action. It is the escape hatch when the server
  cannot reach a runner, and it costs nothing to leave.
- A long run is a long request. Give the fetch an `AbortController` with a timeout slightly
  above the server's, so the dialog cannot hang forever if the server dies mid-run.

## 5. Tests

- Rust: unit tests for the path logic — origin-dir extraction, slug sanitisation, and
  crucially that a path escaping the project root is **rejected** (`../`, absolute,
  symlink-out). Also the runner-selection table.
- Web: extend `qa-run-command.test.ts` only if the shared helpers change. The Rust port
  must be tested independently, because it is the one that actually writes files.
- No new npm packages, no new crates.

## Risks

| Risk | Handling |
|---|---|
| Shell injection from a plan body | argv spawn, never a shell string |
| Write outside the project | canonicalize + `starts_with`, tested |
| Hung test blocks the server | wall-clock timeout, capped output |
| Wrong runner silently produces no JUnit | missing report ⇒ recorded failed run carrying stderr |
| Toolchain missing in container | 503 naming the binary and its env var |
| Node fails on `libatomic.so.1` | `libatomic1` added to the runtime image |

## Verification

1. `docker compose --profile api build openmemory-server && … up -d openmemory-server`
2. From inside the container, the configured node runs: `node --version` → 26.x
3. In the UI: Plans → Run → **Run now** on the duplicated `formatCaseDuration` plan →
   a new run appears under Runs with 6 passed cases, without touching a terminal.
4. Negative: a plan whose body throws at import records a **failed** run carrying the error.
5. Negative: `OPENMEMORY_QA_NODE_BIN=/nonexistent` returns 503 with a readable message.
