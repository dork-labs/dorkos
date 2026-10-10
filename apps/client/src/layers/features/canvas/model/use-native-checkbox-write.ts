import { useEffect, useRef, useState } from 'react';
import {
  CanvasChannelCheckboxReceiptSchema,
  type CanvasChannelCheckboxRequest,
  type CanvasChannelCheckboxReceipt,
} from '@dorkos/shared/canvas-channel-schemas';
import { useTransport } from '@/layers/shared/model';

/** Native write outcomes are independent from channel dispatch and app acknowledgement. */
export type NativeCheckboxWriteState =
  'idle' | 'saving' | 'saved' | 'conflict' | 'review' | 'error';
type PendingDocument = {
  pending: CanvasChannelCheckboxRequest | null;
  running: Promise<CanvasChannelCheckboxReceipt> | null;
  outcome: CanvasChannelCheckboxReceipt | null;
  state: NativeCheckboxWriteState;
};
/** Retain each document's lost-response request exactly; never manufacture another event on retry. */
export function useNativeCheckboxWrite(documentId: string) {
  const transport = useTransport();
  const documents = useRef(new Map<string, PendingDocument>());
  let document = documents.current.get(documentId);
  if (!document) {
    document = { pending: null, running: null, outcome: null, state: 'idle' };
    documents.current.set(documentId, document);
  }
  const lane = document;
  const identity = useRef(lane);
  identity.current = lane;
  const alive = useRef(true);
  const [snapshot, setSnapshot] = useState(() => ({
    lane,
    state: lane.state,
    receipt: lane.outcome,
  }));
  const state = snapshot.lane === lane ? snapshot.state : lane.state;
  const receipt = snapshot.lane === lane ? snapshot.receipt : lane.outcome;
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);
  const publish = () => {
    if (alive.current && identity.current === lane) {
      setSnapshot({ lane, state: lane.state, receipt: lane.outcome });
    }
  };
  const execute = (request: CanvasChannelCheckboxRequest) => {
    if (lane.running) return lane.running;
    lane.state = 'saving';
    publish();
    const pass = Promise.resolve()
      .then(() => transport.toggleCanvasCheckbox(request))
      .then((raw) => {
        const result = CanvasChannelCheckboxReceiptSchema.parse(raw);
        const eventId = result.status === 'changed' ? result.receipt.id : result.eventId;
        if (eventId !== request.eventId)
          throw new Error('The checkbox receipt does not match the pending event.');
        lane.outcome = result;
        lane.state =
          result.status === 'conflict'
            ? 'conflict'
            : result.status === 'in_doubt'
              ? 'review'
              : 'saved';
        if (result.status === 'changed' || result.status === 'no_op') lane.pending = null;
        publish();
        return result;
      })
      .catch((cause) => {
        lane.state = 'error';
        publish();
        throw cause;
      })
      .finally(() => {
        if (lane.running === pass) lane.running = null;
      });
    lane.running = pass;
    return pass;
  };
  return {
    state,
    receipt,
    write(input: Omit<CanvasChannelCheckboxRequest, 'documentId' | 'eventId'>) {
      if (lane.pending)
        return Promise.reject(
          new Error('Resolve or retry the pending checkbox before another change.')
        );
      const request = Object.freeze({ ...input, documentId, eventId: crypto.randomUUID() });
      lane.outcome = null;
      lane.pending = request;
      return execute(request);
    },
    /** Retire only this writer's verified no-effect conflict after the user adopts fresh disk bytes. */
    resolveConflictReload(eventId: string) {
      if (
        lane.running ||
        lane.outcome?.status !== 'conflict' ||
        lane.outcome.eventId !== eventId ||
        lane.pending?.eventId !== eventId
      )
        return false;
      lane.pending = null;
      lane.outcome = null;
      lane.state = 'idle';
      publish();
      return true;
    },
    retry() {
      const request = lane.pending;
      if (
        !request ||
        (lane.outcome && lane.outcome.status !== 'changed' && lane.outcome.status !== 'no_op')
      )
        return Promise.reject(new Error('Reload or review this checkbox before another write.'));
      return execute(request);
    },
  };
}
