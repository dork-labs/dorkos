/** JSON values retained verbatim in durable model records. */
export type JsonValue =
  null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };
/** Complete provider message, including opaque reasoning and extension fields. */
export interface ModelMessage {
  role: string;
  [key: string]: JsonValue;
}
/** Independent conversation namespace; children and beats never replace main context. */
export type ContextScope = 'main' | `child:${string}` | `beat:${string}` | `summary:${string}`;
/** Explicit transport and billing selection. Credentials are resolved only when requesting. */
export interface ModelDescriptor {
  protocol: 'anthropic-messages' | 'openai-completions' | 'openai-responses';
  endpoint: string;
  id: string;
  contextWindow: number;
  maxOutputTokens: number;
  payer: string;
  historyFamily: string;
  credentials: (signal: AbortSignal) => Promise<string | undefined>;
  requiresCredentials?: boolean;
  supportsImages?: boolean;
  supportsThinking?: boolean;
  costRates?: { input: number; output: number; cacheRead: number; cacheWrite: number };
}
/** Provider counts and costs are optional: absence never means zero. */
export interface ModelUsage {
  requestId: string;
  inputTokens?: number;
  outputTokens?: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  costUsd?: number;
  modelId?: string;
  purpose?: 'run' | 'summary' | 'builder' | 'beat';
  /** Last original input message sequence and active checkpoint at the time usage was measured. */
  contextMessageSeq?: number;
  contextCheckpointSeq?: number;
  /** Estimated input with then-current instructions/schemas; anchors subsequent estimated growth. */
  contextEstimateTokens?: number;
  /** SHA-256 identity of then-current instruction/schema state; changed state is estimated even at equal size. */
  contextSystemHash?: string;
  [key: string]: JsonValue | undefined;
}
/** Estimate provenance distinguishes measured provider counts from local estimates. */
export interface TokenEstimate {
  tokens: number;
  source: 'provider' | 'estimated';
  /** Exact provider input component, when a durable request anchor is available. */
  providerTokens?: number;
  /** Estimated trailing messages and instruction/schema growth; mixed counts use source estimated. */
  estimatedTokens?: number;
}
/** Host-owned canonical filesystem grants. Instructions do not expand these grants. */
export interface PathPolicy {
  readRoots: readonly string[];
  writeRoots: readonly string[];
}
/** Process execution requires unrestricted authorization or an injected isolated executor. */
export type ExecutionPolicy =
  | { kind: 'unrestricted'; environment: Readonly<Record<string, string>> }
  | { kind: 'isolated'; execute: (request: ExecutionRequest) => Promise<ExecutionResult> };
/** Bounded, cancellable subprocess request. */
export interface ExecutionRequest {
  command: string;
  cwd: string;
  environment: Readonly<Record<string, string>>;
  timeoutMs: number;
  maxOutputBytes: number;
  signal: AbortSignal;
}
/** Captured subprocess result. */
export interface ExecutionResult {
  stdout: string;
  stderr: string;
  exitCode: number | null;
  truncated: boolean;
}
/** Explicit skill roots, highest priority first; namespaces qualify names. */
export interface SkillRoot {
  path: string;
  namespace?: string;
}
/** Supplied resources; no vendor or home-directory discovery is implied. */
export interface ResourceConfig {
  ancestorDirectories: readonly string[];
  agentDirectory?: string;
  skillRoots: readonly SkillRoot[];
  memory?: string;
  context?: string;
}
/** Metadata catalogue excludes skill bodies. */
export interface SkillMetadata {
  name: string;
  description: string;
  location: string;
  disableModelInvocation: boolean;
}
/** Context assembled by the resource module, with path-specific instructions loaded on demand. */
export interface Resources {
  load(): Promise<string>;
  beforeFile(path: string, signal: AbortSignal): Promise<string>;
  skills(): Promise<readonly SkillMetadata[]>;
  loadSkill(name: string, signal: AbortSignal): Promise<string>;
}
/** Execution callback context carries cancellation, scoped persistence and host progress. */
export interface ToolContext {
  sessionId: string;
  callId?: string;
  scope: ContextScope;
  workingDirectory: string;
  signal: AbortSignal;
  emit: (event: DoeEvent) => void;
  execute?: (options: ScopedExecutionOptions) => Promise<ModelRunResult>;
}
/** Provider-compatible tool result retaining image and structured content. */
export interface ToolResult {
  content: JsonValue[];
  structuredContent?: JsonValue;
  isError?: boolean;
}
/** Tool schema is JSON; Pi-specific TypeBox conversion belongs to the internal engine. */
export interface ToolDescriptor {
  name: string;
  description: string;
  schema: { [key: string]: JsonValue };
  searchHint?: string;
  initialLoad?: boolean;
  execute: (arguments_: JsonValue, context: ToolContext) => Promise<ToolResult>;
}
/** Registry ownership seam: discovery selects schemas without invoking tools. */
export interface ToolRegistry {
  register(tool: ToolDescriptor): void;
  selected(): readonly ToolDescriptor[];
  search(query: string, limit?: number): readonly ToolDescriptor[];
  execute(name: string, arguments_: JsonValue, context: ToolContext): Promise<ToolResult>;
}
/** Approval decision is host policy, not a permission mode imposed by Doe. */
export type ApprovalCallback = (
  tool: ToolDescriptor,
  arguments_: JsonValue,
  context: ToolContext
) => Promise<'allow' | 'deny'>;
/** Host retry decisions; implementations must still refuse replay after observable effects. */
export interface RetryPolicy {
  maxAttempts: number;
  delayMs: (attempt: number) => number;
  fallbacks?: readonly ModelDescriptor[];
}
/** Structured reporting rung selected by the host. */
export interface BeatRaise {
  message: string;
  rung: 'record' | 'report' | 'room' | 'dm' | 'notification';
}
/** Explicit beat outcome; streamed prose is never a notification. */
export type BeatResult =
  | { kind: 'skipped'; reason: string }
  | { kind: 'quiet' }
  | { kind: 'raises'; raises: readonly BeatRaise[] };
/** Lightweight isolated beat inputs and optional preflight decision. */
export interface BeatRequest {
  id: string;
  prompt: string;
  changes?: string;
  instructions?: string;
  commitments?: string;
  signal?: AbortSignal;
  decide?: () => Promise<{ action: 'skip' | 'run'; reason: string }>;
}
/** Tagged stream events distinguish child/beat activity and durable completion. */
export type DoeEvent =
  | { type: 'text' | 'thinking'; delta: string; scope: ContextScope }
  | {
      type: 'tool-start' | 'tool-progress' | 'tool-end';
      name: string;
      callId: string;
      scope: ContextScope;
      result?: ToolResult;
      progress?: string;
      /** The tool's arguments, on `tool-start` only; the host's audit record reads its target. */
      input?: unknown;
    }
  | { type: 'usage'; usage: ModelUsage; scope: ContextScope }
  | { type: 'retry'; attempt: number; scope: ContextScope }
  | { type: 'substitution'; from: string; to: string; scope: ContextScope }
  | { type: 'compaction-start'; scope: ContextScope }
  | {
      type: 'compaction-end';
      outcome: 'completed';
      before: TokenEstimate;
      after: TokenEstimate;
      scope: ContextScope;
    }
  | { type: 'compaction-end'; outcome: 'failed' | 'aborted'; error: string; scope: ContextScope }
  | { type: 'complete' | 'aborted' | 'error'; scope: ContextScope; error?: string };
/** Explicit host configuration, with no automatic model/auth/resource resolution. */
export interface DoeConfig {
  sessionId: string;
  workingDirectory: string;
  model: ModelDescriptor;
  store: ModelStore;
  resources: Resources;
  registry: ToolRegistry;
  approve?: ApprovalCallback;
  retry?: RetryPolicy;
  onEvent?: (event: DoeEvent) => void;
  profile?: { role?: string; manager?: string; goals?: readonly string[] };
  pathPolicy: PathPolicy;
  extensions?: FacadeExtensions;
}
/** Queue result mirrors the underlying engine's existing queues. */
export type QueueDisposition = 'queued' | 'idle';
/** Durable complete message record. Sequence numbers are monotonic within session and scope. */
export interface MessageRecord {
  seq: number;
  payload: ModelMessage;
}
/** Atomic summary boundary and summary-call usage. */
export interface CheckpointInput {
  summary: ModelMessage;
  /** Immutable current instruction/schema snapshot replayed after retained historic system deltas. */
  currentSystem?: ModelMessage;
  /** Original sequence after which the system snapshot applies; newer records replay afterward. */
  systemAfterSeq?: number;
  firstRetainedSeq: number;
  before: TokenEstimate;
  after: TokenEstimate;
  usage: ModelUsage;
  usageScope?: ContextScope;
}
/** Stored checkpoint remains separate from original archive messages. */
export interface CheckpointRecord extends CheckpointInput {
  seq: number;
}
/** Restored context prepends the newest summary to retained original records. */
export interface RestoredContext {
  checkpoint?: CheckpointRecord;
  messages: readonly MessageRecord[];
}
/** Host-owned durable store; only explicit deletion removes a session's history. */
export interface ModelStore {
  readonly identity?: string;
  createSession(id: string, metadata?: JsonValue): void;
  metadata(id: string): JsonValue;
  listSessions(): readonly SessionMetadata[];
  recordOutcome(id: string, result: BeatResult, scope: ContextScope): void;
  outcomes(id: string, scope: ContextScope): readonly BeatOutcomeRecord[];
  allUsage(id: string): readonly ScopedUsage[];
  appendMessage(id: string, payload: ModelMessage, scope?: ContextScope): MessageRecord;
  complete(
    id: string,
    messages: readonly ModelMessage[],
    usage: ModelUsage,
    scope?: ContextScope
  ): readonly MessageRecord[];
  recordUsage(id: string, usage: ModelUsage, scope?: ContextScope): void;
  checkpoint(id: string, checkpoint: CheckpointInput, scope?: ContextScope): CheckpointRecord;
  archive(id: string, scope?: ContextScope): readonly MessageRecord[];
  restore(id: string, scope?: ContextScope): RestoredContext;
  usage(id: string, scope?: ContextScope): readonly ModelUsage[];
  deleteSession(id: string): void;
  close(): void;
}

/** Session listing remains host-owned; metadata is opaque JSON. */
export interface SessionMetadata {
  id: string;
  metadata: JsonValue;
}
/** A durable isolated beat outcome, ordered within its scope. */
export interface BeatOutcomeRecord {
  seq: number;
  result: BeatResult;
}
/** All request usage includes provenance to avoid counting children twice. */
export interface ScopedUsage {
  scope: ContextScope;
  seq: number;
  usage: ModelUsage;
}
/** Facade extension seams; compaction runs before each request, including continued tool turns. */
export interface FacadeExtensions {
  beforeRequest?: (context: ExtensionContext) => Promise<void>;
  compact?: (context: ExtensionContext) => Promise<void>;
  /** Return a validated outcome; the facade persists it and emits completion after owned executions drain. */
  runBeat?: (request: BeatRequest, context: ExtensionContext) => Promise<BeatResult>;
}
/** Extension context delegates to scoped execution instead of rewriting facade queues. */
export interface ExtensionContext {
  config: DoeConfig;
  messages: readonly ModelMessage[];
  records: readonly MessageRecord[];
  prompt: string;
  tools: readonly ToolDescriptor[];
  scope: ContextScope;
  signal: AbortSignal;
  emit: (event: DoeEvent) => void;
  execute: (options: ScopedExecutionOptions) => Promise<ModelRunResult>;
}

/** Scoped model result allows summaries to refuse errors, aborts and length stops. */
export interface ModelRunResult {
  /** A host approval was denied or malformed; distinguish it from recoverable tool errors. */
  approvalDenied?: boolean;
  usage: readonly ModelUsage[];
  messages: readonly ModelMessage[];
  stopReason: 'stop' | 'length' | 'error' | 'aborted';
}
/** Builder-specific host guidance and tools never enter the business toolset. */
export interface BuilderConfig {
  workingDirectory: string;
  resources: Resources;
  guidance?: string;
  tools?: readonly ToolDescriptor[];
  model?: ModelDescriptor;
  maxResultCharacters: number;
  maxDurationMs: number;
  maxOutputBytes: number;
}

/** Explicit child/summary/beat execution; fixed scoped tools never inherit the main registry. */
export interface ScopedExecutionOptions {
  prompt: string;
  messages: readonly ModelMessage[];
  tools: readonly ToolDescriptor[];
  scope: ContextScope;
  purpose: 'run' | 'summary' | 'builder' | 'beat';
  registry?: ToolRegistry;
  model?: ModelDescriptor;
  workingDirectory?: string;
  resources?: Resources;
  signal?: AbortSignal;
  finishTurn?: (
    messages: readonly ModelMessage[],
    signal: AbortSignal
  ) => Promise<'continue' | 'end'>;
}
