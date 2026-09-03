import type { Query } from '@anthropic-ai/claude-agent-sdk';
import type {
  StreamEvent,
  PermissionModeId,
  EffortLevel,
  UiState,
  ContextUsage,
  UsageStatus,
} from '@dorkos/shared/types';
import type { PendingInteraction } from './messaging/interaction-wait.js';
import { createToolResultImageState, type ToolResultImageState } from './tool-result-images.js';

/** Input-side token usage of a single model request (one API round-trip). */
export interface RequestUsage {
  /** Fresh, uncached input tokens. */
  inputTokens: number;
  /** Tokens served from the prompt cache. */
  cacheReadTokens: number;
  /** Tokens written to the prompt cache. */
  cacheCreationTokens: number;
}

/** In-memory state for an active agent session. */
export interface AgentSession {
  sdkSessionId: string;
  lastActivity: number;
  /**
   * The mode this session runs under — any id a runtime declared, not only a
   * name from the shared enum (DOR-885). A session persisted in a mode this
   * runtime has since retired still loads and runs; the id is checked into the
   * SDK's narrower vocabulary where a query is actually built
   * (`messaging/launch-resolver.ts`), and nowhere earlier.
   */
  permissionMode: PermissionModeId;
  model?: string;
  effort?: EffortLevel;
  fastMode?: boolean;
  cwd?: string;
  /**
   * The Claude Code account this session belongs to: the absolute Claude CONFIG
   * directory its transcript lives under (`~/.claude`, `~/.claude2`, …). Not
   * `cwd`, which is the working directory — the two are unrelated paths.
   *
   * Resolved from disk, never chosen: a session's transcript exists under exactly
   * one account, and only that account can resume it, so this is the account the
   * next turn must run and bill on regardless of which one is currently active
   * (spec `claude-code-accounts` D3). Set by `SessionStore.ensureForMessage` from
   * the transcript probe it already performs.
   *
   * UNDEFINED means unknown, which is the honest answer in two cases: a session
   * with no transcript yet (a brand-new session runs on the ACTIVE account — that
   * is what makes it the active one), and a transcript no registered account
   * holds. A consumer must treat undefined as "use the active account", never as
   * a reason to fail.
   */
  accountRoot?: string;
  /**
   * The Claude root the most recent launch RESOLUTION on this session settled on
   * — `session.accountRoot` when disk had already decided, otherwise whatever the
   * launch ladder picked (`resolveLaunch`, ADR 260821-205323).
   *
   * "Settled on", not "ran on", and the difference is real: `resolveLaunch` also
   * runs on the pump's compare path, where the dispatch it was resolving can
   * still be refused before any process is spoken to. So this is the account the
   * next launch of this session WOULD use, which the account it last ran on can
   * only differ from while a dispatch is being refused — and a refused dispatch
   * produces no turn, so it produces no edge for the watch to mis-credit either.
   *
   * **Deliberately a second field, and never written back to
   * {@link accountRoot}.** That one is disk-derived truth, and its presence is
   * the ladder's only gate (spec `billing-account-ladder` invariant 5) — setting
   * it from a ladder result would pin a session to an account before any
   * transcript existed, so a launch that died before writing one could never be
   * retried onto the account a person then picked.
   *
   * What it is FOR is the question `AgentRuntime.getSessionAccount` answers:
   * which credential did this turn use? The sign-in watch keys its episodes on
   * that, so a clean turn on a healthy account cannot clear a condition a dead
   * one raised. Undefined until the first launch this process resolved for the
   * session, which reads as "not known here" and costs only the account
   * distinction, never the notice.
   */
  launchedAccountRoot?: string;
  /** True once the first SDK query has been sent (JSONL file exists) */
  hasStarted: boolean;
  /**
   * True when nobody is watching this session — a scheduled task run.
   *
   * Read by the interactive handlers: an unattended prompt is refused at the
   * ten-minute countdown and never parks, because a park is a promise that
   * somebody will come back (spec `ask-parks-on-timeout` §7).
   */
  unattended?: boolean;
  /** True when auto-created by updateSession — sendMessage should check transcript before first query. */
  needsTranscriptCheck?: boolean;
  /**
   * Wire `uuid` of the last MAIN-THREAD assistant message this session produced
   * (SDK `SDKAssistantMessage.uuid`; subagent messages are excluded). Used to
   * anchor the NEXT turn's resume via `options.resumeSessionAt` so the CLI's
   * resume-interrupt classifier never sees a trailing bookkeeping attachment
   * (e.g. a Stop-hook `hook_success` entry) as an interrupted turn and injects a
   * synthetic "Continue from where you left off." turn before the real prompt.
   * Undefined on a fresh session, a cold (post-restart) resume, or a turn that
   * produced no assistant message — all of which fall back to a plain resume.
   * See `message-sender.ts`.
   */
  lastAssistantUuid?: string;
  /** Active SDK query object — used for mid-stream control (setPermissionMode, setModel) */
  activeQuery?: Query;
  /** Last completed SDK query — persisted after streaming for post-stream control (reloadPlugins). */
  lastQuery?: Query;
  /**
   * Queries whose stdin DorkOS has already ended — the held prompt was closed,
   * so that CLI subprocess can no longer receive anything DorkOS writes,
   * control requests included (`messaging/stdin-hold.ts`).
   *
   * A SET keyed by the query, not a single slot and not a flag, for two reasons
   * that both come from overlapping turns sharing one session (DOR-1088): an
   * outgoing turn closing its own stdin must not make its successor's healthy
   * query look deaf, and an older turn settling LATE must not overwrite a
   * record the newer one already wrote. Weak, so a retired query is collected
   * with everything else that referenced it and nothing has to be cleared.
   *
   * Read by `interruptGivenQuery`, which closes such a query at once rather
   * than awaiting an ack that can never arrive (DOR-1244).
   */
  stdinEndedQueries?: WeakSet<Query>;
  /**
   * Queries a DorkOS Stop has been aimed at — `interruptQuery`, the room halt,
   * the stall watchdog, a Stop during launch. Recorded before the interrupt is
   * even attempted, so a Stop still in flight when the stream ends still counts.
   *
   * Same shape and the same reasons as {@link stdinEndedQueries}. Read by the
   * send loop, which uses it to settle a turn that was stopped rather than
   * finished as `interrupted` instead of idle (DOR-1244).
   */
  stoppedQueries?: WeakSet<Query>;
  pendingInteractions: Map<string, PendingInteraction>;
  eventQueue: StreamEvent[];
  eventQueueNotify?: () => void;
  /**
   * Wall time of the last operator/DorkOS-initiated `interruptQuery` or
   * `stopTask`. A CLI interrupt sentinel arriving shortly after this is
   * legitimate fallout from the stop, not a phantom (DOR-1087). Cleared when
   * the stop provably failed and at the start of each new turn.
   */
  interruptRequestedAt?: number;
  /** Client-reported UI state, updated with each message. Used by `get_ui_state` tool. */
  uiState?: UiState;
  /**
   * Memory file paths surfaced by the SDK for this session (SDK 0.2.105+).
   * Populated when `system/memory_recall` events arrive; aggregated across the session.
   */
  memoryPaths?: string[];
  /**
   * Input-side token usage of the most recent main-thread (non-subagent) model
   * request, captured from each completed `assistant` message as it streams. The
   * last value before the `result` reflects the current context-window
   * occupancy — unlike `result.modelUsage`, which sums every request in the turn
   * and so over-counts on multi-tool-call turns. Subagent messages are excluded
   * (their usage is a separate context). See `result-event-mapper.ts`.
   */
  lastRequestUsage?: RequestUsage;
  /**
   * Last subscription usage observed on a `rate_limit_event` (utilization,
   * window label, reset time, health). Held so a cost-only `result`
   * `session_status` can re-attach the known subscription fields and the merged
   * Usage & cost status item does not flicker between `kind`s. Undefined until
   * the first rate-limit signal (e.g. an API-key session never sets it).
   */
  lastSubscriptionUsage?: UsageStatus;
  /**
   * Authoritative context-usage breakdown from the SDK's `getContextUsage()`,
   * fetched at turn end while the subprocess is held alive (see message-sender).
   * Consumed by the result-event mapper to emit the rich `context_usage` event;
   * falls back to a self-computed total when unset (fetch failed or timed out).
   * Reset at the start of each turn.
   */
  contextBreakdown?: ContextUsage;
}

/**
 * Mutable tool tracking state passed by reference into the event mapper.
 *
 * It also carries the turn's MEDIA bookkeeping ({@link ToolResultImageState}):
 * a picture arrives inside a `tool_result`, so the object that already
 * correlates tool ids across a turn is the one that has to hold it. Storing
 * bytes is I/O and the mapper does none, so what lands here is an intent that
 * `media-capture.ts` drains from the turn loop.
 */
export interface ToolState extends ToolResultImageState {
  inTool: boolean;
  currentToolName: string;
  currentToolId: string;
  taskToolInput: string;
  inThinking: boolean;
  thinkingStartMs: number;
  /** Lookup table mapping tool_use block IDs to tool names for result correlation. */
  toolNameById: Map<string, string>;
  /** Tool IDs whose results were already delivered via tool_use_summary. */
  resolvedResultIds: Set<string>;
  /** Tool IDs that received at least one input_json_delta during streaming. */
  toolInputReceived: Set<string>;
  appendTaskInput: (chunk: string) => void;
  resetTaskInput: () => void;
  setToolState: (tool: boolean, name: string, id: string) => void;
}

/**
 * Whether DorkOS aimed a Stop at this query — the intent half of the two-part
 * gate on a stopped turn's error frame (DOR-1320).
 *
 * Reads {@link AgentSession.stoppedQueries}, which is written BEFORE the
 * interrupt is even attempted, so a Stop still in flight when the turn's stream
 * ends already counts. Matched by query identity rather than per session: the
 * resume path can have two turns overlapping on one session (DOR-1088), and an
 * outgoing turn's Stop must not condemn its successor.
 *
 * **Per-turn only because the caller keeps it so.** One query is one turn on the
 * resume path; a pump runs many turns on ONE query, so it clears its query out
 * of the record at every dispatch — without which a single Stop would mark
 * every later turn on that warm process as stopped (`persistent-dispatch.ts`).
 *
 * @param session - The session holding the stop record
 * @param query - The query running the turn in question, if there is one
 */
export function stopWasAimedAt(session: AgentSession, query: Query | undefined): boolean {
  return query !== undefined && session.stoppedQueries?.has(query) === true;
}

/** Create a fresh ToolState instance for a streaming loop. */
export function createToolState(): ToolState {
  let inTool = false;
  let currentToolName = '';
  let currentToolId = '';
  let taskToolInput = '';
  let inThinking = false;
  let thinkingStartMs = 0;
  const toolNameById = new Map<string, string>();
  const resolvedResultIds = new Set<string>();
  const toolInputReceived = new Set<string>();
  const media = createToolResultImageState();
  return {
    ...media,
    get inTool() {
      return inTool;
    },
    get currentToolName() {
      return currentToolName;
    },
    get currentToolId() {
      return currentToolId;
    },
    get taskToolInput() {
      return taskToolInput;
    },
    get inThinking() {
      return inThinking;
    },
    set inThinking(v: boolean) {
      inThinking = v;
    },
    get thinkingStartMs() {
      return thinkingStartMs;
    },
    set thinkingStartMs(v: number) {
      thinkingStartMs = v;
    },
    toolNameById,
    resolvedResultIds,
    toolInputReceived,
    appendTaskInput: (chunk: string) => {
      taskToolInput += chunk;
    },
    resetTaskInput: () => {
      taskToolInput = '';
    },
    setToolState: (tool: boolean, name: string, id: string) => {
      inTool = tool;
      currentToolName = name;
      currentToolId = id;
    },
  };
}
