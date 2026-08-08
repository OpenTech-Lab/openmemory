// PNG export for the design canvas — trimmed port of homelable's frontend/src/utils/export.ts
// (~26-79). v1 keeps only a single fixed-quality PNG export: no SVG format, no quality tiers, no
// background color picker.

import { toPng } from 'html-to-image';
import { getNodesBounds, getViewportForBounds, type Node } from '@xyflow/react';

const PIXEL_RATIO = 2;
const EXPORT_PADDING = 40;

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
 * Exports the design canvas as a PNG using React Flow's canonical "download image" recipe:
 * compute the bounding box of every node (regardless of current pan/zoom/viewport size), then
 * derive a transform that fits that whole box into the export canvas. `element` must still be
 * the `.react-flow__viewport` node so its transform can be overridden for the capture, but
 * `nodes` drives what actually gets captured — the *rendered* size of `element` is just the
 * visible pane, so capturing it directly (the previous approach) clipped anything scrolled
 * off-screen or beyond the current zoom, cutting off nodes/labels at the pane's edges.
 *
 * `backgroundColor` should match whatever the canvas is actually showing right now (design-canvas.tsx
 * tracks this per light/dark mode) — it's passed in rather than assumed here so the export always
 * matches what's on screen instead of drifting from it.
 */
export async function exportDesignToPng(
  element: HTMLElement,
  nodes: Node[],
  backgroundColor: string,
  filename = 'design-diagram.png'
): Promise<void> {
  const bounds = getNodesBounds(nodes);
  const width = Math.ceil(bounds.width + EXPORT_PADDING * 2);
  const height = Math.ceil(bounds.height + EXPORT_PADDING * 2);
  // `padding` here is a *fraction* of width/height (default 0.1 = 10%), not a pixel value — the
  // export canvas is already sized to `bounds` plus EXPORT_PADDING pixels on every side above, so
  // no additional ratio-based padding is needed on top of that.
  const { x, y, zoom } = getViewportForBounds(bounds, width, height, 0.1, 2, 0);

  const dataUrl = await withBackground(element, backgroundColor, () =>
    toPng(element, {
      backgroundColor,
      pixelRatio: PIXEL_RATIO,
      width,
      height,
      style: {
        width: `${width}px`,
        height: `${height}px`,
        transform: `translate(${x}px, ${y}px) scale(${zoom})`,
        transformOrigin: '0 0',
      },
    })
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
