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
 * turn's run (`start_lost`).
 *
 * **After a restart** (§7.3, DOR-5496). The scheduler that read a turn dies
 * with its boot, so the run record hands the turn's run back through this
 * source once a restart cut it or lost its start (`WordSource.ended`), and the
 * task's run ends with that run's ending (`task-run-endings.ts`), once. The
 * scheduler's boot sweep leaves alone a task run the record still owes its
 * ending ({@link TaskTurns.owesEnding}). The source is registered as soon as
 * the door is built, so a gone boot's start finds a reader, not a wait.
 *
 * @module services/tasks/execution/task-turns
 */
import type { TurnPermissionCeiling } from '@dorkos/shared/agent-runtime';
import type { PermissionMode, StreamEvent } from '@dorkos/shared/types';
import { formatDorkReference } from '@dorkos/shared/dork-ref';
import type { SpaceTurnPort } from '../../runs/index.js';
import type { TaskStore } from '../task-store.js';
import type { RunExecutionSettings } from './resolve-run-execution.js';
import { endTaskRun, notStartedLine } from './task-run-endings.js';

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
  /**
   * Whether the run record still owes a task's run its ending: its turn's run
   * is live or waiting, or a restart ended it and recovery has not decided it.
   * The record ends such a run itself; nothing else may.
   *
   * @param taskRunId - The task's run (`pulse_runs.id`).
   */
  owesEnding?(taskRunId: string): boolean;
}

/**
 * The turn port's door for a task's runs. Startup hands it the server's space
 * face, so the tasks domain reads the port only through its types.
 *
 * @param port - The space face, read at call time; `undefined` before startup wired it.
 * @param store - The task store a run a restart ended is closed in; without
 *   one, the scheduler's boot sweep closes it.
 */
export function portTaskTurns(
  port: () => SpaceTurnPort | undefined,
  store?: Pick<TaskStore, 'updateRun' | 'markRunsInterrupted'>
): TaskTurns {
  /** The words of the runs this process is watching, by task run id. */
  const words = new Map<string, string>();
  let registeredOn: SpaceTurnPort | undefined;
  const door = (): SpaceTurnPort => {
    const face = port();
    if (!face) throw new Error('DorkOS is still starting. Try the task again in a moment.');
    if (face !== registeredOn) {
      registeredOn = face;
      face.registerSource(TASK_RUN_SOURCE, {
        read: (id) => words.get(id),
        ...(store ? { ended: (id, run, told) => endTaskRun(store, id, run, told) } : {}),
      });
    }
    return face;
  };
  if (port()) door();
  return {
    owesEnding: (taskRunId) =>
      store !== undefined && port()?.owesEnding(`${TASK_RUN_SOURCE}:${taskRunId}`) === true,
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
        events: face.turnEvents(turnRunId, {
          notStarted: notStartedLine,
          onEnd: () => words.delete(request.runId),
        }),
        stop: async () => {
          await face.stopTurn(turnRunId, by);
        },
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
