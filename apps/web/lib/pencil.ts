export const PENCIL_EMBED_URL =
  process.env.NEXT_PUBLIC_OPEN_PENCIL_URL?.replace(/\/$/, '') ?? 'http://localhost:18082';

// Bump when the embed boot contract changes. The first OpenPencil deployment served
// embed.html as application/octet-stream, and browsers can retain that response metadata
// even after nginx is fixed. A versioned navigation bypasses that poisoned cache entry;
// nginx also serves the entry document with revalidation headers going forward.
const PENCIL_EMBED_REVISION = '2';

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

export function pencilEmbedSrc(): string {
  return `${PENCIL_EMBED_URL}/embed.html?openmemoryEmbed=${PENCIL_EMBED_REVISION}`;
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
