import type { ConnectorRuntimePrincipalService } from '../../../connectors/principal/runtime-principal-service.js';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { InstallationFileWrites } from '../writes/installation-file-writes.js';
import type { NormalFileSaveService } from '../writes/normal-file-save.js';
import type { InstallationHttpFileWrites } from '../writes/installation-http-file-writes.js';
import type { Db } from '@dorkos/db';
import type { DocChannelHttp } from '../../../../routes/canvas-doc-events.js';
import type { RequestUser } from '../../../core/auth/index.js';
import type { ApprovalService } from '../../../core/approvals/approval-service.js';
import type { ServerPrincipalProof } from '../../../connectors/principal/server-principal.js';
import type { RoomService } from '../../../rooms/room-service.js';
import type { RoomFileEditor } from '../../../rooms/repo/room-file-editor.js';
import type { RoomRepoService } from '../../../rooms/repo/room-repo-service.js';
import type { RoomMergeService } from '../../../rooms/repo/room-merge-service.js';
import type { RoomWorktreeManager } from '../../../rooms/repo/room-worktree-manager.js';
import type { RoomStore } from '../../../rooms/room-store.js';
import type { RoomRepoStore } from '../../../rooms/repo/room-repo-store.js';
import type { CanvasDocumentStore } from '../../canvas-document-store.js';
import type { DocChannelDownstream } from '../downstream/service.js';
import type { DocChannelAuthorization, DocChannelActor } from '../authorization.js';
import type { DocChannelStore } from '../store.js';
import type { DocChannelService } from '../service.js';
import type { DocCheckboxWriteService } from '../writes/checkbox-service.js';
import type { DocChannelGrants, DocGrantResult } from '../grants.js';
import type { DocGrantAuthority } from '../grant-policy.js';

/** Original constructor-captured HTTP lifetime shape; type alone grants no membership. */
export interface OriginalHttpFileOwner {
  service?: DocChannelService;
  reconciler?: import('../../../rooms/repo/room-repo-reconciler.js').RoomRepoReconciler;
  editor?: RoomFileEditor;
  repoService?: RoomRepoService;
  mergeService?: RoomMergeService;
  worktrees?: RoomWorktreeManager;
  rooms: RoomService;
  roomStore: RoomStore;
  native: Db['$client'];
  db: Db;
  store: DocChannelStore;
  actor: DocChannelHttp['actor'];
  principalCurrent: (proof: ServerPrincipalProof) => boolean;
  closed: boolean;
}

/** Original constructor-captured HTTP lifetime shape; type alone grants no membership. */
export interface OriginalHttpRoomFileCaller {
  owner: InstallationFileWrites;
  binding: OriginalHttpFileOwner;
  roomId: string;
  editor: RoomFileEditor;
  req: IncomingMessage;
  res: ServerResponse;
  headers: Readonly<IncomingMessage['headers']>;
  login: boolean;
  user?: Readonly<RequestUser>;
  admittedPrincipal?: RequestUser;
  attribution: Readonly<{ authorId: string; signedIn: boolean }>;
  active: boolean;
}

/** App-resumed filesystem placement is a separate original HTTP lifetime, never a producer turn. */
export interface OriginalHttpRoomSessionPlacement {
  owner: InstallationFileWrites;
  binding: OriginalHttpFileOwner;
  caller: object;
  sessionId: string;
  facts: Readonly<{
    roomId: string;
    targetAuthorId: string;
    targetAgentId: string;
    targetAgentPath: string;
    targetRuntime: string;
    targetSessionId: string;
    displayName: string;
  }>;
  active: boolean;
}

/** Original constructor-captured HTTP lifetime shape; type alone grants no membership. */
export interface OriginalHttpRoomRepoCaller {
  owner: InstallationFileWrites;
  binding: OriginalHttpFileOwner;
  service: RoomRepoService | RoomMergeService;
  roomId: string;
  operation: RoomRepoOperation;
  req: IncomingMessage;
  res: ServerResponse;
  headers: Readonly<IncomingMessage['headers']>;
  login: boolean;
  user?: Readonly<RequestUser>;
  admittedPrincipal?: RequestUser;
  authorId: string;
  active: boolean;
}

/** Original admitted repository operation DATA. */
export type RoomRepoOperation = 'enable' | 'repair' | 'merge';

/** Report refusal of the original Room file request credentials. */
export class RoomFileRequestAuthError extends Error {
  constructor() {
    super('Unauthorized');
    this.name = 'RoomFileRequestAuthError';
  }
}

/** Actual private HTTP map ports; selected only by the unreturned assembly custody key. */
export interface OriginalHttpRequestCustody {
  readonly originalHttpFileOwners: WeakMap<object, OriginalHttpFileOwner>;
  readonly originalHttpFileCallers: WeakMap<
    object,
    {
      owner: InstallationFileWrites;
      binding: OriginalHttpFileOwner;
      actor: ReturnType<DocChannelHttp['actor']>;
      active: boolean;
    }
  >;
  readonly originalHttpRoomFileCallers: WeakMap<object, OriginalHttpRoomFileCaller>;
  readonly originalHttpRoomSessionPlacements: WeakMap<object, OriginalHttpRoomSessionPlacement>;
  readonly originalHttpRoomRepoCallers: WeakMap<object, OriginalHttpRoomRepoCaller>;
}

/** Original installation composition inputs; callers retain existing construction checks. */
export interface OriginalDocHttpCompositionDependencies {
  db: Db;
  documents: CanvasDocumentStore;
  rooms: RoomService;
  roomStore: RoomStore;
  roomFileEditor?: RoomFileEditor;
  roomRepoService?: RoomRepoService;
  roomMergeService?: RoomMergeService;
  roomWorktreeManager?: RoomWorktreeManager;
  roomRepoReconciler?: import('../../../rooms/repo/room-repo-reconciler.js').RoomRepoReconciler;
  roomRepos: RoomRepoStore;
  approvals: ApprovalService;
  installationId: string;
  owningFileWrites?: Readonly<{ channels: DocChannelStore; fileWrites: InstallationFileWrites }>;
  nativeRuntimePrincipals?: ConnectorRuntimePrincipalService;
  roomConstruction?: import('@dorkos/db/internal-server').ServerNativeRoomConstruction;
  runtimePrincipalCurrent?: (proof: ServerPrincipalProof) => boolean;
  revalidateRuntime?: (proof: ServerPrincipalProof) => Promise<boolean>;
}

/** Original HTTP composition public result shape. */
export type OriginalDocHttpComposition = DocChannelHttp & {
  grants: DocChannelGrants;
  downstream: DocChannelDownstream;
  channels: DocChannelStore;
  authorization: DocChannelAuthorization;
  grantAuthority: DocGrantAuthority;
  fileWrites: InstallationFileWrites;
  normalFileSave: NormalFileSaveService;
  namespaceFileWrites: InstallationHttpFileWrites;
  checkboxWriter: DocCheckboxWriteService;
  grantCheckboxRoute(
    raw: unknown,
    actor: DocChannelActor,
    approvalToken?: string
  ): Promise<DocGrantResult>;
  stopCheckboxWrites(): Promise<void>;
  stopFileWrites(): Promise<void>;
};
