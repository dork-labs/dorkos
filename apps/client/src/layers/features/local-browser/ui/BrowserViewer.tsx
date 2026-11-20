import { useEffect, useRef, useState } from 'react';
import type { BrowserViewerSubscription } from '@dorkos/shared/transport-local-browser';
import { useTransport } from '@/layers/shared/model';
import { Button } from '@/layers/shared/ui';
import { PageAreaBlock } from './PageAreaBlock';

/** The page selected in the panel; these facts fence stale UI responses, never grant access. */
export interface BrowserViewerProps {
  chatId: string;
  connectionId: string | null;
  tabId: string | null;
  visible: boolean;
}

type Phase = 'watching' | 'unavailable' | 'owner-only' | 'local-only';

function afterPaint(signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    let frame = 0;
    const done = () => {
      cancelAnimationFrame(frame);
      signal.removeEventListener('abort', done);
      resolve();
    };
    signal.addEventListener('abort', done, { once: true });
    frame = requestAnimationFrame(() => {
      frame = requestAnimationFrame(done);
    });
    if (signal.aborted) done();
  });
}

function reconnectDelay(signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const done = () => {
      clearTimeout(timer);
      signal.removeEventListener('abort', done);
      resolve();
    };
    const timer = setTimeout(done, 500);
    signal.addEventListener('abort', done, { once: true });
    if (signal.aborted) done();
  });
}

/** A volatile canvas for the person's stream. No input, page text, storage or recording. */
export function BrowserViewer({ chatId, connectionId, tabId, visible }: BrowserViewerProps) {
  const transport = useTransport();
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [attempt, retry] = useState(0);
  const [documentVisible, setDocumentVisible] = useState(
    () => document.visibilityState !== 'hidden'
  );
  const key = JSON.stringify([chatId, connectionId, tabId, attempt, visible, documentVisible]);
  const [phase, setPhase] = useState<{ key: string; value: Phase } | null>(null);
  const currentPhase = phase?.key === key ? phase.value : null;

  useEffect(() => {
    const changed = () => setDocumentVisible(document.visibilityState !== 'hidden');
    document.addEventListener('visibilitychange', changed);
    return () => document.removeEventListener('visibilitychange', changed);
  }, []);

  useEffect(() => {
    const canvas = canvasRef.current;
    const clear = () => {
      canvas?.getContext('2d')?.clearRect(0, 0, canvas.width, canvas.height);
      if (canvas) canvas.width = canvas.height = 0;
    };
    clear();
    if (!visible || !documentVisible || !connectionId || !tabId || !canvas) return;
    const controller = new AbortController();
    const { signal } = controller;
    let viewer: BrowserViewerSubscription | undefined;
    const release = () => {
      const current = viewer;
      viewer = undefined;
      if (current) void transport.closeBrowserViewer(current).catch(() => undefined);
    };
    const watch = async () => {
      while (!signal.aborted) {
        let reconnect = false;
        try {
          const opened = await transport.subscribeBrowserViewer(chatId, signal);
          if (signal.aborted) {
            void transport.closeBrowserViewer(opened).catch(() => undefined);
            return;
          }
          viewer = opened;
          if (
            opened.binding.chatId !== chatId ||
            opened.binding.connectionId !== connectionId ||
            opened.binding.tabId !== tabId
          )
            throw Error('viewer_binding_changed');
          let receipt: string | undefined;
          let sequence = 0;
          let generation: number | undefined;
          while (!signal.aborted) {
            const frame = await transport.nextBrowserViewerFrame(opened, receipt, signal);
            // Even an idle response consumed the preceding paint receipt.
            receipt = undefined;
            if (!frame) continue;
            try {
              if (signal.aborted) return;
              if (
                frame.sequence <= sequence ||
                (generation !== undefined && generation !== frame.generation)
              )
                throw Error('viewer_frame_invalid');
              const blob = new Blob([new Uint8Array(frame.bytes)], { type: 'image/jpeg' });
              frame.bytes.fill(0);
              const image = await createImageBitmap(blob);
              try {
                if (signal.aborted) return;
                if (image.width !== frame.width || image.height !== frame.height)
                  throw Error('viewer_frame_invalid');
                const context = canvas.getContext('2d');
                if (!context) throw Error('viewer_frame_invalid');
                canvas.width = frame.width;
                canvas.height = frame.height;
                context.drawImage(image, 0, 0);
                sequence = frame.sequence;
                generation = frame.generation;
                setPhase({ key, value: 'watching' });
              } finally {
                image.close();
              }
              await afterPaint(signal);
              if (!signal.aborted) receipt = frame.receipt;
            } finally {
              frame.bytes.fill(0);
            }
          }
        } catch (error) {
          if (signal.aborted) return;
          clear();
          const code = (error as { code?: string }).code;
          reconnect = code === 'viewer_unavailable';
          setPhase({
            key,
            value:
              code === 'viewer_person_only' || code === 'viewer_denied'
                ? 'owner-only'
                : code === 'viewer_local_only'
                  ? 'local-only'
                  : 'unavailable',
          });
        } finally {
          release();
        }
        if (!reconnect) return;
        await reconnectDelay(signal);
      }
    };
    void watch();
    return () => {
      controller.abort();
      clear();
      release();
    };
  }, [transport, chatId, connectionId, tabId, visible, documentVisible, key]);

  const watching = currentPhase === 'watching' && visible && documentVisible;
  const message =
    currentPhase === 'owner-only'
      ? 'Sign in to DorkOS as its owner to watch.'
      : currentPhase === 'local-only'
        ? 'Open DorkOS on your computer to watch.'
        : currentPhase === 'unavailable'
          ? 'The live view stopped.'
          : 'Connecting to the browser…';
  return (
    <div className="relative flex min-h-48 min-w-0 flex-1 flex-col" data-slot="browser-viewer">
      <canvas
        ref={canvasRef}
        role="img"
        aria-label="Agent browser page"
        hidden={!watching}
        className="h-full min-h-0 w-full flex-1 object-contain"
      />
      {watching ? (
        <p className="text-muted-foreground px-3 py-2 text-center text-xs">
          To click or type, use the Chrome window.
        </p>
      ) : (
        <PageAreaBlock>
          <p role="status" className="text-muted-foreground text-center text-sm">
            {message}
          </p>
          {currentPhase === 'unavailable' && (
            <Button size="sm" variant="outline" onClick={() => retry((value) => value + 1)}>
              Reconnect
            </Button>
          )}
        </PageAreaBlock>
      )}
    </div>
  );
}
