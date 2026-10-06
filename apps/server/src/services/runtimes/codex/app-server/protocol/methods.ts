/**
 * The subset of the `codex app-server` protocol DorkOS speaks (codex-cli
 * 0.154.0; research `20261005_codex-app-server-protocol-0154.md`).
 *
 * Hand-written on purpose: the generated TypeScript is hundreds of files and
 * carries no runtime check. What keeps these types honest is
 * `schema-snapshot.json` — the JSON Schema of every method, notification and
 * server request listed here, taken from the vendored binary — and the two
 * tests that hold this file and the binary to it
 * (`protocol-schemas.test.ts`, `protocol-snapshot.binary.test.ts`).
 *
 * Wire shape: JSON-RPC 2.0 without the `"jsonrpc"` field, one message per line.
 *
 * @module services/runtimes/codex/app-server/protocol/methods
 */

/**
 * The Codex version this protocol subset was taken from. Held equal to the
 * committed snapshot's `binaryVersion` by `protocol-schemas.test.ts`.
 */
export const PINNED_CODEX_APP_SERVER_VERSION = '0.154.0';

/** Client → server requests DorkOS sends. */
export const CLIENT_REQUEST_METHODS = [
  'initialize',
  'model/list',
  'config/read',
  'account/rateLimits/read',
  'thread/start',
  'thread/resume',
  'turn/start',
  'turn/interrupt',
  'turn/steer',
  'thread/backgroundTerminals/list',
  'thread/backgroundTerminals/terminate',
  'thread/read',
  'thread/fork',
  'thread/unsubscribe',
  'thread/compact/start',
] as const;

/** Client → server notifications DorkOS sends. */
export const CLIENT_NOTIFICATION_METHODS = ['initialized'] as const;

/**
 * Every server → client notification the pinned binary can send. The full
 * union, not just the ones DorkOS reads, so a notification a later binary adds
 * fails the schema test until somebody decides what it means
 * (`notification-mapper.ts` keys an exhaustive table on this).
 */
export const SERVER_NOTIFICATION_METHODS = [
  'error',
  'thread/started',
  'thread/status/changed',
  'thread/archived',
  'thread/deleted',
  'thread/unarchived',
  'thread/closed',
  'thread/reverted',
  'skills/changed',
  'thread/name/updated',
  'thread/goal/updated',
  'thread/goal/cleared',
  'thread/queue/changed',
  'project/changed',
  'thread/project/updated',
  'thread/environment/connected',
  'thread/environment/disconnected',
  'thread/settings/updated',
  'thread/tokenUsage/updated',
  'turn/started',
  'hook/started',
  'turn/completed',
  'hook/completed',
  'turn/diff/updated',
  'turn/plan/updated',
  'item/started',
  'item/autoApprovalReview/started',
  'item/autoApprovalReview/completed',
  'autoApprovalReview/strictReviewRequired',
  'item/completed',
  'item/agentMessage/delta',
  'item/plan/delta',
  'command/exec/outputDelta',
  'process/outputDelta',
  'process/exited',
  'item/commandExecution/outputDelta',
  'item/commandExecution/terminalInteraction',
  'item/fileChange/outputDelta',
  'item/fileChange/patchUpdated',
  'serverRequest/resolved',
  'item/mcpToolCall/progress',
  'mcpServer/oauthLogin/completed',
  'mcpServer/startupStatus/updated',
  'mcpServer/event/stream/notification',
  'account/updated',
  'account/rateLimits/updated',
  'app/list/updated',
  'remoteControl/status/changed',
  'externalAgentConfig/import/progress',
  'externalAgentConfig/import/completed',
  'fs/changed',
  'item/reasoning/summaryTextDelta',
  'item/reasoning/summaryPartAdded',
  'item/reasoning/textDelta',
  'thread/compacted',
  'model/rerouted',
  'model/verification',
  'modelProvider/authRecoveryStarted',
  'modelProvider/authRecoveryCompleted',
  'turn/moderationMetadata',
  'model/safetyBuffering/updated',
  'warning',
  'guardianWarning',
  'deprecationNotice',
  'configWarning',
  'fuzzyFileSearch/sessionUpdated',
  'fuzzyFileSearch/sessionCompleted',
  'thread/realtime/started',
  'thread/realtime/itemAdded',
  'thread/realtime/item/started',
  'thread/realtime/item/transcript/delta',
  'thread/realtime/item/completed',
  'thread/realtime/transcript/delta',
  'thread/realtime/transcript/done',
  'thread/realtime/outputAudio/delta',
  'thread/realtime/sdp',
  'thread/realtime/error',
  'thread/realtime/closed',
  'windows/worldWritableWarning',
  'windowsSandbox/setupCompleted',
  'account/login/completed',
] as const;

/** Every server → client request the pinned binary can send. */
export const SERVER_REQUEST_METHODS = [
  'item/commandExecution/requestApproval',
  'item/fileChange/requestApproval',
  'item/tool/requestUserInput',
  'mcpServer/elicitation/request',
  'item/permissions/requestApproval',
  'item/tool/call',
  'account/chatgptAuthTokens/refresh',
  'attestation/generate',
  'currentTime/read',
  'applyPatchApproval',
  'execCommandApproval',
] as const;

/** Every `ThreadItem.type` the pinned binary can send. */
export const THREAD_ITEM_TYPES = [
  'userMessage',
  'hookPrompt',
  'agentMessage',
  'functionCallOutput',
  'plan',
  'reasoning',
  'commandExecution',
  'fileChange',
  'mcpToolCall',
  'dynamicToolCall',
  'collabAgentToolCall',
  'subAgentActivity',
  'webSearch',
  'imageView',
  'sleep',
  'imageGeneration',
  'enteredReviewMode',
  'exitedReviewMode',
  'contextCompaction',
] as const;

/** A request method DorkOS sends. */
export type ClientMethod = (typeof CLIENT_REQUEST_METHODS)[number];
/** A notification method the server can send. */
export type ServerNotificationMethod = (typeof SERVER_NOTIFICATION_METHODS)[number];
/** A request method the server can send. */
export type ServerRequestMethod = (typeof SERVER_REQUEST_METHODS)[number];
/** A `ThreadItem.type`. */
export type ThreadItemType = (typeof THREAD_ITEM_TYPES)[number];

/** `SandboxMode`: the kebab-case string `thread/start` and `thread/resume` take. */
export type SandboxMode = 'read-only' | 'workspace-write' | 'danger-full-access';

/** `AskForApproval` without the experimental `granular` variant (unused). */
export type AskForApproval = 'untrusted' | 'on-request' | 'never';

/** `SandboxPolicy`: the tagged object `turn/start` takes (protocol risk 6). */
export type SandboxPolicy =
  | { type: 'dangerFullAccess' }
  | { type: 'readOnly'; networkAccess: boolean }
  | {
      type: 'workspaceWrite';
      writableRoots: string[];
      networkAccess: boolean;
      excludeTmpdirEnvVar: boolean;
      excludeSlashTmp: boolean;
    };

/** One text input item; `text_elements` is required by the schema. */
export interface TextUserInput {
  type: 'text';
  text: string;
  text_elements: unknown[];
}

/** `initialize` params. */
export interface InitializeParams {
  clientInfo: { name: string; title: string | null; version: string };
  capabilities: { experimentalApi: boolean } | null;
}

/** `initialize` result. */
export interface InitializeResult {
  userAgent: string;
  codexHome?: string;
  platformFamily?: string;
  platformOs?: string;
}

/** Per-thread overrides shared by `thread/start` and `thread/resume`. */
export interface ThreadLoadOverrides {
  cwd: string;
  model?: string;
  approvalPolicy: AskForApproval;
  approvalsReviewer: 'user';
  sandbox: SandboxMode;
  config: Record<string, unknown>;
}

/** `thread/start` params (the subset DorkOS sends). */
export type ThreadStartParams = ThreadLoadOverrides;

/** `thread/resume` params (the subset DorkOS sends). */
export interface ThreadResumeParams extends ThreadLoadOverrides {
  threadId: string;
}

/** The part of `Thread` DorkOS reads. */
export interface ThreadInfo {
  id: string;
}

/** `thread/start` / `thread/resume` result (the part DorkOS reads). */
export interface ThreadLoadResult {
  thread: ThreadInfo;
  model?: string;
}

/** `turn/start` params (the subset DorkOS sends). */
export interface TurnStartParams {
  threadId: string;
  input: TextUserInput[];
  clientUserMessageId?: string;
  cwd: string;
  approvalPolicy: AskForApproval;
  sandboxPolicy: SandboxPolicy;
  model?: string;
  effort?: string;
  summary: 'auto';
}

/** `TurnStatus`. */
export type TurnStatus = 'completed' | 'interrupted' | 'failed' | 'inProgress';

/** `TurnError`. `codexErrorInfo` is a string or a one-key object. */
export interface TurnError {
  message: string;
  codexErrorInfo?: unknown;
  additionalDetails?: string | null;
}

/** The part of `Turn` DorkOS reads. */
export interface TurnInfo {
  id: string;
  status: TurnStatus;
  error?: TurnError | null;
}

/** `turn/start` result. */
export interface TurnStartResult {
  turn: TurnInfo;
}

/** `turn/interrupt` params. */
export interface TurnInterruptParams {
  threadId: string;
  turnId: string;
}

/** `turn/steer` params: input for the open turn, guarded by its id. */
export interface TurnSteerParams {
  threadId: string;
  expectedTurnId: string;
  input: TextUserInput[];
  clientUserMessageId?: string;
}

/** `thread/read` params: metadata only unless `includeTurns`. */
export interface ThreadReadParams {
  threadId: string;
  includeTurns?: boolean;
}

/** `thread/read` result (the part DorkOS reads). */
export interface ThreadReadResult {
  thread: { id: string; turns?: Array<{ id: string; status: string }> | null };
}

/** `model/list` params. */
export interface ModelListParams {
  cursor: string | null;
  includeHidden: boolean;
  limit: number;
}

/** `config/read` params. */
export interface ConfigReadParams {
  cwd: string;
}

/** `config/read` result (the part DorkOS reads). */
export interface ConfigReadResult {
  config: { projects?: Record<string, { trust_level?: string } | undefined> | null };
}

/** Params and results by method, for the typed client. */
export interface ClientMethodMap {
  initialize: { params: InitializeParams; result: InitializeResult };
  'model/list': { params: ModelListParams; result: unknown };
  'config/read': { params: ConfigReadParams; result: ConfigReadResult };
  'account/rateLimits/read': { params: null; result: unknown };
  'thread/start': { params: ThreadStartParams; result: ThreadLoadResult };
  'thread/resume': { params: ThreadResumeParams; result: ThreadLoadResult };
  'turn/start': { params: TurnStartParams; result: TurnStartResult };
  'turn/interrupt': { params: TurnInterruptParams; result: Record<string, never> };
  'turn/steer': { params: TurnSteerParams; result: { turnId: string } };
  'thread/backgroundTerminals/list': {
    params: { threadId: string };
    result: { data: unknown[]; nextCursor?: string | null };
  };
  'thread/backgroundTerminals/terminate': {
    params: { threadId: string; processId: string };
    result: { terminated: boolean };
  };
  'thread/read': { params: ThreadReadParams; result: ThreadReadResult };
  'thread/fork': { params: ThreadResumeParams; result: ThreadLoadResult };
  'thread/unsubscribe': { params: { threadId: string }; result: { status: string } };
  'thread/compact/start': { params: { threadId: string }; result: Record<string, never> };
}

/** One notification as it arrives. */
export interface ServerNotification {
  method: string;
  params: unknown;
}

/** One server → client request as it arrives. */
export interface ServerRequest {
  id: number | string;
  method: string;
  params: unknown;
}

/**
 * The reply DorkOS sends to a server request it does not act on: the method's
 * own "no" (P1 answers EVERY approval-shaped request this way and never
 * accepts anything), or `null` for methods with no refusal shape, which are
 * answered with a JSON-RPC error instead.
 *
 * @param method - The server request's method.
 */
export function refusalFor(method: string): Record<string, unknown> | null {
  switch (method) {
    case 'item/commandExecution/requestApproval':
    case 'item/fileChange/requestApproval':
      return { decision: 'decline' };
    case 'execCommandApproval':
    case 'applyPatchApproval':
      return { decision: { denied: { rejection: 'DorkOS declined this request.' } } };
    case 'item/permissions/requestApproval':
      return { permissions: {}, scope: 'turn' };
    case 'mcpServer/elicitation/request':
      return { action: 'cancel', content: null, _meta: null };
    case 'item/tool/requestUserInput':
      return { answers: {} };
    case 'item/tool/call':
      return { contentItems: [], success: false };
    default:
      return null;
  }
}
