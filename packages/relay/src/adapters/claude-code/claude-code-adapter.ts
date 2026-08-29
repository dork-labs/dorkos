/**
 * The built-in adapter that bridges the Relay bus to this machine's agent
 * runtimes.
 *
 * Routes messages between the Relay bus and agent sessions, delegating agent
 * message handling and tasks execution to focused sub-modules. Runtime-level
 * concerns (per-session serial queueing, open/stream/close lifecycle) are
 * delegated to `ClaudeCodeRuntimeAdapter`, a subclass of the shared
 * `RuntimeAdapter` base.
 *
 * ## It drives every runtime, not just Claude Code (DOR-1614)
 *
 * The name is historical and deliberately kept: `claude-code` is the id of the
 * built-in entry in every install's `adapters.json`, so renaming the class
 * would leave a class and a persisted config type disagreeing about the same
 * thing. What it does is broader than the name. Everything below the adapter —
 * `agent-handler.ts`, `task-handler.ts`, `approval-handler.ts` — speaks only
 * `AgentRuntimeLike` and `StreamEvent`, so none of it is Claude-shaped; the one
 * Claude-specific thing left was the single runtime the host injected. So the
 * adapter now holds a runtime-type → runtime MAP and picks per message, rather
 * than growing a Codex subclass and an OpenCode subclass that would have
 * inherited every line of the same behaviour.
 *
 * Which runtime answers is taken from what the message itself names — never
 * guessed:
 *
 * - `relay.agent.<runtimeType>.<sessionId>` — the runtime segment, which
 *   `BindingRouter` resolves from the session's own ownership row.
 * - `relay.system.tasks.<taskId>` — the dispatch payload's `runtime` field.
 * - anything that names none (a legacy three-token subject, a task dispatch
 *   from before the field existed) — the host's default runtime, which is the
 *   single runtime every host used to pass.
 *
 * A message naming a runtime this build did not register is REFUSED with a
 * message saying so, never quietly run on another one: a codex session answered
 * by Claude Code is a wrong answer wearing the right agent's name.
 *
 * @module relay/adapters/claude-code-adapter
 */

/**
 * ID GLOSSARY — three distinct IDs used in the relay pipeline:
 *
 * @example
 * agentId      — Mesh ULID (e.g., '01JN4M2X5SZMHXP3EZFM9DWRXFK')
 *                Stable across server restarts. Extracted from relay.agent.{agentId} subjects.
 *                Use this for relay_send subjects and mesh_inspect calls.
 *
 * sdkSessionId — SDK UUID (e.g., '550e8400-e29b-41d4-a716-446655440000')
 *                Assigned by Claude Agent SDK on first message. Maps to JSONL transcript file.
 *                Changes on each full session reset; persisted by AgentSessionStore.
 *
 * ccaSessionKey — CCA's internal lookup key for AgentManager
 *                 = sdkSessionId (from AgentSessionStore) if a prior mapping exists
 *                 = agentId (Mesh ULID) on first-ever message to this agent
 */
import type { RelayEnvelope, AdapterManifest } from '@dorkos/shared/relay-schemas';
import { TASK_DISPATCH_SUBJECT_PREFIX, isTaskDispatchSubject } from '@dorkos/shared/relay-schemas';
import type {
  RelayAdapter,
  RelayPublisher,
  AdapterStatus,
  AdapterContext,
  DeliveryResult,
} from '../../types.js';
import { handleAgentMessage } from './agent-handler.js';
import { handleTasksMessage } from './task-handler.js';
import { ClaudeCodeRuntimeAdapter } from './claude-code-runtime-adapter.js';
import { subscribeApprovalHandler } from './approval-handler.js';
import { subscribeTaskCancelHandler } from './task-cancel-handler.js';
import { subscribeAgentCancelHandler } from './agent-cancel-handler.js';
import { AbortRegistry } from '../../lib/abort-registry.js';
import {
  AGENT_SUBJECT_PREFIX,
  RUNTIME_TYPES,
  extractSessionIdFromSubject,
  parseAgentSubject,
} from '../../lib/subjects.js';
import { CapacityHold, type SlotOutcome } from './capacity-hold.js';
import type {
  AgentRuntimeLike,
  ClaudeCodeAdapterConfig,
  ClaudeCodeAdapterDeps,
  ResolvedConfig,
} from './types.js';

// Re-export all public types from the shared types module
export type {
  ClaudeCodeAdapterConfig,
  ClaudeCodeAdapterDeps,
  AgentRuntimeLike,
  AgentSessionStoreLike,
  TasksStoreLike,
} from './types.js';

// Re-export TraceStoreLike for backward compatibility
export type { TraceStoreLike } from '../../types.js';

// === Manifest ===

/** Static adapter manifest for the Claude Code built-in adapter. */
export const CLAUDE_CODE_MANIFEST: AdapterManifest = {
  type: 'claude-code',
  displayName: 'Claude Code',
  description: 'Routes messages to Claude Agent SDK sessions. Auto-configured.',
  iconId: 'claude-code',
  category: 'internal',
  builtin: true,
  multiInstance: false,
  configFields: [
    {
      key: 'maxConcurrent',
      label: 'Max Concurrent Sessions',
      type: 'number',
      required: false,
      default: 3,
      description: 'Maximum number of concurrent agent sessions.',
    },
    {
      key: 'defaultTimeoutMs',
      label: 'Default Timeout (ms)',
      type: 'number',
      required: false,
      default: 300000,
      description: 'Default timeout for agent sessions in milliseconds.',
    },
  ],
};

// === Constants ===

/**
 * The runtime-scoped subject prefix one runtime's sessions arrive on.
 *
 * Matches subjects produced by `BindingRouter` when the runtime resolver is
 * wired (`relay.agent.<runtimeType>.<sessionId>`). Claimed once per registered
 * runtime, so that in a multi-adapter configuration these specific prefixes beat
 * the broader `relay.agent.` catch-all: `AdapterRegistry` resolves a subject to
 * the LONGEST matching claim, and the order claims are listed in plays no part.
 * (They are still written before the catch-all below, for reading, not routing.)
 *
 * @param runtimeType - The runtime whose sessions this prefix covers.
 */
function runtimeScopedAgentPrefix(runtimeType: string): string {
  return `${AGENT_SUBJECT_PREFIX}${runtimeType}.`;
}

/**
 * Legacy subject prefix for agent-bound messages.
 *
 * Matches subjects produced by `BindingRouter` when no runtime resolver is
 * configured or when resolution fails — the three-part shape
 * `relay.agent.<sessionId>`. Also matches direct agent-to-agent relay sends
 * addressed by mesh agentId, which historically share the same prefix.
 * Retained so legacy / fallback routing keeps working; downstream parsing
 * uses `parseAgentSubject` to extract the sessionId from either shape.
 */
const AGENT_SUBJECT_PREFIX_LEGACY = 'relay.agent.';

/**
 * What the adapter reports when it never got a slot.
 *
 * Every one of these is a real failure the delivery pipeline dead-letters. Only
 * the two capacity outcomes carry `at_capacity`: a stop is not the runtime being
 * busy, and reporting it as one would put "the agent was busy" in a chat whose
 * server was shutting down.
 *
 * @param outcome - How the slot request ended. `'acquired'` never reaches here.
 * @param config - The resolved adapter config, for the numbers in the message.
 * @param durationMs - How long the caller spent, including any wait.
 * @param ceilingMs - The hold ceiling that actually applied to this delivery:
 *   the shorter of the adapter's own and what was left of the envelope's TTL.
 */
function slotRefusal(
  outcome: Exclude<SlotOutcome, 'acquired'>,
  config: ResolvedConfig,
  durationMs: number,
  ceilingMs: number
): DeliveryResult {
  switch (outcome) {
    case 'line_full':
      return {
        success: false,
        // The code, not the prose, is what downstream reacts to: the chat
        // notice for a busy runtime must not hinge on this sentence's wording.
        code: 'at_capacity',
        // Covers all three reasons a delivery took no slot and did not wait:
        // the line was full, nobody licensed it to wait, or its own TTL was
        // already spent. All of them are this sentence.
        error: `Adapter at capacity (${config.maxConcurrent} concurrent sessions) and this message could not wait`,
        durationMs,
      };
    case 'held_too_long':
      return {
        success: false,
        code: 'at_capacity',
        // The ceiling that actually applied, which is the message's own
        // remaining TTL whenever that was shorter than the adapter's — quoting
        // `defaultTimeoutMs` here reported a wait that never happened.
        error: `Waited up to ${ceilingMs}ms for a free session slot and none came free`,
        durationMs,
      };
    case 'stopped':
      return {
        success: false,
        error: 'Adapter stopped while this message was waiting for a free session slot',
        durationMs,
      };
  }
}

/**
 * The runtime a TASK DISPATCH names, read off the raw payload.
 *
 * Read here rather than after `TaskDispatchPayloadSchema` parses, because the
 * runtime has to be chosen before {@link handleTasksMessage} is called at all —
 * that function takes the runtime it drives as a dependency. A payload that
 * names nothing (every dispatch written before the field existed, and every one
 * the scheduler has not resolved a per-task runtime for) yields `undefined`,
 * which means "the host's default runtime".
 *
 * Deliberately tolerant: a malformed payload is not this function's to reject —
 * the schema parse inside the handler is where a dispatch is refused, and
 * answering `undefined` here sends it there with a proper error rather than
 * turning it into a runtime complaint.
 *
 * @param payload - The dispatch envelope's payload, exactly as it arrived.
 */
function dispatchRuntimeType(payload: unknown): string | undefined {
  if (payload === null || typeof payload !== 'object') return undefined;
  const runtime = (payload as { runtime?: unknown }).runtime;
  return typeof runtime === 'string' && runtime.length > 0 ? runtime : undefined;
}

// === ClaudeCodeAdapter ===

/**
 * Runtime adapter that bridges Relay messages to Claude Code Agent SDK sessions.
 *
 * Handles agent-directed messages (`relay.agent.>`) and Tasks scheduler
 * dispatch (`relay.system.tasks.>`). Enforces a concurrency ceiling — one an
 * agent message **waits** on rather than being refused by (`capacity-hold.ts`)
 * — TTL budget timeouts, and records trace spans through the delivery lifecycle.
 *
 * Three control signals arrive by SUBSCRIPTION rather than delivery — tool
 * approvals, run stop requests and turn stop requests — because each must reach
 * work that is already holding one of those concurrency slots, or waiting for
 * one.
 */
export class ClaudeCodeAdapter implements RelayAdapter {
  readonly id: string;
  /**
   * What reaches this adapter — deliberately wider than what it will run.
   *
   * One runtime-scoped entry per registered runtime, then the legacy catch-all,
   * then tasks. A claim is a PREFIX, so the tasks entry also catches every
   * subject beneath a dispatch subject. Only `relay.system.tasks.<taskId>`
   * exactly is a dispatch ({@link isTaskDispatchSubject}); anything deeper is
   * skipped in {@link ClaudeCodeAdapter.deliver} rather than parsed as one.
   */
  readonly subjectPrefix: readonly string[];
  readonly displayName = 'Claude Code';

  /**
   * Whether delivering this subject makes this adapter run a real, paid turn
   * (DOR-791).
   *
   * The publish pipeline's hourly turn ceiling asks this at the dispatch,
   * because the dispatch is the only place that knows the answer. Deciding it
   * from the subject upstream is how the ceiling first shipped, and it missed
   * `relay.system.tasks.*` entirely: this adapter answers for that prefix too
   * and routes it to `ensureSession` + `sendMessage`, so scheduled runs — and
   * anything `relay_send` addressed there, since only endpoint REGISTRATION is
   * reserved — cost money nothing counted.
   *
   * The one "no" is the subject beneath a dispatch subject, which
   * {@link ClaudeCodeAdapter.deliver} skips rather than runs. Answering
   * truthfully here means the ceiling never charges for it, instead of charging
   * and refunding a moment later.
   *
   * @param subject - The subject about to be delivered.
   */
  startsAgentTurns(subject: string): boolean {
    if (subject.startsWith(TASK_DISPATCH_SUBJECT_PREFIX)) return isTaskDispatchSubject(subject);
    return true;
  }

  private readonly config: ResolvedConfig;
  private readonly deps: ClaudeCodeAdapterDeps;
  /**
   * Every runtime this adapter may drive, keyed by runtime type, with the
   * host's default runtime always present under its own `type`.
   *
   * Normalized once here rather than merged at every lookup: a host that passed
   * only `agentManager` (most tests, and every host before DOR-1614) gets a
   * one-entry map and behaves exactly as it did, and a host that passed a map
   * cannot accidentally leave its own default runtime out of it.
   */
  private readonly agentRuntimes: ReadonlyMap<string, AgentRuntimeLike>;
  /**
   * The discriminator {@link parseAgentSubject} tests slot 3 against: every
   * runtime type this adapter could plausibly be ADDRESSED about.
   *
   * The union of two sets, because the two failures it prevents are opposite
   * ones:
   *
   * - **The keys this adapter holds**, so a runtime registered under a type the
   *   built-in literal list has never heard of still routes to itself. Its
   *   prefix is claimed from this same expression, so claimed and readable are
   *   one set by construction.
   * - **{@link RUNTIME_TYPES}**, so a type the product knows exists but this
   *   build did not register — `opencode` where the SDK failed to construct — is
   *   still read as a runtime and REFUSED by name. Without it such a subject
   *   reads as a mesh namespace and takes the default runtime silently, which is
   *   the wrong program answering under the right agent's name.
   *
   * Anything in neither set is a mesh namespace and names no runtime, exactly as
   * before.
   */
  private readonly addressableRuntimeTypes: ReadonlySet<string>;
  /** The runtime type a message that names none runs on. */
  private readonly defaultRuntimeType: string;
  private relay: RelayPublisher | null = null;
  /**
   * The concurrency ceiling, and the line of deliveries waiting on it.
   *
   * A message that arrives with every slot taken **waits** rather than being
   * turned away (ADR `260819-034718`, following `260818-234541`'s shape for
   * rooms). See
   * `capacity-hold.ts` for what makes that promise keepable.
   */
  private readonly capacity: CapacityHold;
  /**
   * Runtime-level adapter — owns per-session serial queueing and the
   * abstract open/stream/close lifecycle. The relay-level class delegates
   * queue management to this instance so `RuntimeAdapter`'s shared
   * `enqueueForSession` replaces the former standalone `AgentQueue`.
   */
  private readonly runtimeAdapter: ClaudeCodeRuntimeAdapter;
  /** Unsubscribe function for the `relay.system.approval.>` subscription. */
  private approvalUnsub: (() => void) | null = null;
  /** Unsubscribe function for the run stop-request subscription (DOR-808). */
  private taskCancelUnsub: (() => void) | null = null;
  /** Unsubscribe function for the turn stop-request subscription (DOR-791). */
  private agentCancelUnsub: (() => void) | null = null;
  /** The task runs this adapter is executing, so a stop can reach them. */
  private readonly runningTasks = new AbortRegistry();
  /** The agent turns this adapter is executing, so a cancel can reach them. */
  private readonly runningTurns = new AbortRegistry();
  private status: AdapterStatus = {
    state: 'disconnected',
    messageCount: { inbound: 0, outbound: 0 },
    errorCount: 0,
  };

  /**
   * Create a Claude Code relay adapter.
   *
   * @param id - Unique adapter identifier (e.g., 'claude-code')
   * @param config - Adapter configuration (concurrency, timeout, default cwd)
   * @param deps - Injected dependencies (agentManager, traceStore, taskStore)
   */
  constructor(id: string, config: ClaudeCodeAdapterConfig, deps: ClaudeCodeAdapterDeps) {
    this.id = id;
    // The default runtime's own `type` when it declares one. Bare test doubles
    // declare none, and `'claude-code'` is what they have always meant — the
    // same reading `AdapterManager` gives a runtime with no type.
    this.defaultRuntimeType = deps.agentManager.type ?? 'claude-code';
    const runtimes = new Map(deps.agentRuntimes ?? []);
    // The host's default runtime is authoritative for its own type: a map that
    // omitted it (or held a second instance under the same key) would route
    // this adapter's own turns somewhere the host did not choose.
    runtimes.set(this.defaultRuntimeType, deps.agentManager);
    this.agentRuntimes = runtimes;
    this.addressableRuntimeTypes = new Set([...runtimes.keys(), ...RUNTIME_TYPES]);
    // Claimed from the map alone, never the union: claiming
    // `relay.agent.opencode.` on a build with no opencode would take those
    // subjects away from an adapter that could actually serve them. They still
    // reach this adapter — and get refused by name — through the `relay.agent.`
    // catch-all below.
    this.subjectPrefix = [
      ...[...runtimes.keys()].map(runtimeScopedAgentPrefix),
      AGENT_SUBJECT_PREFIX_LEGACY,
      TASK_DISPATCH_SUBJECT_PREFIX,
    ];
    this.config = {
      maxConcurrent: config.maxConcurrent ?? 3,
      defaultTimeoutMs: config.defaultTimeoutMs ?? 300_000,
      defaultCwd: config.defaultCwd ?? process.cwd(),
    };
    this.deps = deps;
    this.capacity = new CapacityHold({
      maxConcurrent: this.config.maxConcurrent,
      // NOT the ceiling on the turn that is in the way: that turn runs to its
      // own envelope's TTL (an hour by default), so a hold can expire while the
      // agent is still legitimately busy. This is the longest we are willing to
      // hold a person's message without an answer, reusing the only duration
      // this adapter already has rather than inventing a setting.
      holdCeilingMs: this.config.defaultTimeoutMs,
    });
    // Held for its per-session serial queue and nothing else — this class
    // bypasses `streamMessage` and drives the resolved runtime directly, so the
    // runtime handed over here is never the one a turn runs on. The queue is
    // keyed by session id, which is unique across runtimes, so one instance
    // serializes correctly for all of them.
    this.runtimeAdapter = new ClaudeCodeRuntimeAdapter(
      { runtimeType: this.defaultRuntimeType, ...(deps.logger ? { logger: deps.logger } : {}) },
      deps.agentManager
    );
  }

  /**
   * Start the adapter — store relay publisher and mark as connected.
   *
   * @param relay - The RelayPublisher used to publish response events
   */
  async start(relay: RelayPublisher): Promise<void> {
    this.relay = relay;
    this.approvalUnsub = subscribeApprovalHandler(
      relay,
      // Default runtime first, so a single-runtime host's call order is exactly
      // what it was. See {@link handleApprovalResponse} for why every runtime
      // is offered the decision rather than one being resolved.
      [
        this.deps.agentManager,
        ...[...this.agentRuntimes.values()].filter((r) => r !== this.deps.agentManager),
      ],
      this.deps.logger ?? console,
      this.deps.approvalAuthorizer
    );
    this.taskCancelUnsub = subscribeTaskCancelHandler(
      relay,
      this.runningTasks,
      this.deps.logger ?? console
    );
    this.agentCancelUnsub = subscribeAgentCancelHandler(
      relay,
      this.runningTurns,
      this.deps.logger ?? console
    );
    this.status = {
      state: 'connected',
      messageCount: { inbound: 0, outbound: 0 },
      errorCount: 0,
      startedAt: new Date().toISOString(),
    };
  }

  /**
   * Stop the adapter — clear relay reference, drain in-flight queue entries, and mark as disconnected.
   */
  async stop(): Promise<void> {
    // Unsubscribe from approval responses before clearing relay reference
    this.approvalUnsub?.();
    this.approvalUnsub = null;
    this.taskCancelUnsub?.();
    this.taskCancelUnsub = null;
    this.agentCancelUnsub?.();
    this.agentCancelUnsub = null;
    // The runs themselves are finalized by their own handlers; only the
    // registry is torn down here, so a stop request arriving after a restart
    // is answered with the truth instead of aborting a stranger's run.
    this.runningTasks.clear();
    this.runningTurns.clear();
    // A hold is a promise that a turn will run, and this adapter is about to
    // stop being able to keep it. Every waiter settles now, as a failed
    // delivery, so an ADAPTER restart tells the chats that were waiting. On a
    // whole-server stop the bus and the chat adapters are already down by the
    // time this runs, and the message is simply dropped.
    this.capacity.drain();
    this.relay = null;
    this.runtimeAdapter.reset();
    this.status = { ...this.status, state: 'disconnected' };
  }

  /**
   * The runtime type one inbound message NAMES, or `undefined` when it names
   * none.
   *
   * Two vocabularies, because the two subject families carry the answer
   * differently: an agent subject carries it in the subject itself (the segment
   * `BindingRouter` fills from the session's ownership row), and a task
   * dispatch carries it in the payload (there is one dispatch subject shape and
   * it has nowhere to put a runtime).
   *
   * A three-token legacy subject and an agent-scoped mesh subject
   * (`relay.agent.<namespace>.<agentId>`, a direct agent-to-agent send) both
   * name none. That is honest rather than a gap: neither shape has ever carried
   * a runtime, and the host's default is what ran them before this existed.
   *
   * The parse is told {@link ClaudeCodeAdapter.addressableRuntimeTypes} rather
   * than left on the built-in literal list. On the literal list, a runtime
   * registered under a type outside it — `test-mode-b` under
   * `DORKOS_TEST_RUNTIME`, or any runtime added without editing that list — had
   * its prefix claimed here and its subject read as a mesh namespace, so the
   * turn ran silently on the default runtime.
   *
   * @param subject - The subject the message arrived on.
   * @param envelope - The envelope, for a task dispatch's payload.
   */
  private namedRuntimeType(subject: string, envelope: RelayEnvelope): string | undefined {
    if (isTaskDispatchSubject(subject)) return dispatchRuntimeType(envelope.payload);
    return parseAgentSubject(subject, this.addressableRuntimeTypes)?.runtimeType;
  }

  /**
   * The runtime that answers this message, or a refusal saying why not.
   *
   * The refusal is the point: a session bound to a runtime this build did not
   * register must not be answered by a different one. Silently substituting the
   * default would put a Claude Code answer in a Codex agent's chat, under that
   * agent's name, with nothing anywhere saying the wrong program ran it.
   *
   * @param subject - The subject the message arrived on.
   * @param envelope - The envelope, for a task dispatch's payload.
   */
  private resolveRuntime(
    subject: string,
    envelope: RelayEnvelope
  ): { runtime: AgentRuntimeLike; runtimeType: string } | { error: string } {
    const named = this.namedRuntimeType(subject, envelope);
    const runtimeType = named ?? this.defaultRuntimeType;
    const runtime = this.agentRuntimes.get(runtimeType);
    if (!runtime) {
      return {
        error:
          `No agent runtime registered for '${runtimeType}'. This message is addressed to a ` +
          `runtime this server did not start; it is registered for ` +
          `${[...this.agentRuntimes.keys()].join(', ')}.`,
      };
    }
    return { runtime, runtimeType };
  }

  /**
   * Return the current adapter status snapshot.
   */
  getStatus(): AdapterStatus {
    return { ...this.status, queuedMessages: this.runtimeAdapter.queueSize };
  }

  /**
   * Deliver a Relay message to an agent session or Tasks runner.
   *
   * Routes to handleAgentMessage or handleTasksMessage based on subject prefix.
   * Takes a concurrency slot before dispatching, **waiting** for one when every
   * slot is busy rather than turning the message away.
   *
   * @param subject - The target subject
   * @param envelope - The relay envelope to deliver
   * @param context - Optional context with agent directory, trace info, and the
   *   {@link AdapterContext.onHeld} callback that tells a waiting chat it is
   *   waiting.
   */
  async deliver(
    subject: string,
    envelope: RelayEnvelope,
    context?: AdapterContext
  ): Promise<DeliveryResult> {
    const startTime = Date.now();
    this.status = {
      ...this.status,
      messageCount: {
        ...this.status.messageCount,
        inbound: this.status.messageCount.inbound + 1,
      },
    };

    // A subject under the tasks branch that is not a dispatch subject is not
    // work this adapter has been given — it is somebody publishing beneath one,
    // which the prefix claim above cannot distinguish on its own. Answered here,
    // before a concurrency slot or a turn handle exists, and answered as
    // `skipped` rather than as a failure: the publish pipeline dead-letters
    // every unsuccessful adapter delivery, and reading a run's own progress
    // stream as a malformed dispatch is exactly how one run produced 279 "could
    // not be delivered" notifications (DOR-1567).
    if (subject.startsWith(TASK_DISPATCH_SUBJECT_PREFIX) && !isTaskDispatchSubject(subject)) {
      return { success: true, skipped: true, durationMs: Date.now() - startTime };
    }

    // The handle on this turn, created HERE rather than inside the handler.
    // Two things stand between a message arriving and its turn starting — the
    // concurrency line, and the per-session queue — and a turn stopped while it
    // is in either of them has to be stoppable, and must never start once it
    // is. Registering at the head of the queue instead meant a cancel for a
    // queued turn was refused as "not executing here", and the turn then ran
    // and billed anyway (DOR-791). Tasks dispatch keeps its own registry, keyed
    // by run id, and ignores this one.
    const turnController = new AbortController();
    const turnKey = isTaskDispatchSubject(subject) ? undefined : envelope.replyTo;
    if (turnKey) this.runningTurns.register(turnKey, turnController);

    try {
      return await this.deliverWithTurnHandle(
        subject,
        envelope,
        context,
        startTime,
        turnController
      );
    } finally {
      if (turnKey) this.runningTurns.release(turnKey, turnController);
    }
  }

  /**
   * Take a concurrency slot and run the delivery, with the turn's handle in hand.
   *
   * Split out from {@link deliver} only so the registration above brackets
   * every exit from this method — including the slot refusals, which return
   * early.
   *
   * @param subject - The target subject
   * @param envelope - The relay envelope to deliver
   * @param context - Optional adapter context
   * @param startTime - When delivery began, for `durationMs`
   * @param turnController - The handle a stop request aborts
   */
  private async deliverWithTurnHandle(
    subject: string,
    envelope: RelayEnvelope,
    context: AdapterContext | undefined,
    startTime: number,
    turnController: AbortController
  ): Promise<DeliveryResult> {
    // Which runtime answers, answered BEFORE a concurrency slot is taken: a
    // message nothing here can run must not spend one, and must not make the
    // next message wait behind it. The refusal reports the same way a slot
    // refusal does — `success: false` and no run-row write — because it is the
    // same kind of event: the handler never started.
    const selected = this.resolveRuntime(subject, envelope);
    if ('error' in selected) {
      this.status = {
        ...this.status,
        errorCount: this.status.errorCount + 1,
        lastError: selected.error,
        lastErrorAt: new Date().toISOString(),
      };
      (this.deps.logger ?? console).warn(`[CCA] ${selected.error} (subject: ${subject})`);
      return { success: false, error: selected.error, durationMs: Date.now() - startTime };
    }
    const agentManager = selected.runtime;

    // A hold may not outlive the message it holds. `handleAgentMessage` gives
    // the turn whatever is left of the envelope's TTL, and falls back to
    // `defaultTimeoutMs` when nothing is — so a wait that ate the whole TTL
    // would start the turn on a FRESH full budget, an hour-old message running
    // as if it had just arrived. The wait stops when the message's own time is
    // up, and a message with no time left never waits at all.
    const ttlRemainingMs = envelope.budget.ttl - Date.now();
    const slot = await this.capacity.acquire({
      // Only a delivery the pipeline licensed may wait, and the pipeline is the
      // only thing that can tell which those are: it sets `onHeld` when a
      // person in a bridged chat is the reader, and on nothing else (see
      // {@link AdapterContext.onHeld}). Deciding this from the subject here
      // instead would put the same rule in two modules — and an awaited caller
      // parked in this line loses its reply rather than waiting for it.
      mayWait: context?.onHeld !== undefined && ttlRemainingMs > 0,
      ceilingMs: ttlRemainingMs,
      ...(context?.onHeld ? { onHeld: context.onHeld } : {}),
    });
    if (slot !== 'acquired') {
      return slotRefusal(
        slot,
        this.config,
        Date.now() - startTime,
        Math.min(this.config.defaultTimeoutMs, Math.max(ttlRemainingMs, 0))
      );
    }

    try {
      if (isTaskDispatchSubject(subject)) {
        return await handleTasksMessage(
          subject,
          envelope,
          context,
          startTime,
          { defaultCwd: this.config.defaultCwd },
          {
            agentManager,
            traceStore: this.deps.traceStore,
            taskStore: this.deps.taskStore,
            runningTasks: this.runningTasks,
            inboundBudgets: this.deps.inboundBudgets,
            logger: this.deps.logger,
          }
        );
      }

      // Extract agentId/sessionId for queue key via the shared parser so both
      // the legacy (`relay.agent.<sessionId>`) and runtime-scoped
      // (`relay.agent.<runtimeType>.<sessionId>`) subject shapes produce the
      // same queue key. If extraction fails we still fall through so
      // handleAgentMessage can return the proper error (keeping pre-parser
      // behavior for malformed inputs).
      const queueKey = extractSessionIdFromSubject(subject) ?? subject;
      return await this.runtimeAdapter.enqueue(queueKey, () =>
        handleAgentMessage(
          subject,
          envelope,
          context,
          startTime,
          { defaultTimeoutMs: this.config.defaultTimeoutMs },
          {
            agentManager,
            runtimeType: selected.runtimeType,
            traceStore: this.deps.traceStore,
            agentSessionStore: this.deps.agentSessionStore,
            resolveExecutionSettings: this.deps.resolveExecutionSettings,
            turnController,
            inboundBudgets: this.deps.inboundBudgets,
            logger: this.deps.logger,
          },
          this.relay
        )
      );
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      this.status = {
        ...this.status,
        errorCount: this.status.errorCount + 1,
        lastError: errorMsg,
        lastErrorAt: new Date().toISOString(),
      };
      return {
        success: false,
        error: errorMsg,
        durationMs: Date.now() - startTime,
      };
    } finally {
      // The one release seam. A turn that answered, threw, timed out or was
      // stopped all arrive here, which is what makes the waiting line's promise
      // keepable: the next held delivery starts from inside this call.
      this.capacity.release();
    }
  }
}
