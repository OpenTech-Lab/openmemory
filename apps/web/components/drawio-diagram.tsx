'use client';

import { forwardRef, useEffect, useImperativeHandle, useMemo, useRef, useState } from 'react';
import { AlertTriangle, LoaderCircle } from 'lucide-react';
import { useTheme } from 'next-themes';
import {
  drawioEditorSrc,
  drawioViewerSrc,
  normalizeDrawioSource,
  parseDrawioMessage,
} from '@/lib/drawio';

interface DrawioDiagramProps {
  source: string;
  mode: 'editor' | 'viewer';
  title?: string;
  kind?: string;
  onChange?: (source: string) => void;
}

export interface DrawioDiagramHandle {
  flushSource: () => Promise<string>;
}

export const DrawioDiagram = forwardRef<DrawioDiagramHandle, DrawioDiagramProps>(function DrawioDiagram(
  { source, mode, title = 'OpenMemory diagram', kind = '', onChange },
  ref,
) {
  const { resolvedTheme } = useTheme();
  const isDark = resolvedTheme === 'dark';
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const sourceRef = useRef(normalizeDrawioSource(source, kind));
  const onChangeRef = useRef(onChange);
  const titleRef = useRef(title);
  const pendingSourceRef = useRef<{
    resolve: (source: string) => void;
    reject: (error: Error) => void;
    timeout: ReturnType<typeof setTimeout>;
  } | null>(null);
  const [isReady, setIsReady] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const src = useMemo(
    () => (mode === 'editor' ? drawioEditorSrc(isDark) : drawioViewerSrc(isDark)),
    [isDark, mode],
  );
  const targetOrigin = useMemo(() => new URL(src).origin, [src]);

  useEffect(() => {
    sourceRef.current = normalizeDrawioSource(source, kind);
  }, [source, kind]);

  useEffect(() => {
    onChangeRef.current = onChange;
  }, [onChange]);

  useEffect(() => {
    titleRef.current = title;
  }, [title]);

  useImperativeHandle(ref, () => ({
    flushSource: () => {
      if (mode !== 'editor') return Promise.resolve(sourceRef.current);
      const frameWindow = iframeRef.current?.contentWindow;
      if (!frameWindow) return Promise.reject(new Error('Diagram editor is not ready'));

      return new Promise<string>((resolve, reject) => {
        pendingSourceRef.current?.reject(new Error('A newer diagram save replaced this request'));
        const timeout = setTimeout(() => {
          pendingSourceRef.current = null;
          reject(new Error('Timed out while reading the diagram'));
        }, 5000);
        pendingSourceRef.current = { resolve, reject, timeout };

        // draw.io's embedded save action commits an active label edit and returns the current full
        // mxGraph XML. This closes the race between iframe autosave and clicking OpenMemory's Save
        // button while the caret is still inside a shape label. The embedded save button itself is
        // hidden because OpenMemory owns the surrounding record save/cancel flow.
        frameWindow.postMessage(JSON.stringify({ action: 'invokeAction', actionName: 'save' }), targetOrigin);
      });
    },
  }), [mode, targetOrigin]);

  useEffect(() => {
    setIsReady(false);
    setError(null);

    const handleMessage = (event: MessageEvent) => {
      const frameWindow = iframeRef.current?.contentWindow;
      if (!frameWindow || event.source !== frameWindow) return;
      if (event.origin !== targetOrigin) return;
      const message = parseDrawioMessage(event.data);
      if (!message) return;

      if (mode === 'viewer' && message.event === 'ready') {
        frameWindow.postMessage(sourceRef.current, targetOrigin);
        setIsReady(true);
        return;
      }

      if (mode === 'editor' && message.event === 'init') {
        frameWindow.postMessage(JSON.stringify({
          action: 'load',
          xml: sourceRef.current,
          autosave: 1,
          title: titleRef.current,
          fit: 1,
          border: 24,
          dark: isDark,
          libs: ['general', 'aws4', 'bpmn', 'flowchart', 'uml'],
        }), targetOrigin);
        return;
      }

      if (mode === 'editor' && message.event === 'load') {
        setIsReady(true);
        if (message.xml) {
          sourceRef.current = message.xml;
          onChangeRef.current?.(message.xml);
        }

        // The embedded editor initializes while the dialog is still measuring, so draw.io
        // starts with its side panels collapsed. Open the normal shapes and format panels
        // once the full-width studio is ready; compact layouts keep the canvas-first view.
        if ((iframeRef.current?.clientWidth ?? 0) >= 1180) {
          frameWindow.postMessage(JSON.stringify({ action: 'invokeAction', actionName: 'toggleShapes' }), targetOrigin);
          frameWindow.postMessage(JSON.stringify({ action: 'invokeAction', actionName: 'format' }), targetOrigin);
          frameWindow.postMessage(JSON.stringify({ action: 'invokeAction', actionName: 'smartFit' }), targetOrigin);
        }
        return;
      }

      if (mode === 'editor' && (message.event === 'autosave' || message.event === 'save') && message.xml) {
        sourceRef.current = message.xml;
        onChangeRef.current?.(message.xml);
        if (message.event === 'save') {
          const pending = pendingSourceRef.current;
          if (pending) {
            clearTimeout(pending.timeout);
            pendingSourceRef.current = null;
            pending.resolve(message.xml);
          }
        }
      }

      if (message.error) setError(message.error);
    };

    window.addEventListener('message', handleMessage);
    return () => {
      window.removeEventListener('message', handleMessage);
      const pending = pendingSourceRef.current;
      if (pending) {
        clearTimeout(pending.timeout);
        pendingSourceRef.current = null;
        pending.reject(new Error('Diagram editor closed before saving'));
      }
    };
  }, [isDark, mode, src, targetOrigin]);

  return (
    <div className="relative h-full min-h-[360px] overflow-hidden rounded-lg border border-border/80 bg-background shadow-[0_18px_60px_rgba(15,23,42,0.12)] dark:shadow-[0_18px_60px_rgba(0,0,0,0.42)]">
      {!isReady && !error && (
        <div className="absolute inset-0 z-10 flex items-center justify-center bg-background/95 text-muted-foreground">
          <div className="flex items-center gap-2 rounded-full border border-border bg-card px-4 py-2 text-sm text-card-foreground shadow-sm">
            <LoaderCircle className="h-4 w-4 animate-spin text-sky-600" />
            Loading diagram studio…
          </div>
        </div>
      )}
      {error && (
        <div className="absolute inset-0 z-20 flex items-center justify-center bg-background p-6 text-center text-sm text-red-700 dark:text-red-300">
          <div className="max-w-md rounded-lg border border-red-200 bg-red-50 p-4 dark:border-red-900 dark:bg-red-950/40">
            <AlertTriangle className="mx-auto mb-2 h-6 w-6" />
            <p className="font-semibold">Couldn&apos;t load the diagram renderer</p>
            <p className="mt-1 text-xs text-red-600 dark:text-red-400">{error}</p>
          </div>
        </div>
      )}
      <iframe
        ref={iframeRef}
        src={src}
        title={mode === 'editor' ? `Edit ${title}` : `View ${title}`}
        className="h-full w-full border-0 bg-background"
        allow="clipboard-read; clipboard-write; fullscreen"
        allowFullScreen
        onError={() => setError('The configured draw.io service could not be reached.')}
      />
    </div>
  );
});
