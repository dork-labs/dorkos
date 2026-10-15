/** One real host mount, independent of stream subscribers or frame action authority. */
import { useEffect, useRef, useState, type FocusEvent } from 'react';
import { useTransport } from '@/layers/shared/model';
import { subscribeDocChannelNotifications } from '@/layers/shared/lib/transport';
import { CanvasChannelPresenceResponseSchema } from '@dorkos/shared/canvas-channel-schemas';
/** Track this document mount's viewer count and debounced focus changes. */
export function useDocPresence(documentId: string): {
  views: number | undefined;
  onFocusCapture: (event: FocusEvent<HTMLElement>) => void;
  onBlurCapture: (event: FocusEvent<HTMLElement>) => void;
} {
  const transport = useTransport();
  const [display, setDisplay] = useState<{
    documentId: string;
    transport: typeof transport;
    views?: number;
  }>();
  const focusOwner = useRef<((focused: boolean) => void) | undefined>(undefined);
  useEffect(() => {
    let retired = false,
      viewerId: string | undefined,
      timer: ReturnType<typeof setTimeout> | undefined;
    const mountRequest = Object.freeze({ action: 'mount' as const, mountId: crypto.randomUUID() });
    let notificationVersion = 0;
    let focusTimer: ReturnType<typeof setTimeout> | undefined;
    let work = Promise.resolve();
    const present = (views: number | undefined) => {
      if (!retired) setDisplay({ documentId, transport, views });
    };
    const leave = async (id: string) => {
      await transport.updateCanvasDocPresence(documentId, { action: 'unmount', viewerId: id });
    };
    const schedule = () => {
      if (!retired)
        timer = setTimeout(() => {
          timer = undefined;
          work = work.then(beat);
          void work.catch(() => {});
        }, 30_000);
    };
    const mount = async () => {
      const version = notificationVersion;
      const response = CanvasChannelPresenceResponseSchema.parse(
        await transport.updateCanvasDocPresence(documentId, mountRequest)
      );
      if (retired) {
        await leave(response.viewerId);
        return;
      }
      viewerId = response.viewerId;
      if (notificationVersion === version) present(response.views);
      schedule();
    };
    const beat = async () => {
      const id = viewerId;
      if (retired) return;
      if (!id) {
        try {
          await mount();
        } catch {
          present(undefined);
          schedule();
        }
        return;
      }
      const version = notificationVersion;
      try {
        const response = CanvasChannelPresenceResponseSchema.parse(
          await transport.updateCanvasDocPresence(documentId, { action: 'heartbeat', viewerId: id })
        );
        if (response.viewerId !== id)
          throw new Error('The presence heartbeat differs from this original mount.');
        if (!retired && notificationVersion === version) present(response.views);
        schedule();
      } catch (cause) {
        if (retired) return;
        present(undefined);
        // Only an actual typed HTTP 404 proves that this issued viewer no longer exists.
        // A dropped connection/response does not authorize a second mount.
        if (cause && typeof cause === 'object' && 'status' in cause && cause.status === 404) {
          viewerId = undefined;
          try {
            await mount();
          } catch {
            present(undefined);
            schedule();
          }
        } else schedule();
      }
    };
    const focus = (focused: boolean) => {
      if (retired) return;
      if (focusTimer !== undefined) clearTimeout(focusTimer);
      focusTimer = setTimeout(() => {
        focusTimer = undefined;
        const prior = work;
        work = prior
          .then(async () => {
            if (retired || !viewerId) return;
            const id = viewerId;
            const response = CanvasChannelPresenceResponseSchema.parse(
              await transport.updateCanvasDocPresence(documentId, {
                action: 'focus',
                viewerId: id,
                focused,
              })
            );
            if (response.viewerId !== id) throw new Error('The original focus mount changed.');
          })
          .catch(() => present(undefined));
      }, 500);
    };
    focusOwner.current = focus;
    const off = subscribeDocChannelNotifications(
      undefined,
      (frame) => {
        if (
          retired ||
          frame.documentId !== documentId ||
          frame.type !== 'canvas_event' ||
          frame.event.direction !== 'system' ||
          frame.event.type !== 'doc.viewers'
        )
          return;
        const payload = frame.event.payload;
        if (
          !payload ||
          typeof payload !== 'object' ||
          Array.isArray(payload) ||
          Object.keys(payload).length !== 1 ||
          !('views' in payload) ||
          typeof payload.views !== 'number' ||
          !Number.isSafeInteger(payload.views) ||
          payload.views < 0
        )
          return;
        notificationVersion++;
        present(payload.views);
      },
      transport,
      () => present(undefined)
    );
    // React may retire an initial setup before its queued work begins (including
    // development effect replay). Only a still-owned setup starts native work.
    // Once started, its original response continues to own its eventual leave.
    work = work.then(async () => {
      if (retired) return;
      try {
        await mount();
      } catch {
        present(undefined);
        schedule();
      }
    });
    return () => {
      retired = true;
      if (focusOwner.current === focus) focusOwner.current = undefined;
      if (focusTimer !== undefined) clearTimeout(focusTimer);
      off();
      if (timer !== undefined) clearTimeout(timer);
      // A pending original mount response owns its eventual leave too.
      // React cannot await teardown; both native requests are immediately handled.
      void work
        .then(async () => {
          if (viewerId) await leave(viewerId);
        })
        .catch(() => {});
    };
  }, [documentId, transport]);
  return {
    views:
      display?.documentId === documentId && display.transport === transport
        ? display.views
        : undefined,
    onFocusCapture: (event) => {
      if (
        !(event.relatedTarget instanceof Node) ||
        !event.currentTarget.contains(event.relatedTarget)
      )
        focusOwner.current?.(true);
    },
    onBlurCapture: (event) => {
      if (
        !(event.relatedTarget instanceof Node) ||
        !event.currentTarget.contains(event.relatedTarget)
      )
        focusOwner.current?.(false);
    },
  };
}
