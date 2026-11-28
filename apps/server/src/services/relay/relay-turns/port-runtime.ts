/**
 * Relay deliveries start their turns through the turn port (spec
 * `turns-survive-restarts` §9 T13, §10 child J). The built-in relay adapter
 * drives an `AgentRuntimeLike`; on this server every one it holds is the
 * port-backed stand-in built here, so a relay turn gets a run record, takes the
 * dispatcher's one decision about whether its chat is free and the launch cap,
 * and is stopped by its run. The relay package's handlers never reach a runtime.
 *
 * **What a turn is.** The adapter tells the host who sent each message just
 * before its turn starts (`ClaudeCodeAdapterDeps.noteTurnStart`), keyed by the
 * session the turn runs in, and both of its handlers do: a message to an agent
 * and a scheduled task's run the scheduler handed the relay. The sender decides
 * the run's origin: the scheduler's own address is a `schedule` run, with the
 * task's level and rules; any other is a relay delivery (`relayTurnOrigin`),
 * with the level its binding grants. A send nobody noted is refused, never
 * guessed at.
 *
 * **Where a task's words wait.** The task handler's note names the task's run,
 * so its words wait at the scheduler's own source (`task-run:<id>`,
 * {@link TaskRunWords}) until its turn is over, as a fire the scheduler starts
 * itself keeps them (DOR-5508). The run names that source, so a restart that
 * cuts it ends the task's run from the run record. A delivery's words stay in
 * this process.
 *
 * **Trust.** Everything the relay sent the runtime about power crosses the port
 * as plain data and reaches the runtime unchanged: the binding's level (the
 * port's `relay` field), the ceiling a sender that may not shape the turn is
 * held to, the outsider mark, and for a task its level, its approved rules and
 * whether nobody is watching. An approval card never holds a relay delivery's
 * turn. The agent the turn runs as is named by its Mesh id; a turn for a folder
 * no registered agent lives in is refused.
 *
 * **A binding no turn used.** A chat that was unbound before a turn that said
 * nothing has the binding its launch wrote taken back ({@link ChatBindings}).
 *
 * **What stays a runtime read.** The SDK's own session id, whether background
 * work still holds the agent, and a chat platform's answer to an approval card
 * go to the runtime underneath: none of them starts, steers or stops a turn.
 *
 * @module services/relay/relay-turns/port-runtime
 */
import { isTurnContentEvent, type AgentRuntimeLike, type TurnStartNote } from '@dorkos/relay';
import { TASK_SCHEDULER_PRINCIPAL } from '@dorkos/shared/relay-schemas';
import type { InterruptReceipt, PermissionMode, StreamEvent } from '@dorkos/shared/types';
import type { StartTurnInput, TurnOrigin } from '@dorkos/shared/turn-port';
import { canonicalDir } from '@dorkos/shared/agent-facts';
import { dorkReferenceOrNull } from '@dorkos/shared/dork-ref';
import type { SpaceTurnPort, TurnRun } from '../../runs/index.js';
import { logger } from '../../../lib/logger.js';

/** What `ensureSession` was told for the turn about to start on a session. */
type EnsuredSession = Parameters<AgentRuntimeLike['ensureSession']>[1];

/** What `sendMessage` was told for one turn. */
type SendOptions = NonNullable<Parameters<AgentRuntimeLike['sendMessage']>[2]> & {
  /** A task's approved rules, which the relay's task handler sends beside the rest. */
  taskApprovedAllow?: readonly string[];
};

/** The starters a relay delivery's run may show (`RelayTurnSchema.starter`). */
const RELAY_STARTERS = new Set([
  'telegram',
  'slack',
  'webhook',
  'agent-message',
  'outside-message',
  'unknown',
]);

let spaceFace: () => SpaceTurnPort | undefined = () => undefined;

/**
 * Wire the space face relay turns start on. Startup calls it once with the
 * run record's own getter (`turnPort` in `services/runs`); until then, and in
 * a test that wires nothing, every relay turn is refused, never run some other way.
 *
 * @param port - The space face, read at call time.
 */
export function setRelayTurnPort(port: () => SpaceTurnPort | undefined): void {
  spaceFace = port;
}

/** Which agent lives in a folder, by the registry; none until startup wires it. */
let agentAt: (folder: string) => string | undefined = () => undefined;

/**
 * Wire the registry's answer to "which agent lives in this folder". Startup
 * calls it with Mesh's lookup (`resolveAgentIdForPath`); until then every relay
 * turn's agent is unknown, so the turn is refused.
 *
 * @param lookup - The registry's answer for a folder.
 */
export function setRelayAgentLookup(lookup: (folder: string) => string | undefined): void {
  agentAt = lookup;
}

/**
 * The scheduler's source for a task run's words (`TaskTurns.holdWords` in
 * `services/tasks`), handed in by startup so this domain does not import it.
 */
export interface TaskRunWords {
  /**
   * Keep a task run's words at the scheduler's source until its turn is over.
   *
   * @param taskRunId - The task's run (`pulse_runs.id`).
   * @param words - The words its turn starts with.
   * @returns The run's `sourceRef`, and the release to call once its turn is over.
   */
  holdWords?(taskRunId: string, words: string): { sourceRef: string; release: () => void };
}

let taskRunWords: TaskRunWords | undefined;

/**
 * Wire the scheduler's source a relay-carried task's words wait at. Startup
 * calls it once Tasks has built its door; until then, and with Tasks off, a
 * task's words stay in this process, as a delivery's do.
 *
 * @param source - The scheduler's door, or `undefined` to take it back.
 */
export function setRelayTaskRunWords(source: TaskRunWords | undefined): void {
  taskRunWords = source;
}

/** The scheduler's source for a task's words, or `undefined` before startup wired it. */
export function relayTaskRunWords(): TaskRunWords | undefined {
  return taskRunWords;
}

/** The space face relay turns start on, or `undefined` before startup wired it. */
export function relayTurnPort(): SpaceTurnPort | undefined {
  return spaceFace();
}

/** What the adapter noted about a session's next turn: its sender, and a task's run. */
export interface RelayTurnNote {
  /** Who sent the message, as the server stamped it on the envelope. */
  from: string;
  /** The task's run, when the task handler started the turn. */
  taskRunId?: string;
}

/** Who sent the message each session's next turn answers, as the adapter noted it. */
export class RelayTurnNotes {
  private readonly senders = new Map<string, RelayTurnNote>();

  /** The adapter's note, handed to it as `noteTurnStart`. */
  readonly note: TurnStartNote = ({ sessionId, from, taskRunId }) => {
    this.senders.set(sessionId, { from, ...(taskRunId !== undefined ? { taskRunId } : {}) });
  };

  /**
   * The note for the turn about to start on a session, read once.
   *
   * @param sessionId - The session key the turn runs under.
   */
  take(sessionId: string): RelayTurnNote | undefined {
    const note = this.senders.get(sessionId);
    this.senders.delete(sessionId);
    return note;
  }
}

/** What the port-backed runtimes need from the server. */
export interface PortRuntimeDeps {
  /** The space face, read at call time; `undefined` before startup wired it. */
  port: () => SpaceTurnPort | undefined;
  /** The senders the adapter noted. One for every runtime the adapter holds. */
  notes: RelayTurnNotes;
  /** A relay delivery's origin, from its server-stamped sender. */
  originOf: (from: string) => TurnOrigin;
  /** The Mesh id of the registered agent whose home a folder is, else `undefined`. */
  agentIdOf: (home: string, face: SpaceTurnPort) => Promise<string | undefined>;
  /** Which runtime a chat is bound to, and taking back a binding no turn used. */
  chats: ChatBindings;
  /** The scheduler's source a task's words wait at; absent, they stay in this process. */
  taskRunWords?: () => TaskRunWords | undefined;
}

/**
 * The runtime binding of the chats relay turns run in. The launch path binds a
 * new chat's runtime as its turn launches; a relay chat keyed by its agent
 * alone keeps that key for its next conversation, so a binding its first turn
 * left without saying anything would hold every later conversation to that
 * runtime, whatever the agent's manifest says (DOR-1774). Such a binding is
 * taken back, as a room takes back the one its launch wrote (DOR-2447).
 */
export interface ChatBindings {
  /** Whether a chat is bound to a runtime yet. */
  isBound: (sessionId: string) => Promise<boolean>;
  /** Take back the binding a launch wrote for a chat whose turn said nothing. */
  forgetUnstarted: (sessionId: string) => Promise<void>;
}

/** A run this stand-in started, the face it was started on, and whether its chat was bound before. */
interface StartedRun {
  face: SpaceTurnPort;
  runId: string;
  wasBound: boolean;
  /** Let a task's words go from the scheduler's source, once its turn is over. */
  release?: () => void;
}

/** Where a task's words wait, as the start names it. */
interface HeldWords {
  sourceRef: string;
  originRef: string;
  release: () => void;
}

/**
 * Keep a task's words at the scheduler's source, when the note names its run
 * by an id a reference can carry and Tasks wired the source.
 *
 * @param taskRunId - The task's run, as the note named it.
 * @param words - The words the turn starts with.
 * @param deps - Where the scheduler's source is.
 */
function holdTaskWords(
  taskRunId: string | undefined,
  words: string,
  deps: PortRuntimeDeps
): HeldWords | undefined {
  if (taskRunId === undefined) return undefined;
  const originRef = dorkReferenceOrNull('run', taskRunId);
  const source = deps.taskRunWords?.();
  if (originRef === null || !source?.holdWords) return undefined;
  return { ...source.holdWords(taskRunId, words), originRef };
}

/** The receipt for a stop that found no turn running. */
function notRunning(runtime: string): InterruptReceipt {
  return { outcome: 'not-running', reason: 'no-open-turn', runtime };
}

/** Why a run the port never started did not start, in a sentence the sender reads. */
function notStartedLine(run: TurnRun): string {
  return run.endingDetail.cancelledBecause === 'expired'
    ? 'The message waited too long for the agent to be free, so it was not answered.'
    : 'The agent could not start on this message, so it was not answered.';
}

/**
 * What one turn asks the port for: the relay's own words for the turn, as
 * plain data. See the module documentation for which sender is which.
 */
async function startInputOf(
  turn: { sessionId: string; content: string; from: string; runtime: string },
  session: EnsuredSession | undefined,
  opts: SendOptions,
  deps: PortRuntimeDeps,
  face: SpaceTurnPort,
  held: HeldWords | undefined
): Promise<StartTurnInput> {
  const task = turn.from === TASK_SCHEDULER_PRINCIPAL;
  let agentId: string | undefined;
  if (opts.forAgent !== undefined) {
    agentId = await deps.agentIdOf(opts.forAgent, face);
    if (agentId === undefined) {
      throw new Error('This message is for an agent that is not registered, so it was not run.');
    }
  }
  // The relay sends the level with both calls; absence is the prompting mode,
  // never consent (DOR-604).
  const permissionMode: PermissionMode =
    opts.permissionMode ?? session?.permissionMode ?? 'default';
  const cwd = opts.cwd ?? session?.cwd;
  const model = opts.model ?? session?.model;
  const effort = opts.effort ?? session?.effort;
  const accountHint = opts.accountHint ?? session?.accountHint;
  const approvedAllow = opts.taskApprovedAllow;
  const starter = opts.turnStarter;
  return {
    sessionId: turn.sessionId,
    ...(agentId !== undefined ? { agentId } : {}),
    ...(cwd !== undefined ? { cwd } : {}),
    content: turn.content,
    origin: task ? { kind: 'schedule' } : deps.originOf(turn.from),
    ...(held ? { originRef: held.originRef, sourceRef: held.sourceRef } : {}),
    tier: 'owner',
    runtime: turn.runtime,
    ...(opts.systemPromptAppend !== undefined
      ? { systemPromptAppend: opts.systemPromptAppend }
      : {}),
    ...(model !== undefined || effort !== undefined
      ? {
          settings: {
            ...(model !== undefined ? { model } : {}),
            ...(effort !== undefined ? { effort } : {}),
          },
        }
      : {}),
    ...(accountHint !== undefined ? { accountHint } : {}),
    ...(opts.permissionCeiling !== undefined ? { permissionCeiling: opts.permissionCeiling } : {}),
    ...(opts.carriedMarks?.outsider === true ? { carriedMarks: { outsider: true as const } } : {}),
    ...(task
      ? {
          ...(session?.unattended === true ? { unattended: true as const } : {}),
          task: { permissionMode, ...(approvedAllow?.length ? { approvedAllow } : {}) },
        }
      : {
          relay: {
            permissionMode,
            ...(starter !== undefined && RELAY_STARTERS.has(starter)
              ? { starter: starter as NonNullable<StartTurnInput['relay']>['starter'] }
              : {}),
          },
        }),
  };
}

/**
 * The relay's stand-in for one runtime: every turn it is asked for starts
 * through the turn port.
 *
 * @param inner - The runtime the relay held, asked only for reads and a card's answer.
 * @param runtime - The runtime's type, which every turn is started on.
 * @param deps - The space face, the adapter's notes, and how senders and folders are named.
 */
export function portBackedRuntime(
  inner: AgentRuntimeLike,
  runtime: string,
  deps: PortRuntimeDeps
): AgentRuntimeLike {
  const sessions = new Map<string, EnsuredSession>();
  const starts = new Map<string, Promise<StartedRun>>();

  const begin = async (
    sessionId: string,
    content: string,
    opts: SendOptions
  ): Promise<StartedRun> => {
    const note = deps.notes.take(sessionId);
    const session = sessions.get(sessionId);
    sessions.delete(sessionId);
    if (note === undefined) {
      throw new Error('This relay turn did not say who sent it, so it was not started.');
    }
    const { from } = note;
    const face = deps.port();
    if (!face) throw new Error('DorkOS is still starting. Send the message again in a moment.');
    const turn = { sessionId, content, from, runtime };
    // Only the scheduler's own sends name a task's run.
    const held =
      from === TASK_SCHEDULER_PRINCIPAL ? holdTaskWords(note.taskRunId, content, deps) : undefined;
    try {
      const input = await startInputOf(turn, session, opts, deps, face, held);
      const wasBound = await deps.chats.isBound(sessionId);
      return {
        face,
        runId: face.start(input).runId,
        wasBound,
        ...(held ? { release: held.release } : {}),
      };
    } catch (err) {
      held?.release();
      throw err;
    }
  };

  async function* stream(
    sessionId: string,
    starting: Promise<StartedRun>
  ): AsyncGenerator<StreamEvent> {
    let said = false;
    // Set once the run is over, not when its reader stops early: a turn still
    // running keeps its binding.
    let over = false;
    let started: StartedRun | undefined;
    try {
      started = await starting;
      try {
        for await (const event of started.face.turnEvents(started.runId, {
          notStarted: notStartedLine,
        })) {
          said ||= isTurnContentEvent(event);
          yield event;
        }
      } catch (err) {
        over = true;
        throw err;
      }
      over = true;
    } finally {
      started?.release?.();
      if (starts.get(sessionId) === starting) starts.delete(sessionId);
      if (started && over && !started.wasBound && !said) {
        await deps.chats.forgetUnstarted(sessionId).catch((err: unknown) => {
          logger.warn('[relay] could not take back the binding of a turn that said nothing', {
            sessionId,
            error: err instanceof Error ? err.message : String(err),
          });
        });
      }
    }
  }

  return {
    type: runtime,
    ensureSession(sessionId, opts) {
      sessions.set(sessionId, opts);
    },
    sendMessage(sessionId, content, opts = {}) {
      // Started now, not at the first read, so a stop that comes first finds it.
      const starting = begin(sessionId, content, opts);
      starting.catch(() => {});
      starts.set(sessionId, starting);
      return stream(sessionId, starting);
    },
    async interruptQuery(sessionId) {
      const started = await starts.get(sessionId)?.catch(() => undefined);
      if (!started) return notRunning(runtime);
      const receipt = await started.face.stopTurn(started.runId);
      if (receipt) return receipt;
      // Taken back before it began, or a launch under way that is stopped once it starts.
      return started.face.get(started.runId)?.status === 'cancelled'
        ? notRunning(runtime)
        : { outcome: 'unconfirmed', reason: 'no-open-turn', runtime };
    },
    approveTool: (sessionId, toolCallId, approved) =>
      inner.approveTool(sessionId, toolCallId, approved),
    ...(inner.getSdkSessionId
      ? { getSdkSessionId: (sessionId: string) => inner.getSdkSessionId!(sessionId) }
      : {}),
    ...(inner.holdsBackgroundWork
      ? { holdsBackgroundWork: (sessionId: string) => inner.holdsBackgroundWork!(sessionId) }
      : {}),
  };
}

/**
 * Every runtime the relay holds, each behind its port-backed stand-in.
 *
 * @param runtimes - Runtime type to the runtime the relay was given.
 * @param deps - What every stand-in shares.
 */
export function portBackedRuntimes(
  runtimes: ReadonlyMap<string, AgentRuntimeLike>,
  deps: PortRuntimeDeps
): Map<string, AgentRuntimeLike> {
  return new Map(
    [...runtimes].map(([type, inner]) => [type, portBackedRuntime(inner, type, deps)])
  );
}

/**
 * The Mesh id of the registered agent whose home a folder is: the registry's
 * answer for the folder ({@link setRelayAgentLookup}), kept only when Mesh says that id's home is this very
 * folder, so a worktree or a subfolder of an agent's repo names nobody. Read
 * from the registry, never the folder's own manifest: the space side does not
 * read an agent's folder, which for an agent computer is not on this disk.
 *
 * @param home - The folder a turn names as its agent's home.
 * @param face - The space face, which asks Mesh.
 */
export async function registeredAgentIdOf(
  home: string,
  face: SpaceTurnPort
): Promise<string | undefined> {
  const id = agentAt(home);
  if (id === undefined) return undefined;
  const registered = face.agentHomeOf(id);
  return registered !== undefined && canonicalDir(registered) === canonicalDir(home)
    ? id
    : undefined;
}
