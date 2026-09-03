/**
 * Service seams for the Direct (in-process) Transport.
 *
 * The embedding host (Obsidian plugin) wires concrete server services into
 * this interface so {@link import('../direct-transport').DirectTransport}
 * can satisfy the Transport contract without HTTP.
 *
 * @module shared/lib/direct/services
 */
import type {
  RuntimeCapabilities,
  SessionOpts,
  SessionUpdateResult,
} from '@dorkos/shared/agent-runtime';
import type { ClientContext } from '@dorkos/shared/additional-context';
import type { RuntimeCommandIntentId } from '@dorkos/shared/command-intents';
import type { SearchAnswer, SearchQuery } from '@dorkos/shared/search-schemas';
import type {
  SessionSnapshot,
  SessionEvent,
  SessionListEvent,
} from '@dorkos/shared/session-stream';
import type {
  Session,
  SessionSettings,
  HistoryMessage,
  CommandRegistry,
  TaskItem,
  GitStatusResponse,
  GitStatusError,
  DiffBaselineResponse,
  ReloadPluginsResult,
  ModelOption,
  SubagentInfo,
  PendingInteractionDTO,
} from '@dorkos/shared/types';

export interface DirectTransportServices {
  // Sends ride `turnTrigger.trigger` (the trigger-only contract, ADR-0264) —
  // the runtime seam carries only what the direct methods actually call.
  runtime: {
    approveTool(
      sessionId: string,
      toolCallId: string,
      approved: boolean,
      options?: { alwaysAllow?: boolean; denyReason?: string }
    ): boolean;
    submitAnswers(sessionId: string, toolCallId: string, answers: Record<string, string>): boolean;
    updateSession(
      sessionId: string,
      opts: SessionSettings
    ): SessionUpdateResult | Promise<SessionUpdateResult>;
    getCapabilities(): RuntimeCapabilities;
    /**
     * Available models reported by the SDK (AgentRuntime contract). Same source
     * as the server's `/api/models` route, so the catalog derives identically on
     * every transport instead of from a hand-maintained list.
     */
    getSupportedModels(): Promise<ModelOption[]>;
    /** Available subagents reported by the SDK (AgentRuntime contract). */
    getSupportedSubagents(): Promise<SubagentInfo[]>;
    /**
     * Optional plugin-reload bridge. Runtimes that advertise
     * `capabilities.supportsPlugins: true` should expose this so
     * `DirectTransport.asClaudePluginTransport(sessionId)` can route plugin
     * reloads to the embedded runtime. Returns `null` when no SDK query is
     * available for the session (e.g. no message has been sent yet).
     *
     * @param sessionId - Session whose plugins should be reloaded
     */
    reloadPlugins?(sessionId: string): Promise<ReloadPluginsResult | null>;
    /**
     * Resolve a session's own working directory from its id alone, using
     * whatever LIVE binding the embedded runtime already holds for it
     * (AgentRuntime contract, DOR-1322). Optional and best-effort: absent or
     * `undefined` means "no such binding" — a cold session, or a runtime with
     * no per-session cwd — not "the session doesn't exist." Mirrors the HTTP
     * transport's server-side `getSessionCwd`, so `getMessages` can resolve a
     * session without a caller-supplied `cwd` here too.
     *
     * @param sessionId - Session to resolve
     */
    getSessionCwd?(sessionId: string): string | undefined;
    /** The authoritative session snapshot for hydration (AgentRuntime contract). */
    getSessionSnapshot(ctx: SessionOpts, sessionId: string): Promise<SessionSnapshot>;
    /** The session's monotonically-seq'd event stream (AgentRuntime contract). */
    subscribeSession(
      ctx: SessionOpts,
      sessionId: string,
      sinceCursor?: number,
      signal?: AbortSignal
    ): AsyncIterable<SessionEvent>;
    /** Discovery + liveness across all observable sessions (AgentRuntime contract). */
    subscribeSessionList(ctx: SessionOpts): AsyncIterable<SessionListEvent>;
  };
  /**
   * In-process trigger bridge for the trigger-only send contract (ADR-0264).
   * The embedding host wires `createEmbeddedTurnTrigger(runtime, feedProjector)`
   * from `@dorkos/server/services/session` here, so `postMessage` starts a
   * detached turn that feeds the session projector — delivery then flows over
   * `subscribeSession`, exactly like the HTTP route.
   */
  turnTrigger: {
    trigger(opts: {
      sessionId: string;
      clientId: string;
      content: string;
      cwd?: string;
      context?: ClientContext;
      /** Background the caller attached to the turn — read by the agent, never rendered. */
      seedContext?: string;
    }): Promise<{ accepted: boolean; canonicalId?: string }>;
  };
  /**
   * In-process trigger bridge for a RUNTIME-fulfilled command intent (currently
   * `compact`), the command-intent twin of {@link turnTrigger} (DOR-109,
   * ADR-0264). The embedding host wires
   * `createEmbeddedCommandIntentTrigger(runtime)` from
   * `@dorkos/server/services/session` here, so `runCommandIntent` drives a
   * detached run feeding the session projector — delivery then flows over
   * `subscribeSession` (e.g. a `compact_boundary`), exactly like the HTTP route.
   * Resolves with the lock outcome. There is no canonical id to await, but the
   * run does wait its turn: an intent shares the session's single writer with
   * every turn, so it queues behind this client's in-flight work rather than
   * taking the lock beside it (DOR-1088).
   */
  commandIntentTrigger: {
    trigger(opts: {
      sessionId: string;
      clientId: string;
      intent: RuntimeCommandIntentId;
      cwd?: string;
      /** Trailing instructions after the intent token (see `Transport.runCommandIntent`). */
      instructions?: string;
    }): Promise<{ accepted: boolean }>;
  };
  /**
   * Every prompt the embedded fleet is parked on, read straight out of the
   * in-process projector registry.
   *
   * Required rather than optional, and that is the point: the embed implements
   * all six ways of ANSWERING a prompt for real, so a listing that quietly
   * answered "nothing is waiting" would be the one half-working half — a person
   * in Obsidian would only ever find a prompt by opening the session that raised
   * it, which is the hunting this whole feature removes. The host wires
   * `listPendingInteractionsAcrossSessions` from `@dorkos/server/services/session`.
   *
   * Room bindings are deliberately absent: the embed has no rooms, so no
   * envelope it produces carries a `roomId`.
   */
  pendingInteractions: {
    list(): Array<{ sessionId: string; cwd: string; interaction: PendingInteractionDTO }>;
  };
  /**
   * The message index, read in this process (DOR-691).
   *
   * A host wires `createEmbeddedSearch({ db, rooms })` from the server's search
   * domain, which resolves the operator's scope through the same rooms domain
   * and the same owner check `GET /api/search` uses. The seam hands back the
   * route's decision as data — the envelope, or the refusal — and
   * `direct/search-methods.ts` raises the refusal the way an HTTP one arrives.
   *
   * **Optional, because a host can be running where there is no index to open.**
   * The Obsidian plugin wires it whenever this machine has one (DOR-1563), and
   * leaves it out when it does not — a DorkOS that has never run, a database
   * older than message search, an Obsidian whose Electron the plugin carries no
   * SQLite build for. An absent seam makes `search` REJECT with a plain sentence
   * — never `{ results: [], warnings: [] }`, which would tell somebody their
   * history holds no mention of a word they know they wrote.
   */
  search?: {
    search(query: SearchQuery): SearchAnswer | Promise<SearchAnswer>;
  };
  transcriptReader: {
    listSessions(vaultRoot: string): Promise<Session[]>;
    getSession(vaultRoot: string, id: string): Promise<Session | null>;
    readTranscript(vaultRoot: string, id: string): Promise<HistoryMessage[]>;
    readTasks(vaultRoot: string, id: string): Promise<TaskItem[]>;
  };
  commandRegistry: {
    getCommands(forceRefresh?: boolean): Promise<CommandRegistry>;
  };
  fileLister?: {
    listFiles(cwd: string): Promise<{ files: string[]; truncated: boolean; total: number }>;
  };
  gitStatus?: {
    getGitStatus(cwd: string): Promise<GitStatusResponse | GitStatusError>;
  };
  /**
   * Optional diff-baseline bridge (DOR-212). The embedding host wires the
   * server's `services/diff` domain here so the in-process transport resolves the
   * per-session pre-edit snapshot base (the same singleton the embedded runtime
   * captures into). When absent, {@link import('./system-methods').createDirectSystemMethods}
   * falls back to a git-HEAD/empty base computed in-process — the documented
   * fallback ladder — so text diff still works, just without session-snapshot
   * fidelity.
   */
  diffBaseline?: {
    readDiffBaseline(
      cwd: string,
      filePath: string,
      sessionId: string,
      mode: 'session' | 'head'
    ): Promise<DiffBaselineResponse>;
    advanceDiffBaseline(cwd: string, filePath: string, sessionId: string): Promise<void>;
  };
  vaultRoot: string;
}
