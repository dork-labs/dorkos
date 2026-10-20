/* The guest desktop is an application, not a button or text field. Its keyboard exit is explicit. */
/* eslint-disable jsx-a11y/no-noninteractive-element-interactions, jsx-a11y/no-noninteractive-tabindex */
import { useEffect, useRef, useId } from 'react';
import { useComputerViewer } from '@/layers/entities/computer';
import { Button } from '@/layers/shared/ui';
import { ComputerTypingControls } from './ComputerTypingControls';
import { cn } from '@/layers/shared/lib/utils';

export interface ComputerViewerProps {
  generation: number;
  onClose?: () => void;
}

/** Observe the shared desktop; only this presenter can send its leased input. */
export function ComputerViewer({ generation, onClose }: ComputerViewerProps) {
  const { frame, lease, busy, error, controlError, controlledElsewhere, session, owner } =
    useComputerViewer(generation);
  const image = useRef<HTMLDivElement>(null);
  const helpId = useId();
  const returnControl = session.release;
  const send = (event: Parameters<typeof session.send>[1]) => session.send(owner, event);
  const takeOver = async () => {
    await session.acquire(owner);
    image.current?.focus();
  };
  useEffect(() => {
    const release = () => {
      void session.releaseFor(owner);
    };
    const hidden = () => {
      if (document.hidden) release();
    };
    window.addEventListener('blur', release);
    document.addEventListener('visibilitychange', hidden);
    return () => {
      window.removeEventListener('blur', release);
      document.removeEventListener('visibilitychange', hidden);
    };
  }, [session, owner, returnControl]);
  const pointer = (event: React.PointerEvent<HTMLDivElement>, action: 'move' | 'down' | 'up') => {
    if (!lease || !frame) return;
    const rect = event.currentTarget.getBoundingClientRect();
    if (!rect.width || !rect.height) return;
    const scale = Math.min(rect.width / frame.width, rect.height / frame.height);
    const left = rect.left + (rect.width - frame.width * scale) / 2;
    const top = rect.top + (rect.height - frame.height * scale) / 2;
    const outside =
      event.clientX < left ||
      event.clientX > left + frame.width * scale ||
      event.clientY < top ||
      event.clientY > top + frame.height * scale;
    if (outside && !event.currentTarget.hasPointerCapture?.(event.pointerId)) return;
    event.preventDefault();
    if (action === 'down') {
      event.currentTarget.focus();
      event.currentTarget.setPointerCapture?.(event.pointerId);
    }
    send({
      kind: 'pointer',
      action,
      button: Math.max(0, Math.min(2, event.button)),
      x: Math.max(0, Math.min(frame.width - 1, Math.floor((event.clientX - left) / scale))),
      y: Math.max(0, Math.min(frame.height - 1, Math.floor((event.clientY - top) / scale))),
    });
  };

  return (
    <section
      data-slot="computer-viewer"
      aria-label="Computer desktop"
      className="flex h-full min-h-0 flex-col gap-2 overflow-auto p-3"
      onBlur={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget)) void session.releaseFor(owner);
      }}
    >
      <div className="flex shrink-0 flex-wrap items-center gap-2">
        <p className="text-muted-foreground mr-auto text-sm" role="status">
          {error ? 'Disconnected' : lease ? 'You have control' : frame ? 'Watching' : 'Connecting…'}
        </p>
        {lease ? (
          <Button variant="outline" onClick={() => void returnControl()}>
            Return control
          </Button>
        ) : (
          // Keep the pending acquisition focusable: native disabling can blur to body and revoke it.
          <Button
            variant="outline"
            disabled={!frame || controlledElsewhere}
            aria-disabled={busy || !frame || controlledElsewhere}
            aria-busy={busy}
            onClick={() => void takeOver()}
          >
            Take over
          </Button>
        )}
        {onClose && (
          <Button variant="ghost" onClick={onClose}>
            Close view
          </Button>
        )}
      </div>
      {error && (
        <p role="alert" className="text-destructive text-sm">
          Disconnected. Trying to reconnect…
        </p>
      )}
      {controlError && !error && (
        <p role="alert" className="text-destructive text-sm">
          Couldn’t take control. Try again.
        </p>
      )}
      {frame ? (
        <div
          ref={image}
          role="application"
          aria-label="Computer desktop control"
          aria-describedby={helpId}
          tabIndex={lease ? 0 : -1}
          className={cn(
            'focus-visible:ring-ring block min-h-20 w-full flex-1 rounded-md outline-none select-none focus-visible:ring-2',
            lease ? 'touch-none' : 'touch-pan-y'
          )}
          onDragStart={(event) => event.preventDefault()}
          onContextMenu={(event) => event.preventDefault()}
          onPointerDown={(event) => pointer(event, 'down')}
          onPointerMove={(event) => pointer(event, 'move')}
          onPointerUp={(event) => pointer(event, 'up')}
          onPointerCancel={() => void session.releaseFor(owner)}
          onKeyDown={(event) => {
            if (!lease) return;
            event.preventDefault();
            if (event.key === 'Escape' && event.ctrlKey && event.shiftKey) {
              void returnControl();
              return;
            }
            if (!event.repeat) send({ kind: 'key', key: event.key, action: 'down' });
          }}
          onKeyUp={(event) => {
            if (!lease) return;
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
            className="block h-full w-full rounded-md object-contain"
          />
        </div>
      ) : (
        <p role="status" className="text-muted-foreground py-10 text-center text-sm">
          Waiting for the desktop…
        </p>
      )}
      {lease && <ComputerTypingControls key={lease.leaseId} send={send} />}
      <p id={helpId} className={cn('text-muted-foreground shrink-0 text-xs', !lease && 'sr-only')}>
        Press Control + Shift + Escape to return control.
      </p>
      {onClose && (
        <p className="text-muted-foreground shrink-0 text-xs">
          Closing this view keeps the computer running.
        </p>
      )}
    </section>
  );
}
