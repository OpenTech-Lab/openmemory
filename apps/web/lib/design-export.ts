// PNG export for the design canvas — trimmed port of homelable's frontend/src/utils/export.ts
// (~26-79). v1 keeps only a single fixed-quality PNG export: no SVG format, no quality tiers, no
// background color picker.

import { toPng } from 'html-to-image';

const PIXEL_RATIO = 2;

// `.react-flow__pane` paints its own background, so html-to-image's `backgroundColor` option
// alone won't show through it — force the resolved `--background` value directly onto the
// element being captured for the duration of the capture, then restore whatever was there.
async function withBackground<T>(element: HTMLElement, color: string, capture: () => Promise<T>): Promise<T> {
  const previous = element.style.backgroundColor;
  element.style.backgroundColor = color;
  try {
    return await capture();
  } finally {
    element.style.backgroundColor = previous;
  }
}

/**
 * Exports the design canvas as a PNG. `element` must be the `.react-flow__viewport` node (the
 * library's own transformed inner pane containing all nodes/edges) so the export includes
 * nodes currently scrolled off-screen at the current zoom/pan.
 *
 * `backgroundColor` should match whatever the canvas is actually showing right now (design-canvas.tsx
 * tracks this per light/dark mode) — it's passed in rather than assumed here so the export always
 * matches what's on screen instead of drifting from it.
 */
export async function exportDesignToPng(element: HTMLElement, backgroundColor: string, filename = 'design-diagram.png'): Promise<void> {
  const dataUrl = await withBackground(element, backgroundColor, () =>
    toPng(element, { backgroundColor, pixelRatio: PIXEL_RATIO })
  );
  triggerDownload(dataUrl, filename);
}

function triggerDownload(dataUrl: string, filename: string): void {
  const link = document.createElement('a');
  link.download = filename;
  link.href = dataUrl;
  // Firefox only triggers a programmatic click when the anchor is in the DOM.
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
}
