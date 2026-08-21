# vendor/

Third-party Rust crates vendored into this repository because upstream needs a
local patch. Each entry is wired up through `[patch.crates-io]` in the workspace
root `Cargo.toml` — a directory here does nothing on its own.

Layout follows `cargo vendor`: one directory per crate, named
`<crate>-<version>`, holding the crates.io source verbatim except for the
documented patch. `Cargo.toml.orig` is kept alongside so the diff against
upstream stays auditable.

## Current entries

| Crate | Why patched |
|---|---|
| `tree-sitter-javascript-0.21.4` | Upstream pins `cc = "~1.0.90"`. `russh` needs `ring >= 0.17.14`, which needs `cc ^1.2.8`. Every published `0.21.x` carries the same tilde pin, so the only unpatched escape is `0.23.x` — which requires `tree-sitter 0.23` and would drag the whole `tree-sitter-*` set along with it. The patch loosens the build-dependency to `cc = "1"` and changes nothing else; the build API used (`cc::Build::new()…compile()`) is stable across 1.x. Relevant feature: `env_ssh_execute` (see the SSH section of the root `README.md`). |

## Adding an entry

1. `cargo vendor` the crate, or copy the published source, into `vendor/<crate>-<version>/`.
2. Make the patch, and record the reason as a comment at the top of the crate's
   `Cargo.toml` — keep `Cargo.toml.orig` intact.
3. Add the crate to `[patch.crates-io]` in the root `Cargo.toml`.
4. Add a row to the table above.

## Removing an entry

Re-check upstream first: if a released version no longer needs the patch, drop
the `[patch.crates-io]` line, delete the directory, and bump the dependency in
`apps/server/Cargo.toml` instead. Vendored code is a maintenance cost — carry it
only while the reason in the table still holds.
