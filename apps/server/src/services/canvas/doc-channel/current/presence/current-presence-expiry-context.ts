import type { Db } from '@dorkos/db';
import type { DocChannelStore } from '../../store.js';
import type {
  DocChannelActor,
  DocChannelAuthorization,
  DocChannelAuthorityPorts,
} from '../../authorization.js';
import type {
  CurrentOperationScope,
  CurrentDocOperationEngineCore,
} from '../current-operation-types.js';
import type { createOriginalDocPresenceLedger } from '../../presence.js';
/** Original private engine's retained presence source, never an input accepted from a caller. */
export interface OriginalPresenceDocument {
  store: DocChannelStore;
  actor: DocChannelActor;
  birth: CurrentOperationScope['birth'];
  scope: string;
  callers: Map<string, DocChannelActor>;
}
/** Exact original presence resources and live latches, accessible only by private engine membership. */
export interface OriginalPresenceExpiryFacet {
  readonly db: Db;
  readonly authorization: DocChannelAuthorization;
  readonly fixedPorts: DocChannelAuthorityPorts;
  readonly core: CurrentDocOperationEngineCore;
  readonly presenceDocuments: Map<string, OriginalPresenceDocument>;
  readonly presenceLedger: ReturnType<typeof createOriginalDocPresenceLedger>;
  readonly nativePrepare: Db['$client']['prepare'];
  readonly presenceNow: () => number;
  readonly roomPumpStopped: boolean;
  currentEntry: boolean;
  readonly schedulePresence: () => void;
}
