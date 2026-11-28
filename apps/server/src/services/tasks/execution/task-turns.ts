/**
 * Where a task's run starts its turn: through the turn port (spec
 * `turns-survive-restarts` §3, T12). The scheduler no longer drives a runtime
 * itself; it asks the space face to start the turn and reads back what the
 * turn said, as every other caller does, so a task's turn takes the
 * dispatcher's one decision about whether the chat is free, the launch cap and
 * the scheduler's own cap, and gets a run record a restart can read.
 *
 * **What the scheduler reads.** The run's turn events, as the runtime sends
 * them (its summary, its outcome, its refused asks), end when the run's turn
 * is over; a turn whose stream broke off fails on the ending the record kept. While the run waits for a free slot, the stream says so with
 * the server's slot-wait status, so the run's time limit does not count and
 * its row says it is waiting (`pauseWhileWaitingToStart`, DOR-4576). A run the
 * port never started (refused at the door, its start lost) ends the stream
 * with a throw, which fails the task's run with the reason.
 *
 * **Where its words wait.** With the scheduler's watch of the run, in this
 * process (`task-run:<id>`): a restart before the turn starts cancels the
 * turn's run (`start_lost`), and the task's own run is ended as interrupted by
 * the scheduler's boot sweep, as it was.
 *
 * @module services/tasks/execution/task-turns
 */
import { SLOT_WAIT_STATUS, SLOT_WAIT_TEXT, type InterruptReceipt } from '@dorkos/shared/schemas';
import type { TurnPermissionCeiling } from '@dorkos/shared/agent-runtime';
import type { PermissionMode, StreamEvent } from '@dorkos/shared/types';
import { formatDorkReference } from '@dorkos/shared/dork-ref';
import type { RunStatus } from '@dorkos/shared/turn-port';
import type { SpaceTurnPort, TurnRun } from '../../runs/index.js';
import type { RunExecutionSettings } from './resolve-run-execution.js';
import { createTaggedLogger, logError } from '../../../lib/logger.js';

const logger = createTaggedLogger('Tasks');

/** The statuses after which a run's turn is over or never comes (`RUN_ENDS` in `services/runs`). */
const RUN_ENDS: ReadonlySet<RunStatus> = new Set(['ended', 'settled', 'cancelled', 'superseded']);

/** The source kind a task's run keeps its words under: the scheduler's watch of it. */
export const TASK_RUN_SOURCE = 'task-run';

/** What a task's run asks its turn to be. */
export interface TaskTurnRequest {
  /** The task's run (`pulse_runs.id`). */
  runId: string;
  /** The chat the turn runs in. */
  sessionId: string;
  /** The task's agent, by Mesh id, when it has one. */
  agentId?: string;
  /** The agent's home, when it has one: who the turn runs as. */
  forAgent?: string;
  /** Where the turn runs. */
  cwd: string;
  /** The task's prompt. */
  prompt: string;
  /** The runtime the run resolved to. */
  runtime: string;
  /** The level the task's schedule stores. */
  permissionMode: PermissionMode;
  /** The model, effort and account the run resolved to. */
  settings: RunExecutionSettings;
  /** The scheduler's brief for the agent. */
  systemPromptAppend: string;
  /** Rules a person approved for this task alone. */
  approvedAllow?: readonly string[];
  /** Whether a person or agent is there to answer its asks (not a timer's fire). */
  attended: boolean;
  /** The loosest level the turn may run at, from who wrote the task. */
  permissionCeiling?: TurnPermissionCeiling;
  /** A mark the turn carries from who wrote the task. */
  carriedMarks?: { outsider: true };
  /** Whether a sticky task's chat has run before, so its turn picks the chat back up. */
  hasStarted: boolean;
}

/** One task turn, started. */
export interface TaskTurn {
  /** The turn's events; ends when the turn is over, and throws when it never started. */
  events: AsyncIterable<StreamEvent>;
  /** Stop the turn: the operator's cancel, or the run's time limit. */
  stop(): Promise<void>;
}

/** Where a task's run starts its turn. Tests stand a runtime double in. */
export interface TaskTurns {
  /**
   * Start a task's turn.
   *
   * @param request - What the turn is.
   */
  open(request: TaskTurnRequest): TaskTurn;
}

/** The server's slot-wait status: what pauses a run's time limit while it waits. */
const SLOT_WAIT_EVENT: StreamEvent = {
  type: 'system_status',
  data: { status: SLOT_WAIT_STATUS, message: SLOT_WAIT_TEXT },
} as StreamEvent;

/** The run row's sentence for each reason the port gives a run that never started. */
const NOT_STARTED: Readonly<Record<string, string>> = {
  start_lost: 'The run did not start: DorkOS restarted before it began.',
  expired: 'The run did not start: it waited too long for a free slot.',
  start_failed: 'The run did not start: DorkOS could not hand it to the agent.',
  agent_paused: 'The run did not start: its agent is paused.',
  desk_not_own: 'The run did not start: its folder belongs to another agent.',
  invalid_agent_path: 'The run did not start: its agent is not registered.',
  account_not_allowed: 'The run did not start: its account may not work in this project.',
  unknown_runtime: 'The run did not start: its runtime is not available here.',
  runtime_mismatch: 'The run did not start: its runtime is not available here.',
};

/** Why a run the port never started did not start, in a sentence for the run row. */
function notStartedLine(run: TurnRun): string {
  const why = run.endingDetail.cancelledBecause;
  return (why && NOT_STARTED[why]) ?? 'The run did not start.';
}

/**
 * The turn port's door for a task's runs. Startup hands it the server's space
 * face, so the tasks domain reads the port only through its types.
 *
 * @param port - The space face, read at call time; `undefined` before startup wired it.
 */
export function portTaskTurns(port: () => SpaceTurnPort | undefined): TaskTurns {
  /** The words of the runs this process is watching, by task run id. */
  const words = new Map<string, string>();
  let registeredOn: SpaceTurnPort | undefined;
  const door = (): SpaceTurnPort => {
    const face = port();
    if (!face) throw new Error('DorkOS is still starting. Try the task again in a moment.');
    if (face !== registeredOn) {
      registeredOn = face;
      face.registerSource(TASK_RUN_SOURCE, { read: (id) => words.get(id) });
    }
    return face;
  };
  return {
    open(request) {
      const face = door();
      words.set(request.runId, request.prompt);
      let turnRunId: string;
      try {
        ({ runId: turnRunId } = face.start({
          sessionId: request.sessionId,
          ...(request.agentId !== undefined ? { agentId: request.agentId } : {}),
          cwd: request.cwd,
          content: request.prompt,
          origin: { kind: 'schedule' },
          originRef: formatDorkReference({ kind: 'run', id: request.runId }),
          tier: 'owner',
          runtime: request.runtime,
          sourceRef: `${TASK_RUN_SOURCE}:${request.runId}`,
          systemPromptAppend: request.systemPromptAppend,
          ...settingsOf(request.settings),
          ...(request.settings.accountHint !== undefined
            ? { accountHint: request.settings.accountHint }
            : {}),
          ...(request.attended ? {} : { unattended: true as const }),
          ...(request.permissionCeiling !== undefined
            ? { permissionCeiling: request.permissionCeiling }
            : {}),
          ...(request.carriedMarks ? { carriedMarks: request.carriedMarks } : {}),
          task: {
            permissionMode: request.permissionMode,
            ...(request.approvedAllow?.length ? { approvedAllow: request.approvedAllow } : {}),
          },
        }));
      } catch (err) {
        words.delete(request.runId);
        throw err;
      }
      const by = formatDorkReference({ kind: 'run', id: request.runId });
      return {
        events: watchTurn(face, turnRunId, () => words.delete(request.runId)),
        stop: () => stopTurn(face, turnRunId, by),
      };
    },
  };
}

/** The model and effort the run resolved to, as the port's settings. */
function settingsOf(settings: RunExecutionSettings): {
  settings?: Pick<RunExecutionSettings, 'model' | 'effort'>;
} {
  const chosen = {
    ...(settings.model !== undefined ? { model: settings.model } : {}),
    ...(settings.effort !== undefined ? { effort: settings.effort } : {}),
  };
  return Object.keys(chosen).length > 0 ? { settings: chosen } : {};
}

/**
 * Stop a turn. A launch still under way has no turn to stop yet, so the stop
 * is asked again the moment its run has started. Never rejects: it is called
 * from an abort listener, and a turn that cannot be stopped must not keep the
 * run from being written.
 */
async function stopTurn(face: SpaceTurnPort, runId: string, by: string): Promise<void> {
  const ask = (): Promise<InterruptReceipt | undefined> =>
    face.stop(runId, by).catch((err: unknown) => {
      logger.warn(`a task's turn could not be stopped`, { runId, ...logError(err) });
      return undefined;
    });
  if ((await ask()) !== undefined) return;
  const run = face.get(runId);
  if (!run || RUN_ENDS.has(run.status)) return;
  const stopOnStart = face.watch(
    (moved) => {
      if (moved.status === 'started' || moved.status === 'running') {
        stopOnStart();
        void ask();
      } else if (RUN_ENDS.has(moved.status)) {
        stopOnStart();
      }
    },
    { runId }
  );
}

/**
 * A run's turn events until its turn is over. Subscribed before the first
 * hand-over can happen (the start was only saved), so nothing is missed.
 */
async function* watchTurn(
  face: SpaceTurnPort,
  runId: string,
  forget: () => void
): AsyncGenerator<StreamEvent> {
  const waiting: StreamEvent[] = [];
  let over: TurnRun | undefined;
  let wake: (() => void) | undefined;
  let saidWaiting = false;
  let sawDone = false;
  const push = (event: StreamEvent): void => {
    if (event.type === 'done') sawDone = true;
    waiting.push(event);
    wake?.();
  };
  const hear = (run: TurnRun): void => {
    if (run.status === 'queued' && run.waitReason === 'machine_full' && !saidWaiting) {
      saidWaiting = true;
      push(SLOT_WAIT_EVENT);
    }
    if (RUN_ENDS.has(run.status)) {
      over = run;
      wake?.();
    }
  };
  const unwatchEvents = face.watchEvents(runId, push);
  const unwatchRun = face.watch(hear, { runId });
  try {
    const now = face.get(runId);
    if (now) hear(now);
    for (;;) {
      while (waiting.length > 0) yield waiting.shift()!;
      if (over) break;
      await new Promise<void>((resolve) => {
        wake = resolve;
      });
      wake = undefined;
    }
    if (over.status === 'cancelled' && over.endingDetail.cancelledBecause !== 'stopped') {
      throw new Error(notStartedLine(over));
    }
    // The runtime's stream broke off (a throw, a refusal, a process that died):
    // what DorkOS closed the turn with never passed here, so the run fails on
    // its ending rather than reading as done.
    if (
      !sawDone &&
      over.ending !== null &&
      over.ending !== 'completed' &&
      over.ending !== 'stopped'
    ) {
      throw new Error(over.endingDetail.refusal ?? `The run’s turn ended early (${over.ending}).`);
    }
  } finally {
    unwatchEvents();
    unwatchRun();
    forget();
  }
}
