/**
 * A person letting a scheduled task do more on its own waits for the owner to
 * confirm it's them (DOR-4355): a looser mode, applied tool rules, an approval
 * above Default, or lifting a file cap. A schedule runs later with nobody
 * watching, so the raise lasts. Lowering, pausing and edits that keep the
 * level stay immediate; where the direction cannot be told, the write holds.
 *
 * Modes are read in the order every other check uses (`modeRaises`), on the
 * modes the task's runtime declares. With no runtime to ask, only Default and
 * Plan count as not above Default, as in `task-wifi-guard.ts`.
 *
 * @module routes/task-arm-raise
 */
import type { Context } from 'hono';
import type { Task } from '@dorkos/shared/schemas';
import type { ApiEnv } from '../http/api-chain.js';
import type { RequestFacts } from '../http/request-facts.js';
import { capabilitiesForTaskRuntime } from '../services/tasks/scheduled-run-power.js';
import { modeRaises } from '../services/core/auth/sessions/wifi-raise-guard.js';
import { taskReviewRevision } from '../services/tasks/approvals/person-review.js';
import type { TaskStore } from '../services/tasks/task-store.js';
import { runFrontDoorWrite } from './front-door-step-up.js';

/** What the confirmation sheet's refusals name. */
const SUBJECT = 'how scheduled tasks run';

/** The fields of a schedule write the raise check reads. */
export interface TaskRaiseWrite {
  permissionMode?: string;
  runtime?: string | null;
  status?: string;
  approvedAllow?: readonly unknown[];
}

/** Whether a mode runs above its runtime's default. An unknown one does. */
function aboveDefault(mode: string, runtime: string | null | undefined): boolean {
  const declared = capabilitiesForTaskRuntime(runtime)?.permissionModes;
  if (!declared) return mode !== 'default' && mode !== 'plan';
  return modeRaises(declared, null, mode);
}

/** Whether moving a task from one mode to another raises it. Unknown modes do. */
function raisesMode(from: string, to: string, runtime: string | null | undefined): boolean {
  if (from === to) return false;
  const declared = capabilitiesForTaskRuntime(runtime)?.permissionModes;
  return !declared || modeRaises(declared, from, to);
}

/**
 * Whether a new schedule a person makes runs looser than its runtime's
 * default. One that names no mode runs at the person's own saved level, so it
 * raises nothing here.
 *
 * @param body - The raw create body.
 */
export function taskCreateRaises(body: unknown): boolean {
  if (typeof body !== 'object' || body === null) return false;
  const fields = body as Record<string, unknown>;
  if (Array.isArray(fields.approvedAllow) && fields.approvedAllow.length > 0) return true;
  if (typeof fields.permissionMode !== 'string') return false;
  return aboveDefault(
    fields.permissionMode,
    typeof fields.runtime === 'string' ? fields.runtime : undefined
  );
}

/**
 * Whether an edit lets a schedule do more: a looser mode (or a new runtime it
 * runs above Default on), applied tool rules, or arming it above Default.
 *
 * @param data - The validated edit.
 * @param existing - The schedule as it stands.
 */
export function taskEditRaises(
  data: TaskRaiseWrite,
  existing: Pick<Task, 'permissionMode' | 'runtime' | 'status'>
): boolean {
  if ((data.approvedAllow?.length ?? 0) > 0) return true;
  const runtime = data.runtime !== undefined ? data.runtime : existing.runtime;
  const mode = data.permissionMode ?? existing.permissionMode;
  if (raisesMode(existing.permissionMode, mode, runtime)) return true;
  if (runtime !== existing.runtime && aboveDefault(mode, runtime)) return true;
  return data.status === 'active' && existing.status !== 'active' && aboveDefault(mode, runtime);
}

/**
 * Whether putting back the mode an agent replaced would raise the schedule.
 *
 * @param existing - The schedule as it stands.
 * @param previous - The mode the Undo would put back.
 */
export function undoRaisesMode(
  existing: Pick<Task, 'permissionMode' | 'runtime'>,
  previous: string
): boolean {
  return raisesMode(existing.permissionMode, previous, existing.runtime);
}

/** One held raise of a schedule. */
export interface TaskArmHold {
  /** What it acts on, in the server's words. */
  target: string;
  /** Exactly what will run, as plain JSON. */
  input: unknown;
  /** The sheet's sentence. */
  reason: string;
  /** Write, as the confirming caller. */
  run: (confirming: RequestFacts) => Promise<Response>;
}

/**
 * Hold a schedule raise for the owner's password. The front-door bar runs
 * again on confirmation.
 *
 * @param c - The request asking for the raise.
 * @param hold - The fixed raise and its write.
 */
export function holdTaskArm(c: Context<ApiEnv>, hold: TaskArmHold): Promise<Response> {
  return runFrontDoorWrite(c, { kind: 'tasks.arm', subject: SUBJECT, ...hold });
}

/**
 * Hold a raise of one existing schedule, bound to the schedule as it was
 * shown: a schedule that changed before the confirmation answers 409.
 *
 * @param c - The request asking for the raise.
 * @param store - Where schedules are kept.
 * @param existing - The schedule as it stands.
 * @param hold - What is held, and the write the confirmation runs.
 */
export function holdTaskRaise(
  c: Context<ApiEnv>,
  store: Pick<TaskStore, 'getTask'>,
  existing: Task,
  hold: Omit<TaskArmHold, 'target'>
): Promise<Response> {
  const revision = taskReviewRevision(existing);
  return holdTaskArm(c, {
    target: `scheduled-task:${existing.id}`,
    input: { input: hold.input, revision },
    reason: hold.reason,
    run: async (confirming) => {
      const current = store.getTask(existing.id);
      if (!current || taskReviewRevision(current) !== revision)
        return c.json(
          { error: 'The scheduled task changed. Try again.', code: 'TASK_CHANGED' },
          409
        );
      return hold.run(confirming);
    },
  });
}
