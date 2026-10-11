import type { DocChannelStore } from '../../store.js';
import type { DocChannelGrants } from '../../grants.js';
import type { CurrentRoomOperation } from '../../operations/room-current-operation.js';
import type { OriginalTokenIssuanceFacet } from '../token/current-token-issuance-context.js';
import type { OriginalPresenceExpiryFacet } from '../presence/current-presence-expiry-context.js';
import type { OriginalEditorSaveSelectionFacet } from '../projection/current-editor-save-selection-context.js';
/** Original Room retirement promises, construction latches and captured retention clock. */
export interface OriginalRoomRetirementFacet extends OriginalTokenIssuanceFacet {
  room: CurrentRoomOperation | undefined;
  roomConstruction: 'unstarted' | 'constructing' | 'ready' | 'failed';
  roomConstructionFailure: { cause: unknown } | undefined;
  readonly roomStop: Promise<void> | undefined;
  roomStopStarted: boolean;
  readonly rejectRoomStop: ((cause: unknown) => void) | undefined;
  readonly resolveRoomStop: (() => void) | undefined;
  tokenRoomPeerClosed: boolean;
  currentEntry: boolean;
  readonly activeTokenOperations: Set<Promise<unknown>>;
  readonly presenceLedger: OriginalPresenceExpiryFacet['presenceLedger'];
  readonly presenceDocuments: OriginalPresenceExpiryFacet['presenceDocuments'];
  readonly presenceFailure: { cause: unknown } | undefined;
  readonly tokenManifestOwners: { grants: DocChannelGrants; store: DocChannelStore }[];
  readonly editorSelectionReader: OriginalEditorSaveSelectionFacet['editorSelectionReader'];
  readonly ensureRoom: () => CurrentRoomOperation | undefined;
  readonly finishRoomStop: () => void;
}
