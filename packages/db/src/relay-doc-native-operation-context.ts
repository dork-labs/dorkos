import type { OriginalRelayDocStorage } from './relay-doc-native.js';
import type {
  Native,
  Rows,
  RelayNativeSelector,
  OriginalRelayNativeFacts,
  OriginalRelayNativeClaim,
} from './relay-doc-native-data.js';
import type { readOriginalRelaySource } from './relay-doc-native-data.js';

export type RelayFactsState = {
  owner: OriginalRelayDocStorage;
  selector: RelayNativeSelector;
  hash: string;
  receiptId: string;
  consumed: boolean;
  claimState: 'unattempted' | 'unknown' | 'rollback_closed' | 'committed';
};
export type RelayClaimState = {
  owner: OriginalRelayDocStorage;
  frame: object;
  attemptId: string;
  receiptId: string;
  settlementAttempted?: boolean;
  selector: RelayNativeSelector;
  bindings: Readonly<Record<string, string | number>>;
  sourceHash: string;
  principal: Rows;
  bindingId: string;
  ledgerSnapshot: { batch: Rows; receipt: Rows; deliveries: Rows };
  startHint: Readonly<{
    documentId: string;
    eventId: string;
    docSeq: number;
    envelopeHash: string;
    direction: 'system';
    type: 'event.status';
    receivedAt: string;
  }>;
};
export interface RelayNativeOperationContext {
  owner: OriginalRelayDocStorage;
  bootEpoch: string;
  begin: Native['beginRelayFrame'];
  run: Native['executeRelayFrame'];
  commit: Native['commitRelayFrame'];
  rollback: Native['rollbackRelayFrame'];
  committed: Native['committedRelayFrame'];
  read: (
    frame: object,
    selector: RelayNativeSelector,
    now: string
  ) => ReturnType<typeof readOriginalRelaySource>;
  facts: WeakMap<OriginalRelayNativeFacts, RelayFactsState>;
  claims: WeakMap<OriginalRelayNativeClaim, RelayClaimState>;
}
