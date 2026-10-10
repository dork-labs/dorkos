/** Internal server-only NEW engine factory. Ordinary createDb never returns these ports. */
import { constructDatabase } from './database-construction.js';
/** Open the original protected server database and its native companions. */
export function openServerDatabase(path: string) {
  return constructDatabase(path);
}
export type {
  RoomDocStorage,
  RoomDocNativeOrigin,
  ConfirmedRoomBarrier,
  NativeRoomDocCommit,
  RoomDocCommittedFact,
  RoomDocOutcome,
} from './room-doc-storage.js';
export type {
  RoomDocClaimData,
  RoomDocSourceData,
  RoomDocInput,
  RoomDocMemoryFact,
} from './room-doc-data.js';

export { consumeServerNativeRoomConstruction } from './room-doc-storage.js';
export type { ServerNativeRoomConstruction, FixedNativeRoomDocFacade } from './room-doc-storage.js';
export type { AcceptedRoomSourceKey } from './room-doc-data.js';

export { requireServerNativeDatabaseQueryCustody } from './room-spend-witness.js';

export { consumeServerNativeRelayConstruction } from './relay-doc-native.js';
export type {
  ServerNativeRelayConstruction,
  FixedNativeRelayFacts,
  OriginalRelayNativeFacts,
  OriginalRelayNativeClaim,
  RelayNativeSelector,
} from './relay-doc-native.js';

export { createRoomDocBudgetPersistence } from './room-spend-witness.js';
export type { FixedRoomDocBudgetPersistence } from './room-spend-witness.js';
