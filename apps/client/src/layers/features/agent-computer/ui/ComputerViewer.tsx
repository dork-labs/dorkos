/* The guest desktop is an application, not a button or text field. Its keyboard exit is explicit. */
/* eslint-disable jsx-a11y/no-noninteractive-element-interactions, jsx-a11y/no-noninteractive-tabindex */
import { useCallback, useEffect, useRef, useState } from 'react';
import type {
  ComputerControlLease,
  ComputerFrame,
  ComputerInput,
} from '@dorkos/shared/computer-schemas';
import { useTransport } from '@/layers/shared/model';
import { Button, Input } from '@/layers/shared/ui';
import { cn } from '@/layers/shared/lib/utils';

export interface ComputerViewerProps {
  generation: number;
  onClose: () => void;
}

/** The authenticated framebuffer is shared with the guest tools; observe never sends input. */
export function ComputerViewer({ generation, onClose }: ComputerViewerProps) {
  const transport = useTransport();
  const [frame, setFrame] = useState<ComputerFrame | null>(null);
  const [lease, setLease] = useState<ComputerControlLease | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(false);
  const [draft, setDraft] = useState('');
  const [typing, setTyping] = useState(false);
  const currentLease = useRef<ComputerControlLease | null>(null);
  const inputQueue = useRef(Promise.resolve());
  const mounted = useRef(true);
  const image = useRef<HTMLDivElement>(null);
  const movePending = useRef(false);
  const acquisitionRevision = useRef(0);

  const dropControl = useCallback(() => {
    acquisitionRevision.current += 1;
    currentLease.current = null;
    movePending.current = false;
    setLease(null);
    setDraft('');
    setTyping(false);
  }, []);

  const returnControl = useCallback(async () => {
    const previous = currentLease.current;
    dropControl();
    if (previous) {
      try {
        await transport.releaseComputerControl(previous.leaseId);
      } catch {
        // Server revocation and expiry still fence delayed input; surface loss of reachability.
        if (mounted.current) setError(true);
      }
    }
  }, [transport, dropControl]);

  useEffect(() => {
    // A new guest generation invalidates the external framebuffer and all local input state.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setFrame(null);
    setError(false);
    setBusy(false);
    void returnControl();
  }, [generation, returnControl]);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      const previous = currentLease.current;
      currentLease.current = null;
      if (previous) void transport.releaseComputerControl(previous.leaseId).catch(() => {});
    };
  }, [transport]);

  useEffect(() => {
    const releaseOnBlur = () => {
      void returnControl();
    };
    const releaseWhenHidden = () => {
      if (document.hidden) void returnControl();
    };
    window.addEventListener('blur', releaseOnBlur);
    document.addEventListener('visibilitychange', releaseWhenHidden);
    return () => {
      window.removeEventListener('blur', releaseOnBlur);
      document.removeEventListener('visibilitychange', releaseWhenHidden);
    };
  }, [returnControl]);

  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      const observedLease = currentLease.current;
      try {
        const next = await transport.getComputerFrame();
        if (cancelled) return;
        if (next.generation !== generation) {
          setFrame(null);
          setError(true);
          void returnControl();
        } else {
          if (
            next.controlledByYou === false &&
            observedLease &&
            currentLease.current === observedLease
          )
            dropControl();
          setFrame(next);
        }
      } catch {
        if (!cancelled) {
          setFrame(null);
          setError(true);
          void returnControl();
        }
      }
      if (!cancelled) timer = setTimeout(() => void poll(), 500);
    };
    void poll();
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [generation, transport, returnControl, dropControl]);

  const takeOver = async () => {
    if (busy) return;
    const revision = acquisitionRevision.current;
    setBusy(true);
    setError(false);
    try {
      const next = await transport.acquireComputerControl();
      if (
        !mounted.current ||
        next.generation !== generation ||
        acquisitionRevision.current !== revision
      ) {
        await transport.releaseComputerControl(next.leaseId);
        return;
      }
      currentLease.current = next;
      setLease(next);
      image.current?.focus();
    } catch {
      if (mounted.current) setError(true);
    } finally {
      if (mounted.current) setBusy(false);
    }
  };

  const send = (
    event:
      | Omit<Extract<ComputerInput, { kind: 'pointer' }>, 'leaseId' | 'generation'>
      | Omit<Extract<ComputerInput, { kind: 'key' }>, 'leaseId' | 'generation'>
      | Omit<Extract<ComputerInput, { kind: 'text' }>, 'leaseId' | 'generation'>
  ) => {
    const captured = currentLease.current;
    if (!captured || captured.generation !== generation) return;
    const isMove = event.kind === 'pointer' && event.action === 'move';
    if (isMove && movePending.current) return;
    if (isMove) movePending.current = true;
    // Serial delivery preserves key/button order; a revoked lease drops queued input locally too.
    const pending = inputQueue.current.then(async () => {
      if (currentLease.current !== captured || !mounted.current) {
        if (isMove) movePending.current = false;
        return false;
      }
      try {
        await transport.sendComputerInput({ ...event, ...captured });
        return true;
      } catch {
        if (mounted.current) {
          setError(true);
          await returnControl();
        }
        return false;
      } finally {
        if (isMove) movePending.current = false;
      }
    });
    inputQueue.current = pending.then(() => undefined);
    return pending;
  };

  const pointer = (event: React.PointerEvent<HTMLDivElement>, action: 'move' | 'down' | 'up') => {
    if (!currentLease.current || !frame) return;
    event.preventDefault();
    if (action === 'down') {
      event.currentTarget.focus();
      event.currentTarget.setPointerCapture?.(event.pointerId);
    }
    const rect = event.currentTarget.getBoundingClientRect();
    if (!rect.width || !rect.height) return;
    send({
      kind: 'pointer',
      action,
      button: Math.max(0, Math.min(2, event.button)),
      x: Math.max(
        0,
        Math.min(
          frame.width - 1,
          Math.floor(((event.clientX - rect.left) * frame.width) / rect.width)
        )
      ),
      y: Math.max(
        0,
        Math.min(
          frame.height - 1,
          Math.floor(((event.clientY - rect.top) * frame.height) / rect.height)
        )
      ),
    });
  };

  return (
    <section
      data-slot="computer-viewer"
      aria-label="Computer desktop"
      className="space-y-3"
      onBlur={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget)) void returnControl();
      }}
    >
      <div className="flex flex-wrap items-center gap-2">
        <p className="text-muted-foreground mr-auto text-sm" role="status">
          {lease ? 'You have control' : 'Watching'}
        </p>
        {lease ? (
          <Button variant="outline" onClick={() => void returnControl()}>
            Return control
          </Button>
        ) : (
          // Keep the pending acquisition focusable: native disabling can blur to body and revoke it.
          <Button
            variant="outline"
            disabled={!frame}
            aria-disabled={busy || !frame}
            aria-busy={busy}
            onClick={() => void takeOver()}
          >
            Take over
          </Button>
        )}
        <Button variant="ghost" onClick={onClose}>
          Close view
        </Button>
      </div>
      {error && (
        <p role="alert" className="text-destructive text-sm">
          Couldn’t control the computer. Reconnect and try again.
        </p>
      )}
      {frame ? (
        <div
          ref={image}
          role="application"
          aria-label="Computer desktop control"
          aria-describedby="computer-control-help"
          tabIndex={lease ? 0 : -1}
          className={cn(
            'focus-visible:ring-ring block h-auto w-full rounded-md outline-none select-none focus-visible:ring-2',
            lease ? 'touch-none' : 'touch-pan-y'
          )}
          onDragStart={(event) => event.preventDefault()}
          onContextMenu={(event) => event.preventDefault()}
          onPointerDown={(event) => pointer(event, 'down')}
          onPointerMove={(event) => pointer(event, 'move')}
          onPointerUp={(event) => pointer(event, 'up')}
          onPointerCancel={() => void returnControl()}
          onKeyDown={(event) => {
            if (!currentLease.current) return;
            event.preventDefault();
            if (event.key === 'Escape' && event.ctrlKey && event.shiftKey) {
              void returnControl();
              return;
            }
            if (!event.repeat) send({ kind: 'key', key: event.key, action: 'down' });
          }}
          onKeyUp={(event) => {
            if (!currentLease.current) return;
            event.preventDefault();
            send({ kind: 'key', key: event.key, action: 'up' });
          }}
        >
          <img
            src={frame.dataUrl}
            width={frame.width}
            height={frame.height}
            alt="Live computer desktop"
            draggable={false}
            className="block h-auto w-full rounded-md"
          />
        </div>
      ) : (
        <p role="status" className="text-muted-foreground py-10 text-center text-sm">
          Waiting for the desktop…
        </p>
      )}
      {lease && (
        <form
          className="flex flex-wrap gap-2"
          onSubmit={(event) => {
            event.preventDefault();
            if (!draft || typing) return;
            const text = draft;
            setTyping(true);
            void Promise.resolve(send({ kind: 'text', text }))
              .then((sent) => {
                if (mounted.current && sent)
                  setDraft((current) => (current === text ? '' : current));
              })
              .finally(() => {
                if (mounted.current) setTyping(false);
              });
          }}
        >
          <Input
            aria-label="Type on computer"
            placeholder="Type on computer"
            value={draft}
            maxLength={4096}
            autoComplete="off"
            autoCorrect="off"
            autoCapitalize="none"
            spellCheck={false}
            className="min-w-0 flex-1"
            onChange={(event) => setDraft(event.target.value)}
          />
          {/* Preserve focus during delivery and clearing; native disabling can release the lease. */}
          <Button type="submit" aria-disabled={typing || !draft} aria-busy={typing}>
            Type
          </Button>
          <Button
            type="button"
            variant="outline"
            onClick={() => {
              send({ kind: 'key', key: 'Enter', action: 'down' });
              send({ kind: 'key', key: 'Enter', action: 'up' });
            }}
          >
            Enter
          </Button>
        </form>
      )}
      <p id="computer-control-help" className="text-muted-foreground text-xs">
        Press Control + Shift + Escape to return control.
      </p>
      <p className="text-muted-foreground text-xs">Closing this view keeps the computer running.</p>
    </section>
  );
}
