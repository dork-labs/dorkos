import type { Db, DbTransaction } from '@dorkos/db';
import type {
  CurrentDocOperationEngineCore,
  DocEventCondition,
  DocReceiptInspection,
} from '../current/current-operation-types.js';
import type { DocChannelStore } from '../store.js';
import type { DocChannelIngest } from '../ingest.js';
import type { DocChannelGrants } from '../grants.js';
import type { CanvasChannelEventReceipt } from '@dorkos/shared/canvas-channel-schemas';
import type {
  ServerPrincipalProof,
  ServerPrincipalClaims,
} from '../../../connectors/principal/server-principal.js';
import type { ConnectorRuntimePrincipalService } from '../../../connectors/principal/runtime-principal-service.js';

/** The same refusal for an absent document and one the caller cannot reach. */
export class DocChannelNotFoundError extends Error {
  readonly code = 'CANVAS_DOCUMENT_NOT_FOUND';
  readonly status = 404;
  /** Build a disclosure-safe document refusal. */
  constructor(options?: ErrorOptions) {
    super('The document is not available.', options);
  }
}
/** An authorized room remains readable while its writes are stopped. */
export class DocChannelArchivedError extends Error {
  readonly code = 'ROOM_ARCHIVED';
  readonly status = 409;
  /** Build the existing archived-room refusal. */
  constructor() {
    super('This room is archived');
  }
}
/** Server-resolved entry surface; nothing here is read from a page envelope. */
export interface DocChannelActor {
  surface: 'http' | 'capability';
  principal: ServerPrincipalProof;
}
/** Scope checks supplied by the existing owner and room authority services. */
export interface DocChannelAuthorityPorts {
  /** Original installation constructor scalar; never a principal or issuer. */
  readonly originalInstallationId?: string;
  readonly originalRoomRepoStore?: import('../../../rooms/repo/room-repo-store.js').RoomRepoStore;
  readonly roomConstruction?: import('@dorkos/db/internal-server').ServerNativeRoomConstruction;
  readonly originalRoomStore?: import('../../../rooms/room-store.js').RoomStore;
  readonly nativeRuntimePrincipals?: ConnectorRuntimePrincipalService;
  ownsInstallation(claims: ServerPrincipalClaims): boolean;
  /** Resolve the verified owner or agent to an author and require current membership. */
  roomMembership(roomId: string, claims: ServerPrincipalClaims): { archived: boolean } | undefined;
  /** Synchronous current principal check, including runtime binding revocation; required before every disclosure or mutation. */
  principalCurrent: (proof: ServerPrincipalProof) => boolean;
  /** Optional live runtime principal recheck, beyond synchronous stored binding checks. */
  revalidateRuntime?: (proof: ServerPrincipalProof) => Promise<boolean>;
}

/** Original captured constructor binding DATA; this type provides no registration authority. */
export type OriginalAuthorizationOperationBinding = {
  db: Db;
  engine: CurrentDocOperationEngineCore;
  selection: import('../current/current-operation-types.js').CurrentDocOperationEngineCore['selection'];
  submit: (
    store: DocChannelStore,
    ingest: DocChannelIngest,
    grants: DocChannelGrants,
    documentId: string,
    event: unknown,
    actor: DocChannelActor,
    condition: DocEventCondition
  ) => Promise<CanvasChannelEventReceipt>;
  inspect: (
    store: DocChannelStore,
    documentId: string,
    eventId: string,
    actor: DocChannelActor,
    condition: DocEventCondition
  ) => Promise<DocReceiptInspection>;
  documentReplay: CurrentDocOperationEngineCore['documentReplay'];
  documentInspect: CurrentDocOperationEngineCore['documentInspect'];
  documentSubmit: CurrentDocOperationEngineCore['documentSubmit'];
  captureDocument: CurrentDocOperationEngineCore['captureDocument'];
  requireDocument: CurrentDocOperationEngineCore['requireDocument'];
  replayExpired: CurrentDocOperationEngineCore['replayExpired'];
  management: CurrentDocOperationEngineCore['management'];
  replay: CurrentDocOperationEngineCore['replay'];
  presence: CurrentDocOperationEngineCore['presence'];
  final: (store: DocChannelStore, tx: DbTransaction) => void;
};
