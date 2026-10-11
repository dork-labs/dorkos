import type {
  drainDataAuthorizedOriginalTokenOwner,
  openAuthorizedOriginalTokenStream,
  nextAuthorizedOriginalTokenStream,
  restoreAuthorizedOriginalTokenScope,
  replayAuthorizedOriginalTokenScope,
  readAuthorizedOriginalTokenEvent,
} from '../authorization.js';
import type {
  admitAuthorizedOriginalTokenIngress,
  submitAuthorizedOriginalTokenIngress,
  issueAuthorizedOriginalDocToken,
  revokeAuthorizedOriginalDocToken,
} from '../authorization.js';

/** Current-authorized document channel reads and durable event acceptance. */
import type { CanvasChannelEventReceipt } from '@dorkos/shared/canvas-channel-schemas';
import type { DocChannelIngest } from '../ingest.js';

import type {
  DocEventCondition,
  DocReceiptInspection,
  DocCurrentReplayResponse,
} from '../current/current-operation-types.js';

import type { DocChannelGrants } from '../grants.js';

import type { DocChannelAuthorization, DocChannelActor } from '../authorization.js';
import type { DocChannelStore } from '../store.js';

/** Original constructor-captured service operations; erased fields alone confer no membership. */
export interface OriginalCurrentServiceBinding {
  presence: (
    documentId: string,
    actor: DocChannelActor,
    raw: unknown
  ) => Promise<import('@dorkos/shared/canvas-channel-schemas').CanvasChannelPresenceResponse>;
  documentReplay: (
    authority: import('../current/current-operation-types.js').OriginalCurrentDocumentAuthority,
    since: number,
    limit: number
  ) => Promise<DocCurrentReplayResponse>;
  documentInspect: (
    authority: import('../current/current-operation-types.js').OriginalCurrentDocumentAuthority,
    eventId: string
  ) => Promise<DocReceiptInspection>;
  documentSubmit: (
    authority: import('../current/current-operation-types.js').OriginalCurrentDocumentAuthority,
    raw: unknown
  ) => Promise<CanvasChannelEventReceipt>;
  tokenOpenStream: (
    scope: import('../current/current-operation-types.js').OriginalNativeDocTokenScope,
    since: number
  ) => ReturnType<typeof openAuthorizedOriginalTokenStream>;
  tokenStreamNext: (
    stream: import('../current/current-operation-types.js').OriginalNativeDocTokenStream
  ) => ReturnType<typeof nextAuthorizedOriginalTokenStream>;
  tokenDrainData: () => ReturnType<typeof drainDataAuthorizedOriginalTokenOwner>;
  tokenStreamState: (
    stream: import('../current/current-operation-types.js').OriginalNativeDocTokenStream
  ) => Readonly<{ waiting: boolean; closed: boolean }>;
  tokenStreamClosed: (
    stream: import('../current/current-operation-types.js').OriginalNativeDocTokenStream
  ) => Promise<void>;
  tokenCloseStream: (
    stream: import('../current/current-operation-types.js').OriginalNativeDocTokenStream
  ) => void;
  restoreToken: (hash: string) => ReturnType<typeof restoreAuthorizedOriginalTokenScope>;
  tokenReplay: (
    scope: import('../current/current-operation-types.js').OriginalNativeDocTokenScope,
    since: number,
    limit: number,
    permission?: 'replay' | 'stream'
  ) => ReturnType<typeof replayAuthorizedOriginalTokenScope>;
  tokenEvent: (
    scope: import('../current/current-operation-types.js').OriginalNativeDocTokenScope,
    eventId: string,
    permission: 'replay' | 'stream'
  ) => ReturnType<typeof readAuthorizedOriginalTokenEvent>;
  tokenIngressCurrent: (
    scope: import('../current/current-operation-types.js').OriginalNativeDocTokenScope
  ) => ReturnType<typeof admitAuthorizedOriginalTokenIngress>;
  tokenSubmit: (
    scope: import('../current/current-operation-types.js').OriginalNativeDocTokenScope,
    raw: unknown
  ) => ReturnType<typeof submitAuthorizedOriginalTokenIngress>;
  revokeToken: (
    actor: DocChannelActor,
    documentId: string,
    tokenId: string
  ) => ReturnType<typeof revokeAuthorizedOriginalDocToken>;
  issueToken: (
    actor: DocChannelActor,
    request: unknown,
    grantIds: readonly string[]
  ) => ReturnType<typeof issueAuthorizedOriginalDocToken>;
  captureDocument: (
    documentId: string,
    actor: DocChannelActor,
    grantIds: readonly string[]
  ) => Promise<import('../current/current-operation-types.js').OriginalCurrentDocumentData>;
  requireTokenDependencies: (
    authorization: DocChannelAuthorization,
    store: DocChannelStore,
    grants: DocChannelGrants
  ) => void;
  requireGrantDependencies: (
    store: import('../store.js').DocChannelStore,
    grants: import('../grants.js').DocChannelGrants
  ) => void;
  requireDocumentInTransaction: (
    authority: import('../current/current-operation-types.js').OriginalCurrentDocumentAuthority,
    tx: import('@dorkos/db').DbTransaction
  ) => void;
  requireDocument: (
    authority: import('../current/current-operation-types.js').OriginalCurrentDocumentAuthority
  ) => Promise<import('../current/current-operation-types.js').OriginalCurrentDocumentData>;
  prepareRoomResponder: (
    runtime: object,
    holder: import('@dorkos/shared/agent-runtime').SseResponse,
    key: string
  ) => Promise<import('../current/current-operation-types.js').PreparedRoomResponder | undefined>;
  commitRoomResponder: (
    runtime: object,
    prepared: import('../current/current-operation-types.js').PreparedRoomResponder
  ) => import('../current/current-operation-types.js').OriginalCommittedRoomResponder;
  nextRoomDueAt: () => string | undefined;
  wakeRoomDue: () => void;
  hintRoomRelay: (documentId: string, batchId: string, generation: string) => boolean;
  subscribeRoomRelay: (
    listener: (documentId: string, batchId: string, generation: string) => void
  ) => () => void;
  pumpRoomDue: (
    registry: import('../../../core/runtime-registry.js').RuntimeRegistry
  ) => Promise<void>;
  stopRoomPump: () => Promise<void>;
  readRoomScenarioEvidence: import('../current/current-operation-types.js').CurrentDocOperationEngineCore['readRoomScenarioEvidence'];
  prepareCheckbox: (owner: object) => void;
  completeCheckbox: (
    owner: object,
    tx: import('@dorkos/db').DbTransaction
  ) => Extract<import('../writes/checkbox-evidence.js').CheckboxReceipt, { status: 'changed' }>;
  publishCheckbox: (owner: object, tx: import('@dorkos/db').DbTransaction) => void;
  abandonCheckbox: (owner: object, tx: import('@dorkos/db').DbTransaction) => void;
  notifyCheckboxCommitted: () => undefined;
  maintainHistory: () => void;
  subscribeRoomDue: (listener: () => void) => () => void;
  replayExpired: (
    raw: unknown,
    actor: DocChannelActor
  ) => Promise<import('@dorkos/shared/canvas-channel-schemas').CanvasChannelBatchReplayResult>;
  management: (
    documentId: string,
    actor: DocChannelActor
  ) => Promise<import('@dorkos/shared/canvas-channel-schemas').CanvasChannelManagementSnapshot>;
  replay: (
    documentId: string,
    actor: DocChannelActor,
    since: number,
    limit: number
  ) => Promise<DocCurrentReplayResponse>;
  prepareDocumentSave: (
    scope: object,
    actor: DocChannelActor
  ) => Promise<import('../writes/normal-file-save.js').NormalFileSaveOutcome | undefined>;
  completeDocumentSave: (
    scope: object,
    actor: DocChannelActor
  ) => Promise<CanvasChannelEventReceipt>;
  selection: (raw: unknown, actor: DocChannelActor) => Promise<CanvasChannelEventReceipt>;
  submit: (
    documentId: string,
    raw: unknown,
    actor: DocChannelActor,
    condition: DocEventCondition
  ) => Promise<CanvasChannelEventReceipt>;
  inspect: (
    documentId: string,
    eventId: string,
    actor: DocChannelActor,
    condition: DocEventCondition
  ) => Promise<DocReceiptInspection>;
}

import type { DocChannelService } from '../service.js';
/** Original fixed construction arguments and private live listener projection. */
export interface OriginalServiceConstructionView {
  readonly service: DocChannelService;
  readonly channels: DocChannelStore;
  readonly authorization: DocChannelAuthorization;
  readonly events: { ingest: DocChannelIngest; grants: DocChannelGrants } | undefined;
  readonly committedInputListeners: Set<() => void>;
  readonly bind: (binding: OriginalCurrentServiceBinding) => void;
}
