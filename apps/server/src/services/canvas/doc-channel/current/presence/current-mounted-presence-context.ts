import type { DbTransaction } from '@dorkos/db';
import type { DocChannelAuthorization } from '../../authorization.js';
import type { DocChannelStore, EventInput } from '../../store.js';
import type { OriginalExpiredReplayFacet } from '../replay/current-expired-replay-context.js';
import type { OriginalEventAdmissionFacet } from '../projection/current-event-admission-context.js';
import type { OriginalPresenceExpiryFacet } from './current-presence-expiry-context.js';
import type { submitCurrent } from '../projection/current-event-admission-facet.js';
/** Original retained ledger, maps and lexical delegates, never caller-owned resources. */
export interface OriginalMountedPresenceFacet extends OriginalExpiredReplayFacet {
  readonly roomPumpStopped: boolean;
  readonly currentEntry: boolean;
  readonly presenceLedger: OriginalPresenceExpiryFacet['presenceLedger'];
  readonly presenceDocuments: OriginalPresenceExpiryFacet['presenceDocuments'];
  readonly presenceFocusStages: OriginalEventAdmissionFacet['presenceFocusStages'];
  readonly presenceFailures: Map<string, { cause: unknown }>;
  readonly presenceNow: () => number;
  readonly schedulePresence: () => void;
  readonly captureDocument: OriginalEventAdmissionFacet['captureDocument'];
  readonly submitCurrent: (
    ...args: Parameters<typeof submitCurrent> extends [object, ...infer Args] ? Args : never
  ) => ReturnType<typeof submitCurrent>;
  readonly originalPresenceAppends: WeakMap<
    DbTransaction,
    { authorization: DocChannelAuthorization; store: DocChannelStore; input: EventInput }
  >;
}
