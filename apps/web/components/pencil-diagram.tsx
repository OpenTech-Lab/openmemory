'use client';

import { forwardRef, useEffect, useImperativeHandle, useMemo, useRef, useState } from 'react';
import { AlertTriangle, LoaderCircle } from 'lucide-react';
import { parsePencilMessage, pencilEmbedSrc, serializePencilRef } from '@/lib/pencil';

interface PencilDiagramProps {
  projectId: string;
  designId: string;
  title?: string;
}

export interface PencilDiagramHandle {
  flushSource: () => Promise<string>;
}

export const PencilDiagram = forwardRef<PencilDiagramHandle, PencilDiagramProps>(
  function PencilDiagram({ projectId, designId, title = 'OpenPencil design' }, ref) {
    const iframeRef = useRef<HTMLIFrameElement>(null);
    const pendingSaveRef = useRef<{
      resolve: (source: string) => void;
      reject: (error: Error) => void;
      timeout: ReturnType<typeof setTimeout>;
    } | null>(null);
    const [isReady, setIsReady] = useState(false);
    const [error, setError] = useState<string | null>(null);

    const src = useMemo(() => pencilEmbedSrc(), []);
    const targetOrigin = useMemo(() => new URL(src).origin, [src]);

    useImperativeHandle(
      ref,
      () => ({
        flushSource: () => {
          const frameWindow = iframeRef.current?.contentWindow;
          if (!frameWindow) return Promise.reject(new Error('Design editor is not ready'));

          return new Promise<string>((resolve, reject) => {
            pendingSaveRef.current?.reject(new Error('A newer save replaced this request'));
            // Saving serializes and uploads a document that can reach ~82 MB, so this
            // allows far more headroom than draw.io's 5s XML flush.
            const timeout = setTimeout(() => {
              pendingSaveRef.current = null;
              reject(new Error('Timed out while saving the design'));
            }, 60000);
            pendingSaveRef.current = { resolve, reject, timeout };
            frameWindow.postMessage(JSON.stringify({ action: 'save' }), targetOrigin);
          });
        },
      }),
      [targetOrigin],
    );

    useEffect(() => {
      setIsReady(false);
      setError(null);

      const handleMessage = (event: MessageEvent) => {
        const frameWindow = iframeRef.current?.contentWindow;
        if (!frameWindow || event.source !== frameWindow) return;
        if (event.origin !== targetOrigin) return;
        const message = parsePencilMessage(event.data);
        if (!message) return;

        if (message.event === 'ready') {
          frameWindow.postMessage(
            JSON.stringify({
              action: 'load',
              baseUrl: window.location.origin,
              projectId,
              designId,
            }),
            targetOrigin,
          );
          return;
        }

        if (message.event === 'loaded') {
          setIsReady(true);
          return;
        }

        if (message.event === 'saved') {
          const pending = pendingSaveRef.current;
          if (pending) {
            clearTimeout(pending.timeout);
            pendingSaveRef.current = null;
            pending.resolve(serializePencilRef({ providerId: 'openmemory' }));
          }
          return;
        }

        if (message.error) {
          setError(message.error);
          const pending = pendingSaveRef.current;
          if (pending) {
            clearTimeout(pending.timeout);
            pendingSaveRef.current = null;
            pending.reject(new Error(message.error));
          }
        }
      };

      window.addEventListener('message', handleMessage);
      return () => {
        window.removeEventListener('message', handleMessage);
        const pending = pendingSaveRef.current;
        if (pending) {
          clearTimeout(pending.timeout);
          pendingSaveRef.current = null;
          pending.reject(new Error('Design editor closed before saving'));
        }
      };
    }, [designId, projectId, src, targetOrigin]);

    return (
      <div className="relative h-full min-h-[360px] overflow-hidden rounded-lg border border-border/80 bg-background shadow-[0_18px_60px_rgba(15,23,42,0.12)] dark:shadow-[0_18px_60px_rgba(0,0,0,0.42)]">
        {!isReady && !error && (
          <div className="absolute inset-0 z-10 flex items-center justify-center bg-background/95 text-muted-foreground">
            <div className="flex items-center gap-2 rounded-full border border-border bg-card px-4 py-2 text-sm text-card-foreground shadow-sm">
              <LoaderCircle className="h-4 w-4 animate-spin text-sky-600" />
              Loading design studio…
            </div>
          </div>
        )}
        {error && (
          <div className="absolute inset-0 z-20 flex items-center justify-center bg-background p-6 text-center text-sm text-red-700 dark:text-red-300">
            <div className="max-w-md rounded-lg border border-red-200 bg-red-50 p-4 dark:border-red-900 dark:bg-red-950/40">
              <AlertTriangle className="mx-auto mb-2 h-6 w-6" />
              <p className="font-semibold">Couldn&apos;t load the design editor</p>
              <p className="mt-1 text-xs text-red-600 dark:text-red-400">{error}</p>
            </div>
          </div>
        )}
        <iframe
          ref={iframeRef}
          src={src}
          title={`Edit ${title}`}
          className="h-full w-full border-0 bg-background"
          allow="clipboard-read; clipboard-write; fullscreen"
          allowFullScreen
          onError={() => setError('The configured OpenPencil service could not be reached.')}
        />
      </div>
    );
  },
);
