/**
 * A runtime double standing in for the turn port in the scheduler's tests.
 *
 * In production a task's run starts its turn through the turn port
 * (`execution/task-turns.ts`), and the dispatcher hands the runtime the same
 * options a run carries. Most scheduler tests are about the run row, not the
 * port, so they drive a runtime double directly: this hands it exactly what
 * the port path gives a runtime (`ensureSession`, then `sendMessage` with the
 * task's level, brief, rules and marks), and stops it with `interruptQuery`.
 * The port path itself is proven in `tasks-through-turn-port.test.ts`.
 */
import type { StreamEvent } from '@dorkos/shared/types';
import {
  singleRuntimeSource,
  type SchedulerAgentManager,
  type SchedulerRuntimes,
} from '../../execution/scheduler-runtimes.js';
import type { TaskTurns } from '../../execution/task-turns.js';

/** The runtime calls a scheduler test double answers. */
export interface RuntimeDouble extends SchedulerAgentManager {
  ensureSession(sessionId: string, opts: Record<string, unknown>): void;
  sendMessage(
    sessionId: string,
    content: string,
    opts?: Record<string, unknown>
  ): AsyncIterable<StreamEvent>;
  interruptQuery(sessionId: string): Promise<unknown>;
}

/**
 * Task turns driven straight on a runtime double.
 *
 * @param runtime - The double, or how to find one by runtime type.
 */
export function runtimeTaskTurns(
  runtime: RuntimeDouble | ((type: string) => RuntimeDouble)
): TaskTurns {
  const of = typeof runtime === 'function' ? runtime : () => runtime;
  return {
    open(r) {
      const agent = of(r.runtime);
      agent.ensureSession(r.sessionId, {
        permissionMode: r.permissionMode,
        cwd: r.cwd,
        ...r.settings,
        hasStarted: r.hasStarted,
        unattended: !r.attended,
      });
      const events = agent.sendMessage(r.sessionId, r.prompt, {
        permissionMode: r.permissionMode,
        cwd: r.cwd,
        ...(r.forAgent !== undefined ? { forAgent: r.forAgent } : {}),
        systemPromptAppend: r.systemPromptAppend,
        contextPlace: 'task',
        ...(r.approvedAllow?.length ? { taskApprovedAllow: r.approvedAllow } : {}),
        ...r.settings,
        ...(r.permissionCeiling !== undefined ? { permissionCeiling: r.permissionCeiling } : {}),
        ...(r.carriedMarks ? { carriedMarks: r.carriedMarks } : {}),
        unattendedApprovals: !r.attended,
      });
      return {
        events,
        // Never rejects, as the port's own stop never does: it runs from an abort listener.
        stop: async () => {
          await Promise.resolve(agent.interruptQuery(r.sessionId)).catch(() => undefined);
        },
      };
    },
  };
}

/**
 * A scheduler's runtimes and turns, both on one double.
 *
 * @param runtime - The double.
 */
export function onRuntime(runtime: unknown): { runtimes: SchedulerRuntimes; turns: TaskTurns } {
  const double = runtime as RuntimeDouble;
  return { runtimes: singleRuntimeSource(double), turns: runtimeTaskTurns(double) };
}

/**
 * Turns for a scheduler whose runtimes are a registry of doubles.
 *
 * @param runtimes - The registry the scheduler resolves runs against.
 */
export function turnsOn(runtimes: SchedulerRuntimes): TaskTurns {
  return runtimeTaskTurns((type) => runtimes.get(type) as RuntimeDouble);
}
