import { useEffect, useRef, useState } from 'react';
import type { ManagedBrowserCanvasReference } from '@dorkos/shared/types';
import { useTransport } from '@/layers/shared/model';
import { Button } from '@/layers/shared/ui';

/** Explicit room sharing. A roster choice never supplies browser authority. */
export function ManagedBrowserCanvasShare({
  content,
  lossSignal,
}: {
  content: ManagedBrowserCanvasReference;
  lossSignal: AbortSignal;
}) {
  const transport = useTransport(),
    canvas = transport.browserCanvas;
  const active = useRef(true),
    work = useRef<Promise<void> | undefined>(undefined);
  const [members, setMembers] = useState<{ id: string; name: string }[]>(),
    [recipient, setRecipient] = useState(''),
    [control, setControl] = useState(false),
    [busy, setBusy] = useState(false),
    [message, setMessage] = useState<string>();
  useEffect(() => {
    active.current = true;
    return () => {
      active.current = false;
    };
  }, [content]);
  const load = () => {
    if (!canvas || work.current || lossSignal.aborted || content.scope.kind !== 'room') return;
    const roomId = content.scope.roomId;
    setBusy(true);
    const original = Promise.resolve().then(async () => {
      if (!active.current || lossSignal.aborted) return;
      const row = await transport.getRoom(roomId);
      if (active.current && !lossSignal.aborted)
        setMembers(
          row.members
            .filter((member) => member.authorId !== content.ownerAuthorId)
            .map((member) => ({
              id: member.authorId,
              name: member.author.displayName,
            }))
        );
    });
    work.current = original;
    void original
      .then(
        () => {
          if (active.current) setBusy(false);
        },
        () => {
          if (active.current) {
            setBusy(false);
            setMessage('Could not load the room members.');
          }
        }
      )
      .finally(() => {
        if (work.current === original) work.current = undefined;
      });
  };
  const share = () => {
    if (
      !canvas ||
      !members?.some((member) => member.id === recipient) ||
      work.current ||
      lossSignal.aborted
    )
      return;
    setBusy(true);
    setMessage(undefined);
    const original = Promise.resolve().then(async () => {
      if (!active.current || lossSignal.aborted) return;
      await canvas.shareBrowserCanvas(
        {
          attachmentId: content.attachmentId,
          recipient,
          permissions: control ? ['browser.view', 'browser.control'] : ['browser.view'],
          expiresAt: new Date(Date.now() + 600000).toISOString(),
        },
        lossSignal
      );
      if (active.current && !lossSignal.aborted)
        setMessage('Access shared for 10 minutes. Removing this canvas ends that access.');
    });
    work.current = original;
    void original
      .then(
        () => {
          if (active.current) setBusy(false);
        },
        () => {
          if (active.current) {
            setBusy(false);
            setMessage('Could not share this browser.');
          }
        }
      )
      .finally(() => {
        if (work.current === original) work.current = undefined;
      });
  };
  if (!canvas || content.scope.kind !== 'room') return null;
  return (
    <div className="flex flex-wrap items-center gap-2">
      {!members ? (
        <Button size="sm" variant="outline" onClick={load} disabled={busy || lossSignal.aborted}>
          Share access
        </Button>
      ) : (
        <>
          <label className="text-sm" htmlFor={`browser-share-${content.attachmentId}`}>
            Room member
          </label>
          <select
            id={`browser-share-${content.attachmentId}`}
            value={recipient}
            onChange={(event) => setRecipient(event.target.value)}
            disabled={busy}
            className="border-input rounded-md border px-2 py-1 text-sm"
          >
            <option value="">Choose a member</option>
            {members.map((member) => (
              <option key={member.id} value={member.id}>
                {member.name}
              </option>
            ))}
          </select>
          <label className="flex items-center gap-1 text-sm">
            <input
              type="checkbox"
              checked={control}
              onChange={(event) => setControl(event.target.checked)}
              disabled={busy}
            />
            Allow control
          </label>
          <Button size="sm" onClick={share} disabled={busy || !recipient || lossSignal.aborted}>
            Share for 10 minutes
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
