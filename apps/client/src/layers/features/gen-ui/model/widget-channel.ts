/** Native widget event submissions over the host's common document channel. */
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { WidgetAction } from '@dorkos/shared/ui-widget';
import {
  PageEventSchema,
  matchesCanvasChannelEvent,
  type PageEvent,
  type CanvasChannelEventReceipt,
  type CanvasChannelReplayResponse,
} from '@dorkos/shared/canvas-channel-schemas';

/** The canvas host supplies current server route summaries and its existing stream snapshot. */
export interface WidgetChannelPort {
  documentId: string;
  enabled: boolean;
  destinationLabel: string;
  /** Current approved event patterns, never inferred from the authored declaration. */
  approvedEventTypes: readonly string[];
  snapshot?: Pick<
    CanvasChannelReplayResponse,
    'state' | 'stateRev' | 'receipts' | 'retentionFloor' | 'receiptRetentionFloor' | 'resetRequired'
  >;
  submit(event: PageEvent): Promise<CanvasChannelEventReceipt>;
  inspect(eventId: string): Promise<CanvasChannelEventReceipt>;
}
/** Match the server's approved patterns using the same bounded event semantics as routing. */
export function isWidgetActionApproved(patterns: readonly string[]): boolean {
  return patterns.some((pattern) => matchesCanvasChannelEvent(pattern, 'widget.action'));
}
/** One click keeps its frozen envelope through every uncertain network retry. */
export interface WidgetChannelSubmission {
  controlId: string;
  documentId: string;
  normalized: boolean;
  event: PageEvent;
  phase: 'sending' | 'retry' | 'refused' | 'review' | 'accepted';
  receipt?: CanvasChannelEventReceipt;
  floor: number | null;
  message?: string;
}
/** Bound active submissions and retain only the most recent settled local display records. */
const MAX_SUBMISSIONS = 100;

/** Manage click identity independently of the legacy inline widget latch. */
export function useWidgetChannelActions(
  channel: WidgetChannelPort | undefined,
  widgetTitle?: string
) {
  const [submissions, setSubmissions] = useState<WidgetChannelSubmission[]>([]);
  const current = useRef(submissions);
  const port = useRef(channel);
  useLayoutEffect(() => {
    port.current = channel;
  }, [channel]);
  const commit = (rows: WidgetChannelSubmission[]) => {
    current.current = rows;
    setSubmissions(rows);
  };
  const update = (id: string, patch: Partial<WidgetChannelSubmission>) =>
    commit(current.current.map((row) => (row.event.id === id ? { ...row, ...patch } : row)));
  useEffect(() => {
    let changed = false;
    const rows = current.current.map((row) => {
      if (row.phase === 'refused') return row;
      const receipt = channel?.snapshot?.receipts.find((item) => item.receipt.id === row.event.id);
      if (!receipt || receipt === row.receipt) return row;
      changed = true;
      return { ...row, phase: 'accepted' as const, receipt };
    });
    if (changed) {
      current.current = rows;
      setSubmissions(rows);
    }
  }, [channel?.snapshot?.receipts]);
  const pending = (controlId: string) =>
    current.current.some(
      (row) =>
        row.controlId === controlId &&
        !port.current?.snapshot?.receipts.some((receipt) => receipt.receipt.id === row.event.id) &&
        (row.phase === 'sending' || row.phase === 'retry' || row.phase === 'review')
    );
  const send = async (row: WidgetChannelSubmission, retry = false): Promise<void> => {
    let host = port.current;
    if (!host?.enabled || host.documentId !== row.documentId) {
      update(row.event.id, {
        phase: retry ? 'review' : 'refused',
        message: retry
          ? 'Save not confirmed. Document actions are unavailable; review this action before trying again.'
          : 'Document actions are not available.',
      });
      return;
    }
    update(row.event.id, { phase: 'sending', message: undefined });
    try {
      if (retry) {
        try {
          const receipt = await host.inspect(row.event.id);
          update(row.event.id, { phase: 'accepted', receipt });
          return;
        } catch (error) {
          if ((error as { status?: number }).status !== 404) throw error;
          host = port.current;
          if (!host?.enabled || host.documentId !== row.documentId) {
            update(row.event.id, {
              phase: 'review',
              message: 'The document changed. Review this action before trying again.',
            });
            return;
          }
          if (
            row.floor === null ||
            host.snapshot === undefined ||
            host.snapshot.receiptRetentionFloor > row.floor
          ) {
            update(row.event.id, {
              phase: 'review',
              message: 'The saved history changed. Review this action before trying again.',
            });
            return;
          }
        }
      }
      host = port.current;
      if (
        !host?.enabled ||
        host.documentId !== row.documentId ||
        (row.normalized && !isWidgetActionApproved(host.approvedEventTypes))
      ) {
        update(row.event.id, {
          phase: 'review',
          message: 'Document approval changed. Review this action before trying again.',
        });
        return;
      }
      const receipt = await host.submit(row.event);
      update(row.event.id, { phase: 'accepted', receipt });
    } catch (error) {
      const status = (error as { status?: number }).status;
      // A retry begins with an uncertain original POST. Neither a refused
      // receipt lookup nor a refused resend proves that original POST failed.
      const refusal = status !== undefined && [400, 401, 403, 404, 409, 413, 422].includes(status);
      const terminal = !retry && refusal;
      update(row.event.id, {
        phase: terminal ? 'refused' : refusal ? 'review' : 'retry',
        message: terminal
          ? 'This action could not be saved. Review the document before trying again.'
          : refusal
            ? 'Save not confirmed. Review this action before trying again.'
            : 'Save not confirmed. Check your connection and try again.',
      });
    }
  };
  const dispatch = async (action: WidgetAction, controlId: string) => {
    const host = port.current;
    if (!host?.enabled || pending(controlId)) return;
    const normalization = action.kind === 'agent';
    if (normalization && !isWidgetActionApproved(host.approvedEventTypes)) return;
    if (action.kind !== 'emit' && !normalization) return;
    const metadata = {
      documentId: host.documentId,
      nodeId: controlId,
      ...(widgetTitle ? { title: widgetTitle } : {}),
    };
    const event = PageEventSchema.parse({
      v: 1,
      id: crypto.randomUUID(),
      type: normalization ? 'widget.action' : action.type,
      payload: normalization
        ? { actionId: action.id, payload: action.payload ?? {}, widget: metadata }
        : { ...(action.payload ?? {}), widget: metadata },
      ...(!normalization && action.coalesceKey ? { coalesceKey: action.coalesceKey } : {}),
    });
    const rows = current.current.map((row) => ({
      ...row,
      receipt:
        host.snapshot?.receipts.find((receipt) => receipt.receipt.id === row.event.id) ??
        row.receipt,
    }));
    if (rows.length >= MAX_SUBMISSIONS) {
      const settled = rows.findIndex(
        (row) =>
          row.phase === 'refused' ||
          (row.phase === 'accepted' &&
            row.receipt?.deliveries.every((delivery) =>
              [
                'handled',
                'rejected',
                'turn_done',
                'expired',
                'failed',
                'cancelled',
                'superseded',
                'unavailable',
              ].includes(delivery.status)
            ))
      );
      if (settled < 0)
        throw new Error('Too many actions are waiting. Try again after they finish.');
      rows.splice(settled, 1);
    }
    const row: WidgetChannelSubmission = {
      controlId,
      documentId: host.documentId,
      normalized: normalization,
      event,
      phase: 'sending',
      floor: host.snapshot?.receiptRetentionFloor ?? null,
    };
    commit([...rows, row]);
    await send(row);
  };
  const records = submissions.map((row) => {
    const receipt = channel?.snapshot?.receipts.find(
      (receipt) => receipt.receipt.id === row.event.id
    );
    return {
      ...row,
      ...(receipt && row.phase !== 'refused' ? { phase: 'accepted' as const } : {}),
      receipt: receipt ?? row.receipt,
    };
  });
  return {
    dispatch,
    pending,
    records,
    retry: (id: string) => {
      const row = current.current.find((row) => row.event.id === id);
      return row && row.phase === 'retry' ? send(row, true) : Promise.resolve();
    },
  };
}
