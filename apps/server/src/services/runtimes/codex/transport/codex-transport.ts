/**
 * The seam between `CodexRuntime` and the way it talks to Codex (spec
 * `codex-app-server-transport` §3, ADR 261005-113107).
 *
 * Everything above "run one resolved turn" stays in the runtime: settings, the
 * cwd chain, who pays (and the refusal when credits cannot), the model swap,
 * the connector binding and its lease, the identity token, the managed MCP
 * servers, the context gate, prompt assembly, registry and `codex_threads`
 * writes, and media capture. A transport receives one {@link CodexTurnRequest}
 * with all of that already decided and turns it into StreamEvents.
 *
 * Two implementations: `exec` (one `codex exec` per turn through the SDK, the
 * code that shipped before this seam, moved unchanged) and `app-server` (one
 * long-lived `codex app-server` per home).
 *
 * @module services/runtimes/codex/transport/codex-transport
 */
import type { InterruptReceipt, SessionSettings, StreamEvent } from '@dorkos/shared/types';
import type {
  DeliverIntoTurnOpts,
  RuntimeCapabilities,
  RuntimeDeliveryResult,
  SessionWarmth,
} from '@dorkos/shared/agent-runtime';
import type { CreditsLaunch } from '../../../core/cloud/credits-protocols.js';
import type { DorkosMcpInjection } from '../../shared/dorkos-mcp-injection.js';
import type { ConnectorRuntimeMcpInjection } from '../../connector-tools.js';
import type { CodexManagedMcpServers } from '../mcp-server-config.js';
import type { CodexEventContext } from '../event-mapper.js';
import type { BackgroundWake } from '../app-server/background-work.js';

/** Which Codex home pays for a turn. */
export type CodexLaunch = { home: 'person' } | { home: 'credits'; credits: CreditsLaunch };

/** The tools one turn carries, resolved by the runtime. */
export interface CodexTurnTools {
  /** The agent identity token's environment fragment; `{}` when unattributed. */
  readonly agentTokenEnv: Record<string, string>;
  /**
   * Mint the identity token on demand instead (app-server): called only when a
   * thread actually loads, since a loaded thread keeps the token it loaded
   * with. Absent when the turn is unattributed.
   */
  readonly mintAgentToken?: () => Promise<Record<string, string>>;
  /** The agent's enabled managed MCP servers, in Codex config shape. */
  readonly managed: CodexManagedMcpServers;
  /** The `dorkos` tool server carrying this turn's bearer, or `null`. */
  readonly dorkosTools: DorkosMcpInjection | null;
  /** The connector server carrying this turn's bearer, or `null`. */
  readonly connectorTools: ConnectorRuntimeMcpInjection | null;
  /**
   * The open turn's connector binding, when one was opened. The app-server
   * transport attaches it to the thread key for exactly this turn.
   */
  readonly connectorBindingId?: string;
}

/** One resolved Codex turn, transport-neutral. */
export interface CodexTurnRequest {
  /** The `codex` binary this turn runs (resolved by the runtime's ladder). */
  readonly binary: string;
  /** DorkOS session id. */
  readonly sessionId: string;
  /** The thread bound to the session, or `undefined` for a first turn. */
  readonly boundThreadId: string | undefined;
  /** Working directory of the turn. */
  readonly cwd: string;
  /** Mode, model and effort for the turn. */
  readonly settings: SessionSettings;
  /** Validated write grants (folders Codex may write besides the project). */
  readonly writableDirectories: readonly string[];
  /** The prompt `buildCodexPrompt` assembled, unchanged. */
  readonly prompt: string;
  /** The `clientUserMessageId` Codex echoes on the user message, when known. */
  readonly messageId?: string;
  /** Who pays. */
  readonly launch: CodexLaunch;
  /** The tools the runtime resolved for this turn. */
  readonly tools: CodexTurnTools;
  /** The turn's controller: aborting it stops the turn. */
  readonly signal: AbortSignal;
  /** The turn's mapping context (thread id, media state, usage reader). */
  readonly events: CodexEventContext;
  /**
   * Persist the session ↔ thread binding. `replaces` names a bound thread the
   * transport found could not continue (spec §6), so the binding is replaced
   * rather than first-write-wins.
   */
  onThreadBound(threadId: string, replaces?: string): void;
  /**
   * The turn's own options, opaque to the transport: kept on any work the turn
   * leaves running and handed back with its wake, so the turn a wake starts
   * runs as the same agent with the same settings. Absent means a wake from
   * this turn's work must not start a model turn.
   */
  readonly wakeContext?: unknown;
}

/**
 * One resolved compaction: summarize the session's thread so it has room
 * again (a person's `/compact`, or the agent's own request). The runtime has
 * already decided who pays; nothing else of a turn's is needed, because a
 * compaction sends no prompt and runs no tools.
 */
export type CodexCompactRequest = Pick<
  CodexTurnRequest,
  | 'binary'
  | 'sessionId'
  | 'boundThreadId'
  | 'cwd'
  | 'settings'
  | 'launch'
  | 'signal'
  | 'events'
  | 'onThreadBound'
>;

/** How one transport talks to Codex. */
export interface CodexTransport {
  /** Which transport this is. */
  readonly kind: 'exec' | 'app-server';
  /** Capability overrides merged over the shared Codex base. */
  readonly capabilities: Partial<RuntimeCapabilities>;
  /** Run one turn. Ends with exactly one terminal `done` on every path. */
  runTurn(request: CodexTurnRequest): AsyncGenerator<StreamEvent>;
  /**
   * Summarize the session's thread. Ends with exactly one terminal `done`;
   * a success carries a `compact_boundary`, a failure a `failed` compaction
   * progress. Absent on a transport with no way to ask Codex for one (exec:
   * `codex exec` only runs prompts).
   */
  compact?(request: CodexCompactRequest): AsyncGenerator<StreamEvent>;
  /**
   * Stop the session's open turn and say what happened. Called by the runtime
   * after it aborted the turn's controller.
   */
  interrupt(sessionId: string): Promise<InterruptReceipt>;
  /**
   * Answer an approval card Codex is waiting on. `false` when nothing
   * approvable is pending under that id. Absent on a transport that cannot ask.
   */
  answerApproval?(
    sessionId: string,
    interactionId: string,
    approved: boolean,
    alwaysAllow?: boolean
  ): boolean;
  /** Answer a question card (canonical index-keyed answers). */
  answerQuestion?(
    sessionId: string,
    interactionId: string,
    answers: Record<string, string>
  ): boolean;
  /** Answer an elicitation card. */
  answerElicitation?(
    sessionId: string,
    interactionId: string,
    action: 'accept' | 'decline' | 'cancel',
    content?: Record<string, unknown>
  ): boolean;
  /**
   * Deliver a message into the session's open turn without opening one.
   * Absent on a transport with no mid-turn input.
   */
  deliverIntoTurn?(
    sessionId: string,
    content: string,
    opts: DeliverIntoTurnOpts
  ): Promise<RuntimeDeliveryResult>;
  /** How warm the session's backing process is (persistent transports only). */
  getSessionWarmth?(sessionId: string): SessionWarmth;
  /** Give back the session's warm thread (persistent transports only). */
  reapSession?(sessionId: string): Promise<void>;
  /**
   * Stop one background task. Absent on a transport whose work ends with its
   * turn (exec).
   */
  stopTask?(sessionId: string, taskId: string): Promise<InterruptReceipt>;
  /**
   * Install where wakes go: background work that finished after its turn
   * (spec §12). Absent on a transport whose work ends with its turn.
   */
  onWake?(listener: ((wake: BackgroundWake) => boolean) | undefined): void;
  /** Whether a wake is on its way for the session (bounded). */
  isSegmentPending?(sessionId: string): boolean;
  /** Be told when a pending wake was dropped without opening a turn. */
  onDispatchGateChange?(listener: (sessionId: string) => void): () => void;
  /** Whether the session still holds work that can wake it after its turn. */
  holdsBackgroundWork?(sessionId: string): boolean;
  /** Whether the open turn has helper agents working (inside the ceiling). */
  isHelperWorking?(sessionId: string): boolean;
  /**
   * The sessions with anything live: an open turn, background work, a loaded
   * thread. Absent on a transport whose work ends with its turn (exec).
   */
  liveSessionIds?(): string[];
  /**
   * End a session (a pause): stop its background work and give back what it
   * holds. `true` when anything was running. Absent on exec.
   */
  endSession?(sessionId: string): Promise<boolean>;
  /** Stop the credits-home process, if this transport keeps one (an unlink). */
  closeCreditsProcess?(): Promise<void>;
  /** Stop everything this transport started. */
  shutdown(): Promise<void>;
}
