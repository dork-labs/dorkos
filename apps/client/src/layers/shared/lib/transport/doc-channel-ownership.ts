import type { Transport } from '@dorkos/shared/transport';
import {
  publishOwnedDocChannelNotification,
  notifyDocChannelRetirement,
} from './doc-channel-notifications';

/** Private connection admission. Payloads cannot create or restore a producer. */
const connections = new WeakMap<object, { owner: Transport; live: boolean; signal: AbortSignal }>();
/** Read admission for an issued live connection ticket. */
export function currentDocChannelConnection(ticket: object): Transport | undefined {
  const held = connections.get(ticket);
  return held?.live && !held.signal.aborted ? held.owner : undefined;
}
/** Internal to actual stream owners; no registrar or payload-selected owner is exported publicly. */
export function ownDocChannelConnection(owner: Transport, signal: AbortSignal) {
  const ticket = Object.freeze({});
  const record = { owner, signal, live: !signal.aborted };
  connections.set(ticket, record);
  const retire = () => {
    if (!record.live) return;
    record.live = false;
    notifyDocChannelRetirement(owner);
  };
  signal.addEventListener('abort', retire, { once: true });
  return {
    current: () => currentDocChannelConnection(ticket) === owner,
    publish: (data: unknown) => publishOwnedDocChannelNotification(ticket, data),
    retire: () => {
      try {
        retire();
      } finally {
        signal.removeEventListener('abort', retire);
      }
    },
  };
}
/** The room hook receives a producer only together with its genuine owned subscription. */
export function openOwnedRoomDocStream(
  owner: Transport,
  roomId: string,
  since: number | undefined,
  signal: AbortSignal
) {
  const producer = ownDocChannelConnection(owner, signal);
  try {
    const stream = owner.subscribeRoom(roomId, since, signal);
    if (!producer.current()) producer.retire();
    return { stream, ...producer };
  } catch (error) {
    producer.retire();
    throw error;
  }
}
