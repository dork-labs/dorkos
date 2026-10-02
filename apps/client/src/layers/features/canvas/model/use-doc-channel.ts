/** One physical document reuses its owning scope stream and narrow HTTP recovery calls. */
import { useEffect, useMemo, useState } from 'react';
import { useTransport } from '@/layers/shared/model';
import { subscribeDocChannelNotifications } from '@/layers/shared/lib/transport';
import type { WidgetChannelPort } from '@/layers/features/gen-ui';
import {
  CanvasChannelReplayResponseSchema,
  type CanvasChannelReplayResponse,
  type CanvasChannelFrame,
} from '@dorkos/shared/canvas-channel-schemas';
type Snapshot = Omit<CanvasChannelReplayResponse, 'events'>;
interface View {
  documentId: string;
  transport: ReturnType<typeof useTransport>;
  snapshot?: Snapshot;
  events: CanvasChannelFrame[];
  available: boolean;
}
const empty = (documentId: string, transport: ReturnType<typeof useTransport>): View => ({
  documentId,
  transport,
  events: [],
  available: false,
});
/** Keep a channel port attached through loading/refusal so an uncertain click cannot become legacy work. */
export function useDocChannel(documentId: string): {
  channel: WidgetChannelPort;
  events: CanvasChannelFrame[];
} {
  const transport = useTransport();
  const [view, setView] = useState<View>(() => empty(documentId, transport));
  useEffect(() => {
    let active = true;
    let highest = 0;
    let revision = 0;
    let repairing: Promise<void> | undefined;
    const pending = new Map<number, CanvasChannelFrame>();
    const applySnapshot = (snapshot: Snapshot, routingCurrent = true) => {
      if (!active) return;
      setView((previous) => {
        const current =
          previous.documentId === documentId && previous.transport === transport
            ? previous
            : empty(documentId, transport);
        if (
          current.snapshot &&
          (snapshot.highWatermark < current.snapshot.highWatermark ||
            snapshot.stateRev < current.snapshot.stateRev)
        )
          return current;
        const receipts = new Map(
          (current.snapshot?.receipts ?? [])
            .filter((row) => row.receipt.docSeq >= snapshot.receiptRetentionFloor)
            .map((row) => [row.receipt.id, row])
        );
        for (const row of snapshot.receipts) receipts.set(row.receipt.id, row);
        return {
          ...current,
          available: true,
          snapshot: {
            ...snapshot,
            ...(routingCurrent ? {} : { routing: current.snapshot?.routing }),
            receipts: [...receipts.values()]
              .sort((a, b) => b.receipt.docSeq - a.receipt.docSeq)
              .slice(0, 400),
          },
          events: snapshot.resetRequired
            ? current.events.filter((frame) => frame.docSeq >= snapshot.retentionFloor)
            : current.events,
        };
      });
    };
    const applyEvent = (frame: CanvasChannelFrame) => {
      if (!active || frame.docSeq <= highest) return;
      highest = frame.docSeq;
      setView((previous) => {
        const current =
          previous.documentId === documentId && previous.transport === transport
            ? previous
            : empty(documentId, transport);
        return { ...current, events: [...current.events, frame].slice(-200) };
      });
    };
    const recover = (): Promise<void> => {
      if (repairing) return repairing;
      const starting = highest;
      const startingRevision = revision;
      let succeeded = false;
      repairing = (async () => {
        let target: number | undefined;
        while (active) {
          const capturedRevision = revision;
          const requestedSince = highest;
          const response = CanvasChannelReplayResponseSchema.parse(
            await transport.getCanvasChannel(documentId, { since: requestedSince, limit: 200 })
          );
          if (!active) return;
          // Bound each page and freeze this catch-up target; later live work is handled separately.
          const cutoff = target ?? response.highWatermark;
          target = cutoff;
          const { events: pageEvents, ...snapshot } = response;
          const events = pageEvents.filter((frame) => frame.docSeq <= cutoff);
          applySnapshot(snapshot, capturedRevision === revision);
          if (response.resetRequired) highest = Math.max(highest, response.retentionFloor - 1);
          for (const frame of events) applyEvent(frame);
          if (pageEvents.length < 200 || highest >= target) {
            highest = Math.max(highest, target);
            succeeded = true;
            return;
          }
          if (highest <= requestedSince) throw new Error('Document replay made no progress.');
        }
      })()
        .catch(() => {
          if (active) setView((previous) => ({ ...previous, available: false }));
        })
        .finally(() => {
          repairing = undefined;
          if (!active || !succeeded) return;
          for (const [seq, frame] of [...pending].sort(([a], [b]) => a - b)) {
            if (seq <= highest) {
              pending.delete(seq);
              continue;
            }
            if (seq !== highest + 1) break;
            pending.delete(seq);
            applyEvent(frame);
          }
          if (pending.size && (highest > starting || revision > startingRevision)) void recover();
        });
      return repairing;
    };
    // Canonical scope aliases can change while the physical document ID remains stable.
    const unsubscribe = subscribeDocChannelNotifications(undefined, (notification) => {
      if (!active || notification.documentId !== documentId) return;
      revision++;
      if (notification.type === 'canvas_channel_snapshot') applySnapshot(notification.snapshot);
      else if (notification.docSeq > highest + 1) {
        pending.set(notification.docSeq, notification);
        if (pending.size > 200) {
          pending.clear();
          setView((previous) => ({ ...previous, available: false }));
        }
        void recover();
      } else applyEvent(notification);
    });
    void recover();
    return () => {
      active = false;
      unsubscribe();
    };
  }, [documentId, transport]);
  const current =
    view.documentId === documentId && view.transport === transport
      ? view
      : empty(documentId, transport);
  const channel = useMemo<WidgetChannelPort>(
    () => ({
      documentId,
      enabled: current.available && current.snapshot?.routing?.enabled === true,
      approvedEventTypes: current.available
        ? (current.snapshot?.routing?.approvedEventTypes ?? [])
        : [],
      destinationLabel: current.available
        ? (current.snapshot?.routing?.destinationLabel ?? 'Actions unavailable')
        : 'Actions unavailable',
      ...(current.snapshot ? { snapshot: current.snapshot } : {}),
      submit: (event) => transport.ingestCanvasEvent(documentId, event),
      inspect: (eventId) => transport.getCanvasEventReceipt(documentId, eventId),
    }),
    [documentId, current.available, current.snapshot, transport]
  );
  return { channel, events: current.events };
}
