import type { DbTransaction } from '@dorkos/db';
import type {
  CanvasChannelSendRequest,
  CanvasChannelPatchStateRequest,
  CanvasChannelJsonValue,
  IngestReceipt,
} from '@dorkos/shared/canvas-channel-schemas';
import type { DocChannelActor } from '../authorization.js';
import type { DocChannelStore, DocEventRow } from '../store.js';
import type { OriginalEmitterBinding } from './emitter-custody.js';
import type { OriginalDownstreamRoomEmitter } from './native-room-emitter.js';
import type { DocDownstreamAccess } from './service.js';
/** Original private native frame ports; only a constructor-private key retrieves these cells. */
export interface OriginalDownstreamOperationView {
  readonly store: DocChannelStore;
  originalEmitter(): OriginalDownstreamRoomEmitter | undefined;
  prepare(documentId: string, actor: DocChannelActor, batchId: string): Promise<void>;
  emitter(emitter: OriginalDownstreamRoomEmitter): OriginalEmitterBinding | undefined;
  actor(actor: DocChannelActor): void;
  clock(): Date;
  atomic<T>(work: () => T): T;
  rate(access: DocDownstreamAccess, now: string, tx: DbTransaction): void;
  event(
    documentId: string,
    eventId: string,
    type: string,
    payload: CanvasChannelJsonValue,
    hash: string,
    request: CanvasChannelSendRequest | CanvasChannelPatchStateRequest,
    access: DocDownstreamAccess,
    now: string
  ): Parameters<DocChannelStore['appendEvent']>[0];
  receipt(event: DocEventRow, duplicate: boolean): IngestReceipt;
}
