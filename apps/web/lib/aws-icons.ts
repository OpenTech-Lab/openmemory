// Typed accessor over aws-icon-pack.json (the same file mermaid-diagram.tsx registers with
// mermaid) for use as inline SVG in the reactflow design node/palette — no iconify web
// component, since html-to-image can't rasterize shadow DOM.

import awsIconPack from '@/lib/aws-icon-pack.json';

interface IconifyIcon {
  body: string;
  height?: number;
}

interface IconifyPack {
  prefix: string;
  width: number;
  height: number;
  icons: Record<string, IconifyIcon>;
}

const pack = awsIconPack as IconifyPack;

export const AWS_ICON_KEYS: string[] = Object.keys(pack.icons);

export interface AwsIcon {
  body: string;
  viewBox: string;
}

// Icon bodies land in the DOM via dangerouslySetInnerHTML (design-node.tsx / design-group-node.tsx
// / the palette), so any `<linearGradient id="...">` they declare shares the *page's* global ID
// namespace, not a per-icon one. Several icons in this pack reuse the same generated id (e.g.
// aws-sqs/aws-step-functions/aws-api-gateway all declare `SVGyDrnJbhE`) — harmless today only
// because those particular icons' stops happen to agree, but the moment one of them changes, every
// other icon sharing that id silently repaints to match it. Suffix every id (and its `url(#...)`
// references) with the icon's own key so each icon gets its own namespace. Checked against the
// whole pack: every id in this data is a `<linearGradient id="...">`, every reference is the
// `fill="url(#...)"` form, and every reference resolves to an id declared in that same icon's own
// body — no `xlink:href`/`href="#..."` or cross-icon references exist to worry about.
const ID_ATTR_RE = /\bid="([^"]+)"/g;
const rewrittenBodies = new Map<string, string>();

function rewriteIds(key: string, body: string): string {
  const cached = rewrittenBodies.get(key);
  if (cached !== undefined) return cached;
  const ids = new Set([...body.matchAll(ID_ATTR_RE)].map((match) => match[1]));
  let rewritten = body;
  for (const id of ids) {
    const uniqueId = `${id}-${key}`;
    rewritten = rewritten
      .replaceAll(`id="${id}"`, `id="${uniqueId}"`)
      .replaceAll(`url(#${id})`, `url(#${uniqueId})`);
  }
  rewrittenBodies.set(key, rewritten);
  return rewritten;
}

/** Looks up an icon by key (no `logos:` prefix). `viewBox` height must come from the icon's own
 * `height` override when present — 6 icons in this pack aren't square (e.g. `aws` is 153,
 * `aws-elastic-cache` is 308) — never hardcode `0 0 256 256`. */
export function awsIcon(key: string): AwsIcon | null {
  const icon = pack.icons[key];
  if (!icon) return null;
  return { body: rewriteIds(key, icon.body), viewBox: `0 0 ${pack.width} ${icon.height ?? pack.height}` };
}
