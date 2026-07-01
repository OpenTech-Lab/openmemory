export interface MemoryNode {
  id: string;
  summary?: string | null;
  importance_score: number;
  tags: string[];
  created_at: string;
}

export interface MemoryEdge {
  from_id: string;
  to_id: string;
  rel_type: string;
  relationship?: string | null;
}

// Red (low importance) -> amber -> green (high importance)
export function importanceColor(score: number): string {
  const clamped = Math.max(0, Math.min(1, score));
  if (clamped < 0.5) {
    return interpolate('#ef4444', '#f59e0b', clamped / 0.5);
  }
  return interpolate('#f59e0b', '#22c55e', (clamped - 0.5) / 0.5);
}

function interpolate(from: string, to: string, t: number): string {
  const a = hexToRgb(from);
  const b = hexToRgb(to);
  const r = Math.round(a.r + (b.r - a.r) * t);
  const g = Math.round(a.g + (b.g - a.g) * t);
  const bl = Math.round(a.b + (b.b - a.b) * t);
  return `rgb(${r}, ${g}, ${bl})`;
}

function hexToRgb(hex: string): { r: number; g: number; b: number } {
  const n = parseInt(hex.slice(1), 16);
  return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255 };
}

export function fmtTs(ts: string | undefined | null): string {
  if (!ts) return '—';
  try {
    return new Date(ts).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
  } catch {
    return ts;
  }
}

export function truncate(s: string, max: number): string {
  return s.length > max ? s.slice(0, max - 1) + '…' : s;
}
