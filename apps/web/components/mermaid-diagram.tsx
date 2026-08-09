'use client';

// Note: this component must be imported with next/dynamic + ssr:false — mermaid touches
// `document` at import time.

import { useEffect, useRef, useState } from 'react';
import { useTheme } from 'next-themes';
import mermaid from 'mermaid';
import elkLayouts from '@mermaid-js/layout-elk';
import { AlertTriangle, ZoomIn, ZoomOut, RotateCcw, Maximize2, Expand, Shrink } from 'lucide-react';
import { Button } from '@/components/ui/button';
import awsIconPack from '@/lib/aws-icon-pack.json';

interface MermaidDiagramProps {
  source: string;
}

let renderCounter = 0;
let iconPacksRegistered = false;
let layoutLoadersRegistered = false;

function ensureIconPacksRegistered() {
  if (iconPacksRegistered) return;
  // Registers the curated AWS/Amazon subset of @iconify-json/logos so architecture-beta
  // diagrams can reference e.g. `logos:aws-lambda`. Registered once per page — mermaid keeps
  // this in module-level state, not per-render.
  mermaid.registerIconPacks([{ name: 'logos', icons: awsIconPack as never }]);
  iconPacksRegistered = true;
}

function ensureLayoutLoadersRegistered() {
  if (layoutLoadersRegistered) return;
  // ELK gives markedly better routing/nesting than mermaid's built-in dagre renderer on the
  // container-heavy diagrams this app draws — same registration the mermaid Live Editor does
  // (see ~/projects/mermaid-live-editor/src/lib/util/mermaid.ts). Module-level state like the
  // icon packs above, so it registers once per page rather than per render.
  //
  // Note this only reaches diagrams that go through mermaid's pluggable layout system —
  // `flowchart` and friends. `architecture-beta` runs its own cytoscape-based layout internally
  // and ignores `layout` entirely, so an architecture diagram renders identically with or
  // without this. Registered anyway for every other diagram type.
  mermaid.registerLayoutLoaders(elkLayouts);
  layoutLoadersRegistered = true;
}

const MIN_ZOOM = 0.25;
const MAX_ZOOM = 3;
const ZOOM_STEP = 0.25;

export function MermaidDiagram({ source }: MermaidDiagramProps) {
  const { resolvedTheme } = useTheme();
  const [svg, setSvg] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [zoom, setZoom] = useState(1);
  // Natural (unscaled) SVG size, used to size the scaled wrapper explicitly — a CSS
  // `transform: scale()` shrinks what's painted but not the element's own layout box, so
  // without this the scroll container would keep reserving space for the full unscaled
  // diagram even while displaying it smaller.
  const [naturalSize, setNaturalSize] = useState<{ width: number; height: number } | null>(null);
  const [isFullscreen, setIsFullscreen] = useState(false);
  const idRef = useRef(`mermaid-diagram-${++renderCounter}`);
  const rootRef = useRef<HTMLDivElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let cancelled = false;

    if (!source.trim()) {
      setSvg(null);
      setError(null);
      return;
    }

    ensureIconPacksRegistered();
    ensureLayoutLoadersRegistered();

    mermaid.initialize({
      startOnLoad: false,
      // Mandatory: strict mode disallows click handlers / raw HTML injected via node labels.
      securityLevel: 'strict',
      theme: resolvedTheme === 'dark' ? 'dark' : 'default',
      // Honored by diagram types using mermaid's pluggable layout system (flowchart et al.);
      // architecture-beta ignores it and uses its own internal layout.
      layout: 'elk',
    });

    (async () => {
      try {
        const { svg: rendered } = await mermaid.render(idRef.current, source);
        if (!cancelled) {
          setSvg(rendered);
          setError(null);
          // Reset zoom/size for the new diagram — both are recomputed below once it's
          // actually laid out in the DOM.
          setZoom(1);
          setNaturalSize(null);
        }
      } catch (err) {
        if (!cancelled) {
          setSvg(null);
          setError(err instanceof Error ? err.message : 'Failed to render diagram');
        }
      }
    })();

    return () => {
      cancelled = true;
    };
    // Re-render (and reset zoom, above) whenever the source changes to a different diagram —
    // stale zoom from a previous diagram must never carry over.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [source, resolvedTheme]);

  // Read the SVG's natural (unscaled) width. mermaid sets the `width` attribute to `100%`, so
  // getBoundingClientRect() just reflects the container's width, not the diagram's actual
  // size — the viewBox's width (in SVG user units, 1:1 with CSS px for mermaid's output) is the
  // only reliable source, with getBoundingClientRect()/zoom as a last-resort fallback for the
  // rare case a diagram has no viewBox.
  const getNaturalSize = (svgEl: SVGSVGElement): { width: number; height: number } | null => {
    const viewBox = svgEl.getAttribute('viewBox');
    if (viewBox) {
      const parts = viewBox.split(/\s+/).map(Number);
      if (parts.length === 4 && Number.isFinite(parts[2]) && Number.isFinite(parts[3]) && parts[2] > 0 && parts[3] > 0) {
        return { width: parts[2], height: parts[3] };
      }
    }
    const rect = svgEl.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0 ? { width: rect.width / zoom, height: rect.height / zoom } : null;
  };

  // Fits by BOTH width and height — a diagram can be too tall (e.g. multiple stacked
  // architecture-beta groups) without ever being too wide, and vice versa. Using only the
  // width ratio would leave a tall diagram at 100% zoom, overflowing the fixed-height
  // scroll container vertically.
  const fitToContainer = () => {
    const container = containerRef.current;
    const svgEl = contentRef.current?.querySelector('svg');
    if (!container || !svgEl) return;
    const containerWidth = container.clientWidth;
    const containerHeight = container.clientHeight;
    const natural = getNaturalSize(svgEl);
    if (!natural || !containerWidth || !containerHeight) return;
    const widthRatio = (containerWidth - 16) / natural.width;
    const heightRatio = (containerHeight - 16) / natural.height;
    const fitted = Math.min(1, widthRatio, heightRatio);
    setZoom(Math.max(MIN_ZOOM, fitted));
  };

  // Auto-fit on initial render of a diagram that overflows its container in either
  // dimension — don't require the user to click "fit" just to see a reasonably-sized
  // diagram on first load.
  useEffect(() => {
    if (!svg) return;
    const id = requestAnimationFrame(() => {
      const container = containerRef.current;
      const svgEl = contentRef.current?.querySelector('svg');
      if (!container || !svgEl) return;
      const containerWidth = container.clientWidth;
      const containerHeight = container.clientHeight;
      const natural = getNaturalSize(svgEl);
      if (!natural) return;
      setNaturalSize(natural);
      if (containerWidth > 0 && containerHeight > 0 &&
          (natural.width > containerWidth || natural.height > containerHeight)) {
        fitToContainer();
      }
    });
    return () => cancelAnimationFrame(id);
    // Only re-run when a genuinely new SVG has been rendered.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [svg]);

  // Keep isFullscreen in sync with the browser's actual fullscreen state — the user can exit
  // via Esc or the browser's own UI, not just our button, and the Fullscreen API has no other
  // way to observe that.
  useEffect(() => {
    const handleChange = () => setIsFullscreen(document.fullscreenElement === rootRef.current);
    document.addEventListener('fullscreenchange', handleChange);
    return () => document.removeEventListener('fullscreenchange', handleChange);
  }, []);

  // Re-fit whenever fullscreen is entered/exited — the container's actual pixel size just
  // changed drastically, so the previous zoom level is almost certainly wrong now.
  useEffect(() => {
    const id = requestAnimationFrame(() => fitToContainer());
    return () => cancelAnimationFrame(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isFullscreen]);

  const toggleFullscreen = () => {
    if (document.fullscreenElement) {
      document.exitFullscreen().catch(() => {});
    } else {
      // Can reject (e.g. Permissions-Policy denies "fullscreen" in an embedded/iframed
      // context) — fail quietly rather than an unhandled promise rejection; the button
      // simply has no visible effect in that case.
      rootRef.current?.requestFullscreen().catch(() => {});
    }
  };

  if (error) {
    return (
      <div className="flex flex-col items-center justify-center gap-2 p-6 text-center text-sm text-destructive border border-dashed border-destructive/40 rounded-md">
        <AlertTriangle className="h-6 w-6" />
        <p className="font-medium">Couldn&apos;t render this diagram</p>
        <p className="text-muted-foreground text-xs max-w-md">{error}</p>
      </div>
    );
  }

  if (!svg) {
    return (
      <div className="flex items-center justify-center p-6 text-sm text-muted-foreground">
        No diagram source yet.
      </div>
    );
  }

  return (
    <div
      ref={rootRef}
      className={`flex flex-col gap-2 h-full min-h-0 ${isFullscreen ? 'bg-background p-4' : ''}`}
    >
      <div className="flex items-center gap-1 self-end shrink-0">
        <Button
          type="button"
          variant="outline"
          size="icon"
          className="h-7 w-7"
          onClick={() => setZoom((z) => Math.max(MIN_ZOOM, +(z - ZOOM_STEP).toFixed(2)))}
          title="Zoom out"
        >
          <ZoomOut className="h-3.5 w-3.5" />
        </Button>
        <Button
          type="button"
          variant="outline"
          size="icon"
          className="h-7 w-7"
          onClick={() => setZoom((z) => Math.min(MAX_ZOOM, +(z + ZOOM_STEP).toFixed(2)))}
          title="Zoom in"
        >
          <ZoomIn className="h-3.5 w-3.5" />
        </Button>
        <Button
          type="button"
          variant="outline"
          size="icon"
          className="h-7 w-7"
          onClick={fitToContainer}
          title="Fit to container"
        >
          <Maximize2 className="h-3.5 w-3.5" />
        </Button>
        <Button
          type="button"
          variant="outline"
          size="icon"
          className="h-7 w-7"
          onClick={() => setZoom(1)}
          title="Reset zoom"
        >
          <RotateCcw className="h-3.5 w-3.5" />
        </Button>
        <span className="text-xs text-muted-foreground w-10 text-right tabular-nums">
          {Math.round(zoom * 100)}%
        </span>
        <Button
          type="button"
          variant="outline"
          size="icon"
          className="h-7 w-7"
          onClick={toggleFullscreen}
          title={isFullscreen ? 'Exit full window' : 'Full window'}
        >
          {isFullscreen ? <Shrink className="h-3.5 w-3.5" /> : <Expand className="h-3.5 w-3.5" />}
        </Button>
      </div>
      <div ref={containerRef} className="overflow-auto flex-1 min-h-0">
        {/* Two nested boxes, deliberately not one: `transform: scale()` shrinks what's
            *painted* but never the element's own layout box. The inner div is pinned to the
            SVG's natural (unscaled) size so mermaid's `width="100%"` output renders at true
            size before any scaling; the outer wrapper is sized to the *scaled* footprint so
            the scroll container reserves only the visible amount of space — without it, a
            diagram fit down to e.g. 40% would still make this box scrollable across its full
            un-shrunk original size. */}
        <div
          style={naturalSize ? { width: naturalSize.width * zoom, height: naturalSize.height * zoom, overflow: 'hidden' } : undefined}
        >
          {/* mermaid.render() output is inserted directly: with securityLevel: 'strict' (set
              above) mermaid itself sanitizes labels/HTML and disallows script/click-handler
              injection, so the returned SVG string is the standard trusted-render path
              recommended by mermaid's own docs (react wrappers do the same) — not arbitrary
              user HTML. */}
          <div
            ref={contentRef}
            style={
              naturalSize
                ? { transform: `scale(${zoom})`, transformOrigin: 'top left', width: naturalSize.width, height: naturalSize.height }
                : { transform: `scale(${zoom})`, transformOrigin: 'top left' }
            }
            dangerouslySetInnerHTML={{ __html: svg }}
          />
        </div>
      </div>
    </div>
  );
}
