#!/usr/bin/env node
// One-time generator: reads @iconify-json/logos' full icon set, filters down to the
// AWS/Amazon subset, and writes apps/web/lib/aws-icon-pack.json — the icon pack mermaid's
// architecture-beta diagrams register via mermaid.registerIconPacks(). Not part of the build;
// re-run manually if the icon set needs to be refreshed.
//
// Usage: node scripts/gen-aws-icon-pack.mjs
// Requires @iconify-json/logos to be installed under apps/web/node_modules (devDependency).

import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..');
const sourcePath = path.join(repoRoot, 'apps/web/node_modules/@iconify-json/logos/icons.json');
const outPath = path.join(repoRoot, 'apps/web/lib/aws-icon-pack.json');

const source = JSON.parse(readFileSync(sourcePath, 'utf8'));

const filteredEntries = Object.entries(source.icons).filter(([name]) => /^(aws|amazon)/.test(name));
const icons = Object.fromEntries(filteredEntries);

const pack = {
  prefix: 'logos',
  width: 256,
  height: 256,
  icons,
};

writeFileSync(outPath, JSON.stringify(pack, null, 2) + '\n');

const names = Object.keys(icons).sort();
console.log(`Wrote ${outPath} with ${names.length} icons.`);
console.log(names.join('\n'));
