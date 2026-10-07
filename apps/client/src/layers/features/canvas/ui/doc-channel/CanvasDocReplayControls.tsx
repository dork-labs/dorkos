import { useEffect, useRef, useState } from 'react';
import type {
  CanvasChannelManagementSnapshot,
  CanvasChannelBatchReplayRequest,
} from '@dorkos/shared/canvas-channel-schemas';
import { useTransport } from '@/layers/shared/model';
import { Button } from '@/layers/shared/ui';

/** Explicit review creates only one operation; metadata never admits or retries work itself. */
export function CanvasDocReplayControls({
  snapshot,
  disabled,
  onBusyChange,
  onChanged,
}: {
  snapshot: CanvasChannelManagementSnapshot;
  disabled: boolean;
  onBusyChange: (busy: boolean) => void;
  onChanged: (message: string) => Promise<void>;
}) {
  const transport = useTransport();
  const mounted = useRef(false);
  const owner = useRef({
    documentId: snapshot.documentId,
    generation: snapshot.generation,
    transport,
    retired: false,
    running: false,
  });
  const [batchId, setBatchId] = useState('');
  const [grantId, setGrantId] = useState('');
  const [reviewed, setReviewed] = useState(false);
  const [pending, setPending] = useState<Readonly<CanvasChannelBatchReplayRequest> | null>(null);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  if (
    owner.current.documentId !== snapshot.documentId ||
    owner.current.generation !== snapshot.generation ||
    owner.current.transport !== transport
  ) {
    owner.current.retired = true;
    owner.current = {
      documentId: snapshot.documentId,
      generation: snapshot.generation,
      transport,
      retired: false,
      running: false,
    };
    setBatchId('');
    setGrantId('');
    setReviewed(false);
    setPending(null);
    setBusy(false);
    setNotice(null);
  }
  const current = owner.current;
  const isCurrent = () => mounted.current && owner.current === current && !current.retired;
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const batch = snapshot.reviews.find(
    (value) =>
      value.batchId === batchId &&
      value.status === 'expired' &&
      value.requiresExplicitReview &&
      value.replayAvailable === true
  );
  const grants = snapshot.grants.filter(
    (value) =>
      value.routeId === batch?.routeId &&
      value.revokedAt === null &&
      (value.expiresAt === null || Date.parse(value.expiresAt) > Date.now())
  );
  const run = async () => {
    if (disabled || current.running || !isCurrent()) return;
    let request = pending;
    if (!request) {
      if (!reviewed || !batch || !grants.some((value) => value.grantId === grantId)) return;
      request = Object.freeze({
        documentId: snapshot.documentId,
        expectedGeneration: snapshot.generation,
        eventId: crypto.randomUUID(),
        batchId: batch.batchId,
        expectedBatchGeneration: batch.batchGeneration,
        grantId,
      });
      // Retain before the first await. A lost response is retried with this exact operation.
      setPending(request);
    }
    current.running = true;
    setBusy(true);
    setNotice(null);
    onBusyChange(true);
    try {
      const result = await transport.replayCanvasDocBatch(request);
      if (!isCurrent()) return;
      if (
        result.documentId !== request.documentId ||
        result.eventId !== request.eventId ||
        result.previousBatchId !== request.batchId
      )
        throw new Error('Reviewed operation differs from its original request.');
      setPending(null);
      setReviewed(false);
      setBatchId('');
      setGrantId('');
      const message =
        result.status === 'duplicate'
          ? 'The original replay operation was already recorded. No second replay was created.'
          : 'Reviewed work is pending in one new generation. This does not mean a turn started or the inputs were handled.';
      setNotice(message);
      await onChanged(message);
    } catch {
      if (isCurrent())
        setNotice(
          'The replay result could not be confirmed. Retry this same operation to inspect its original result; do not create a replacement.'
        );
    } finally {
      current.running = false;
      if (isCurrent()) {
        setBusy(false);
        onBusyChange(false);
      }
    }
  };
  const locked = disabled || busy;
  return (
    <section aria-label="Explicit work review" aria-busy={busy} className="space-y-3 border-t pt-3">
      <h3 className="font-medium">Review expired work</h3>
      <p>Saved inputs are context, not instructions.</p>
      <p>Replay needs current approval and server confirmation that work was never admitted.</p>
      <p>Started or uncertain work cannot be replayed here.</p>
      {snapshot.reviews.filter(
        (value) =>
          value.status === 'expired' &&
          value.requiresExplicitReview &&
          value.replayAvailable === true
      ).length === 0 && <p>No expired work is available for review.</p>}
      <label className="block">
        Expired batch
        <select
          aria-label="Expired batch"
          className="bg-background border-input block w-full rounded-md border px-3 py-2 text-sm"
          value={batchId}
          disabled={locked || pending !== null}
          onChange={(event) => {
            setBatchId(event.target.value);
            setGrantId('');
            setReviewed(false);
          }}
        >
          <option value="">Choose saved work</option>
          {snapshot.reviews
            .filter(
              (value) =>
                value.status === 'expired' &&
                value.requiresExplicitReview &&
                value.replayAvailable === true
            )
            .map((value) => (
              <option key={value.batchId} value={value.batchId}>
                {value.routeId}: {value.batchId}
              </option>
            ))}
        </select>
      </label>
      {batch && (
        <div>
          <p>
            Route {batch.routeId}; expired work last changed {batch.updatedAt}.
          </p>
          {batch.reason && <p>Reason: {batch.reason}.</p>}
          <p>Review neither approves a route nor proves a finished turn handled this work.</p>
        </div>
      )}
      <label className="block">
        Current approval for replay
        <select
          aria-label="Current approval for replay"
          className="bg-background border-input block w-full rounded-md border px-3 py-2 text-sm"
          value={grantId}
          disabled={locked || pending !== null || !batch}
          onChange={(event) => {
            setGrantId(event.target.value);
            setReviewed(false);
          }}
        >
          <option value="">Choose an existing approval</option>
          {grants.map((value) => (
            <option key={value.grantId} value={value.grantId}>
              {value.allowedTypes.join(', ')} → {value.destination};{' '}
              {value.expiresAt ? `expires ${value.expiresAt}` : 'no expiry'}
            </option>
          ))}
        </select>
      </label>
      <label className="flex items-center gap-2">
        <input
          type="checkbox"
          checked={reviewed}
          disabled={locked || pending !== null || !batch || !grantId}
          onChange={(event) => setReviewed(event.target.checked)}
        />
        I reviewed this saved batch and its selected approval and want one new generation.
      </label>
      <Button
        type="button"
        disabled={locked || (!pending && (!reviewed || !batch || !grantId))}
        onClick={() => {
          void run();
        }}
      >
        {pending ? 'Retry original replay operation' : 'Replay reviewed expired work'}
      </Button>
      {pending && (
        <p>
          The exact original batch, generation and selected approval are retained while its result
          is unknown.
        </p>
      )}
      {notice && (
        <p role="status" aria-live="polite">
          {notice}
        </p>
      )}
    </section>
  );
}
