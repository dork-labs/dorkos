/**
 * Service seams for the Direct (in-process) Transport.
 *
 * The embedding host (Obsidian plugin) wires concrete server services into
 * this interface so {@link import('../direct-transport').DirectTransport}
 * can satisfy the Transport contract without HTTP.
 *
 * @module shared/lib/direct/services
 */
import type { RuntimeCapabilities, SessionOpts } from '@dorkos/shared/agent-runtime';
import type { ClientContext } from '@dorkos/shared/additional-context';
import type {
  SessionSnapshot,
  SessionEvent,
  SessionListEvent,
} from '@dorkos/shared/session-stream';
import type {
  Session,
  PermissionMode,
  HistoryMessage,
  CommandRegistry,
  TaskItem,
  GitStatusResponse,
  GitStatusError,
  ReloadPluginsResult,
  ModelOption,
  SubagentInfo,
} from '@dorkos/shared/types';

export interface DirectTransportServices {
  // Sends ride `turnTrigger.trigger` (the trigger-only contract, ADR-0264) —
  // the runtime seam carries only what the direct methods actually call.
  runtime: {
    approveTool(
      sessionId: string,
      toolCallId: string,
      approved: boolean,
      alwaysAllow?: boolean
    ): boolean;
    submitAnswers(sessionId: string, toolCallId: string, answers: Record<string, string>): boolean;
    updateSession(
      sessionId: string,
      opts: { permissionMode?: PermissionMode; model?: string }
    ): boolean | Promise<boolean>;
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
    }): Promise<{ accepted: boolean; canonicalId?: string }>;
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
  vaultRoot: string;
}
