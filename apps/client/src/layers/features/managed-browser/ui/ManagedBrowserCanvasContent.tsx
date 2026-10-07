import { useEffect, useRef, useState } from 'react';
import type { ManagedBrowserCanvasReference } from '@dorkos/shared/types';
import type { BrowserViewerContext } from '@/layers/entities/browser';
import type { BrowserViewerTransport } from '@dorkos/shared/transport';
import { useTransport } from '@/layers/shared/model';
import { Button } from '@/layers/shared/ui';
import { ManagedBrowserCanvasShare } from './ManagedBrowserCanvasShare';
import { ManagedBrowserViewer } from './ManagedBrowserViewer';

type Selection = {
  owner: boolean;
  reference: ManagedBrowserCanvasReference;
  delivery: BrowserViewerTransport;
  context: BrowserViewerContext;
  loss: AbortController;
};
/** A replay reference is inert until the person requests a fresh authenticated view. */
export function ManagedBrowserCanvasContent({
  content,
}: {
  content: ManagedBrowserCanvasReference;
}) {
  const transport = useTransport().browserCanvas;
  const live = useRef(true),
    original = useRef<Promise<void> | undefined>(undefined),
    pending = useRef<AbortController | undefined>(undefined);
  const retainedSelection = useRef<Selection | undefined>(undefined);
  const [selection, setSelection] = useState<Selection>(),
    [busy, setBusy] = useState(false),
    [failed, setFailed] = useState(false);
  useEffect(() => {
    live.current = true;
    return () => {
      live.current = false;
      pending.current?.abort();
      retainedSelection.current?.loss.abort();
    };
  }, [content, transport]);
  const view = () => {
    if (!transport || original.current || !live.current) return;
    const cancellation = new AbortController();
    pending.current = cancellation;
    selection?.loss.abort();
    setBusy(true);
    setFailed(false);
    const work = Promise.resolve().then(async () => {
      if (!live.current || cancellation.signal.aborted) return;
      const receipt = await transport.resolveBrowserCanvas(
        { attachmentId: content.attachmentId },
        cancellation.signal
      );
      cancellation.signal.throwIfAborted();
      if (
        !live.current ||
        receipt.binding.browserId !== content.browserId ||
        receipt.binding.browserGeneration !== content.browserGeneration ||
        receipt.binding.tabId !== content.tabId
      )
        throw new Error('Browser presentation changed');
      const delivery = transport.createCanvasViewerDelivery(receipt);
      if (!live.current || cancellation.signal.aborted) return;
      const next = {
        owner: receipt.owner,
        reference: content,
        delivery,
        context: { identity: Object.freeze({}), binding: receipt.binding },
        loss: cancellation,
      };
      retainedSelection.current = next;
      setSelection(next);
    });
    original.current = work;
    void work
      .then(
        () => {
          if (live.current) setBusy(false);
        },
        () => {
          if (live.current) {
            setBusy(false);
            setFailed(true);
          }
        }
      )
      .finally(() => {
        if (original.current === work) original.current = undefined;
      });
  };
  const current = selection?.reference === content ? selection : undefined;
  return (
    <section className="flex h-full min-h-0 flex-col gap-2" aria-label="Shared browser">
      <div className="flex items-center gap-2">
        <Button size="sm" disabled={!transport || busy} onClick={view}>
          {busy ? 'Opening…' : 'View browser'}
        </Button>
        {failed && (
          <p role="status" className="text-muted-foreground text-sm">
            This browser is no longer available to view.
          </p>
        )}
      </div>
      {current?.owner && (
        <ManagedBrowserCanvasShare content={content} lossSignal={current.loss.signal} />
      )}
      {current && (
        <ManagedBrowserViewer
          delivery={current.delivery}
          context={current.context}
          lossSignal={current.loss.signal}
          className="min-h-0 flex-1"
        />
      )}
    </section>
  );
}
