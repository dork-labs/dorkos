/** Native widget event submissions over the host's common document channel. */
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { WidgetAction } from '@dorkos/shared/ui-widget';
import {
  PageEventSchema,
  matchesCanvasChannelEvent,
  type PageEvent,
  type CanvasChannelEventReceipt,
} from '@dorkos/shared/canvas-channel-schemas';

import type {
  WidgetOriginalRequest,
  WidgetChannelPort,
  WidgetChannelSubmission,
} from './widget-channel-types';
export type {
  WidgetOriginalRequest,
  WidgetChannelPort,
  WidgetChannelSubmission,
} from './widget-channel-types';
/** Match the server-approved patterns for a native widget action. */
export function isWidgetActionApproved(patterns: readonly string[]): boolean {
  return patterns.some((pattern) => matchesCanvasChannelEvent(pattern, 'widget.action'));
}
const MAX_SUBMISSIONS = 100;
/** Matches the previous HTTP helper deadline; Doc HTTP itself has no second clock. */
const DOC_OPERATION_DEADLINE_MS = 30_000;
function freezeEnvelope<T>(value: T): T {
  if (value !== null && typeof value === 'object') {
    for (const child of Object.values(value)) freezeEnvelope(child);
    Object.freeze(value);
  }
  return value;
}
type Operation = {
  token: object;
  controller: AbortController;
  active: boolean;
  timer?: ReturnType<typeof setTimeout>;
};
type OwnedRow = {
  value: WidgetChannelSubmission;
  owner?: object;
  host: Pick<WidgetChannelPort, 'current'>;
  original: WidgetOriginalRequest;
  retired: boolean;
  uncertain: boolean;
  start?: object;
  operation?: Operation;
};

/** Preserve original action identity through owned submission, recovery and retirement. */
export function useWidgetChannelActions(
  channel: WidgetChannelPort | undefined,
  widgetTitle?: string
) {
  const [submissions, setSubmissions] = useState<WidgetChannelSubmission[]>([]);
  const rows = useRef(new Map<string, OwnedRow>());
  const port = useRef(channel);
  const identity = useRef({ documentId: channel?.documentId, owner: channel?.submissionOwner });
  const live = useRef(true);
  const publication = useRef(0);
  const publish = useCallback(() => {
    const revision = ++publication.current;
    const snapshot = [...rows.current.values()].map((row) => row.value);
    setSubmissions((previous) => (publication.current === revision ? snapshot : previous));
  }, []);
  const retireOperation = useCallback((row: OwnedRow) => {
    const old = row.operation;
    row.operation = undefined;
    if (!old) return;
    old.active = false;
    clearTimeout(old.timer);
    old.controller.abort();
  }, []);
  const retire = useCallback(
    (row: OwnedRow) => {
      row.retired = true;
      row.start = undefined;
      ++publication.current;
      retireOperation(row);
    },
    [retireOperation]
  );
  const present = useCallback(
    (row: OwnedRow) => live.current && !row.retired && rows.current.get(row.value.event.id) === row,
    []
  );
  const sameOwner = useCallback((row: OwnedRow) => {
    const current = port.current;
    return (
      identity.current.documentId === row.value.documentId &&
      identity.current.owner === row.owner &&
      current?.documentId === row.value.documentId &&
      current?.submissionOwner === row.owner
    );
  }, []);
  const qualify = useCallback(
    (row: OwnedRow, purpose: 'read' | 'submit') => {
      if (!present(row) || !sameOwner(row)) return false;
      const held = port.current!;
      const allowed = row.host.current ? row.host.current(purpose) : held.enabled;
      if (!allowed || !present(row) || !sameOwner(row)) return false;
      const originalCurrent = row.original.current(purpose);
      return originalCurrent && present(row) && sameOwner(row);
    },
    [present, sameOwner]
  );
  useLayoutEffect(() => {
    const next = { documentId: channel?.documentId, owner: channel?.submissionOwner };
    port.current = channel;
    identity.current = next;
    for (const row of rows.current.values()) if (!sameOwner(row)) retire(row);
  }, [channel, channel?.documentId, channel?.submissionOwner, sameOwner, retire]);
  useEffect(() => {
    live.current = true;
    const ownedRows = rows.current;
    return () => {
      live.current = false;
      for (const row of ownedRows.values()) retire(row);
    };
  }, [retire]);
  const change = useCallback(
    (row: OwnedRow, patch: Partial<WidgetChannelSubmission>) => {
      row.value = { ...row.value, ...patch };
      publish();
    },
    [publish]
  );
  useEffect(() => {
    for (const row of rows.current.values()) {
      if (!present(row) || !sameOwner(row) || row.value.phase === 'refused') continue;
      const start = row.start;
      const operation = row.operation;
      if (!qualify(row, 'read') || row.start !== start || row.operation !== operation) continue;
      const saved = channel?.snapshot?.receipts.find(
        (item) => item.receipt.id === row.value.event.id
      );
      // Snapshot access and ownership checks are observable ports; reentry may replace this attempt.
      if (!qualify(row, 'read') || row.start !== start || row.operation !== operation) continue;
      if (saved && saved !== row.value.receipt) {
        // Commit the durable result before abort listeners can start another attempt.
        row.start = undefined;
        row.value = { ...row.value, phase: 'accepted', receipt: saved };
        retireOperation(row);
        publish();
      }
    }
  }, [
    channel?.snapshot?.receipts,
    channel?.submissionOwner,
    present,
    sameOwner,
    qualify,
    retireOperation,
    publish,
  ]);
  const pending = (controlId: string) =>
    [...rows.current.values()].some(
      (row) =>
        row.value.controlId === controlId &&
        !row.retired &&
        ['sending', 'retry', 'review'].includes(row.value.phase)
    );
  const send = async (row: OwnedRow, retry = false): Promise<void> => {
    if (!present(row) || !sameOwner(row)) return;
    const start = Object.freeze({});
    row.start = start;
    ++publication.current;
    // Clear old admission BEFORE abort; a nested start owns a different sentinel.
    retireOperation(row);
    const starting = () =>
      present(row) && sameOwner(row) && row.start === start && row.operation === undefined;
    if (!starting()) return;
    const allowed = qualify(row, retry ? 'read' : 'submit');
    if (!starting()) return;
    if (!allowed) {
      change(row, {
        phase: retry ? 'retry' : 'refused',
        message: retry
          ? 'Save not confirmed. Review the document before trying again.'
          : 'Document actions are unavailable. Review this action before trying again.',
      });
      return;
    }
    const controller = new AbortController();
    if (!starting()) {
      controller.abort();
      return;
    }
    const operation: Operation = { token: Object.freeze({}), controller, active: true };
    row.operation = operation;
    row.start = undefined;
    const current = () =>
      present(row) &&
      sameOwner(row) &&
      row.operation === operation &&
      operation.active &&
      !controller.signal.aborted;
    const admitted = (purpose: 'read' | 'submit') => {
      if (!current()) return false;
      const allowedNow = qualify(row, purpose);
      return allowedNow && current();
    };
    operation.timer = setTimeout(() => {
      if (!current()) return;
      operation.active = false;
      row.operation = undefined;
      row.uncertain = true;
      change(row, {
        phase: 'retry',
        message: 'Save not confirmed. Check your network and try again.',
      });
      controller.abort();
    }, DOC_OPERATION_DEADLINE_MS);
    if (!current()) {
      clearTimeout(operation.timer);
      controller.abort();
      return;
    }
    change(row, { phase: 'sending', message: undefined });
    try {
      if (retry) {
        try {
          if (!admitted('read')) {
            if (current())
              change(row, {
                phase: 'retry',
                message: 'Save not confirmed. Review the document before trying again.',
              });
            return;
          }
          const receipt = await row.original.inspect(controller.signal);
          if (!admitted('read')) {
            if (current())
              change(row, {
                phase: 'retry',
                message: 'Save not confirmed. Review the document before trying again.',
              });
            return;
          }
          change(row, { phase: 'accepted', receipt });
          return;
        } catch (error) {
          if (!current()) return;
          if (!current()) return;
          // Generic 404 cannot distinguish inaccessible document from absent receipt.
          // Preserve the original uncertainty; no floor from a view can authorize POST.
          throw error;
        }
      }
      if (!admitted('submit')) {
        if (current())
          change(row, {
            phase: 'review',
            message: 'Document approval changed. Review this action before trying again.',
          });
        return;
      }
      const patterns = [...(port.current?.approvedEventTypes ?? [])];
      const approved = !row.value.normalized || isWidgetActionApproved(patterns);
      if (!current()) return;
      if (!approved) {
        change(row, {
          phase: 'review',
          message: 'Document approval changed. Review this action before trying again.',
        });
        return;
      }
      if (!admitted('submit')) return;
      row.uncertain = true;
      const receipt = await row.original.submit(controller.signal);
      if (!admitted('read')) {
        if (current())
          change(row, {
            phase: 'retry',
            message: 'Save not confirmed. Review the document before trying again.',
          });
        return;
      }
      change(row, { phase: 'accepted', receipt });
    } catch (error) {
      if (!current()) return;
      const status = (error as { status?: number }).status;
      if (!current()) return;
      const refusal = status !== undefined && [400, 401, 403, 404, 409, 413, 422].includes(status);
      const terminal = !retry && refusal;
      row.uncertain = retry || !terminal;
      change(row, {
        phase: terminal ? 'refused' : refusal ? 'review' : 'retry',
        message: terminal
          ? 'This action could not be saved. Review the document before trying again.'
          : refusal
            ? 'Save not confirmed. Review this action before trying again.'
            : 'Save not confirmed. Check your network and try again.',
      });
    } finally {
      if (row.operation === operation) {
        row.operation = undefined;
        operation.active = false;
        clearTimeout(operation.timer);
        controller.abort();
      }
    }
  };
  const dispatch = async (action: WidgetAction, controlId: string) => {
    const host = port.current;
    if (!host?.enabled || pending(controlId)) return;
    const normalized = action.kind === 'agent';
    if (normalized && !isWidgetActionApproved(host.approvedEventTypes)) return;
    if (action.kind !== 'emit' && !normalized) return;
    const event = PageEventSchema.parse({
      v: 1,
      id: crypto.randomUUID(),
      type: normalized ? 'widget.action' : action.type,
      payload: normalized
        ? {
            actionId: action.id,
            payload: action.payload ?? {},
            widget: {
              documentId: host.documentId,
              nodeId: controlId,
              ...(widgetTitle ? { title: widgetTitle } : {}),
            },
          }
        : {
            ...(action.payload ?? {}),
            widget: {
              documentId: host.documentId,
              nodeId: controlId,
              ...(widgetTitle ? { title: widgetTitle } : {}),
            },
          },
      ...(!normalized && action.coalesceKey ? { coalesceKey: action.coalesceKey } : {}),
    });
    const bytes = JSON.stringify(event);
    const documentId = host.documentId,
      owner = host.submissionOwner;
    const original = host.captureOriginal?.(event);
    if (
      !original ||
      original.id !== event.id ||
      original.bytes !== bytes ||
      !live.current ||
      port.current !== host ||
      host.documentId !== documentId ||
      host.submissionOwner !== owner ||
      !original.current('submit') ||
      !live.current ||
      port.current !== host ||
      host.documentId !== documentId ||
      host.submissionOwner !== owner
    )
      return;
    const captured = {
      ...(host.current ? { current: host.current.bind(host) } : {}),
    };
    if (!live.current || port.current !== host || pending(controlId)) return;
    if (rows.current.size >= MAX_SUBMISSIONS) {
      const settled = [...rows.current.values()].find(
        (row) =>
          row.value.phase === 'refused' ||
          (row.value.phase === 'accepted' &&
            row.value.receipt?.deliveries.every((delivery) =>
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
      if (!settled) throw new Error('Too many actions are waiting. Try again after they finish.');
      rows.current.delete(settled.value.event.id);
      retire(settled);
      if (!live.current || port.current !== host || pending(controlId)) return;
    }
    const row: OwnedRow = {
      host: captured,
      owner: host.submissionOwner,
      original,
      retired: false,
      uncertain: false,
      value: {
        controlId,
        documentId: host.documentId,
        normalized,
        event: freezeEnvelope(JSON.parse(bytes) as PageEvent),
        phase: 'sending',
      },
    };
    rows.current.set(event.id, row);
    publish();
    await send(row);
  };
  return {
    dispatch,
    pending,
    records: submissions,
    retry: (id: string) => {
      const row = rows.current.get(id);
      return row && row.uncertain && (row.value.phase === 'retry' || row.value.phase === 'sending')
        ? send(row, true)
        : Promise.resolve();
    },
  };
}
