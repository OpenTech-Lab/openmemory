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

/** Looks up an icon by key (no `logos:` prefix). `viewBox` height must come from the icon's own
 * `height` override when present — 6 icons in this pack aren't square (e.g. `aws` is 153,
 * `aws-elastic-cache` is 308) — never hardcode `0 0 256 256`. */
export function awsIcon(key: string): AwsIcon | null {
  const icon = pack.icons[key];
  if (!icon) return null;
  return { body: icon.body, viewBox: `0 0 ${pack.width} ${icon.height ?? pack.height}` };
}
