import { useEffect, useRef, useState } from 'react';
import type { BrowserBinding, BrowserAttachment } from '@dorkos/shared/browser-schemas';
import { useTransport } from '@/layers/shared/model';
import { Button } from '@/layers/shared/ui';

type Target = { value: string; label: string; scope: BrowserAttachment };
/** Explicit owner presentation. Scope membership is independently checked by the server. */
export function ManagedBrowserAttach({
  binding,
  lossSignal,
}: {
  binding: BrowserBinding;
  lossSignal: AbortSignal;
}) {
  const transport = useTransport(),
    canvas = transport.browserCanvas;
  const live = useRef(true),
    work = useRef<Promise<void> | undefined>(undefined);
  const [targets, setTargets] = useState<Target[]>(),
    [chosen, setChosen] = useState(''),
    [message, setMessage] = useState<string>(),
    [busy, setBusy] = useState(false);
  useEffect(() => {
    live.current = true;
    return () => {
      live.current = false;
    };
  }, [binding]);
  const load = () => {
    if (!canvas || work.current || lossSignal.aborted) return;
    setBusy(true);
    setMessage(undefined);
    const original = Promise.resolve().then(async () => {
      if (!live.current || lossSignal.aborted) return;
      const sessions = transport.listSessions.bind(transport),
        rooms = transport.listRooms.bind(transport);
      if (!live.current || lossSignal.aborted) return;
      const [sessionRows, roomRows] = await Promise.all([sessions(), rooms()]);
      if (!live.current || lossSignal.aborted) return;
      setTargets([
        ...sessionRows.sessions.map((row) => ({
          value: `session:${row.id}`,
          label: row.title,
          scope: { kind: 'session' as const, sessionId: row.id },
        })),
        ...roomRows
          .filter((row) => !row.archived)
          .map((row) => ({
            value: `room:${row.id}`,
            label: row.title,
            scope: { kind: 'room' as const, roomId: row.id },
          })),
      ]);
    });
    work.current = original;
    void original
      .then(
        () => {
          if (live.current) setBusy(false);
        },
        () => {
          if (live.current) {
            setBusy(false);
            setMessage('Could not load your chats and rooms.');
          }
        }
      )
      .finally(() => {
        if (work.current === original) work.current = undefined;
      });
  };
  const attach = () => {
    const target = targets?.find((value) => value.value === chosen);
    if (!canvas || !target || work.current || lossSignal.aborted) return;
    setBusy(true);
    setMessage(undefined);
    const original = Promise.resolve().then(async () => {
      if (!live.current || lossSignal.aborted) return;
      await canvas.presentBrowserCanvas({ binding, target: target.scope }, lossSignal);
      if (live.current && !lossSignal.aborted) setMessage('Browser added to the canvas.');
    });
    work.current = original;
    void original
      .then(
        () => {
          if (live.current) setBusy(false);
        },
        () => {
          if (live.current) {
            setBusy(false);
            setMessage('Could not add this browser to that canvas.');
          }
        }
      )
      .finally(() => {
        if (work.current === original) work.current = undefined;
      });
  };
  if (!canvas) return null;
  return (
    <div className="flex flex-wrap items-center gap-2">
      {!targets ? (
        <Button
          type="button"
          size="sm"
          variant="outline"
          disabled={busy || lossSignal.aborted}
          onClick={load}
        >
          Add to canvas
        </Button>
      ) : (
        <>
          <label className="text-sm" htmlFor="managed-browser-canvas-target">
            Chat or room
          </label>
          <select
            id="managed-browser-canvas-target"
            aria-label="Chat or room"
            value={chosen}
            onChange={(event) => setChosen(event.target.value)}
            disabled={busy}
            className="border-input rounded-md border px-2 py-1 text-sm"
          >
            <option value="">Choose a chat or room</option>
            {targets.map((target) => (
              <option key={target.value} value={target.value}>
                {target.label}
              </option>
            ))}
          </select>
          <Button
            type="button"
            size="sm"
            disabled={!chosen || busy || lossSignal.aborted}
            onClick={attach}
          >
            Add browser
          </Button>
        </>
      )}
      {message && (
        <p role="status" className="text-muted-foreground text-sm">
          {message}
        </p>
      )}
    </div>
  );
}
