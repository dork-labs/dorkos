/**
 * `POST /api/tasks/:id/approve-file`: a person approving a scheduled task's
 * SKILL file as it is now, which lifts the cap a change outside the task tools
 * put on its runs (DOR-3703, M4). The task row offers it when its agent has
 * no ordinary chat lately to lift the cap from.
 *
 * The body names the cap the person saw and the file hash its diff showed
 * (`{ capAt, hash }`, `Task.fileCap.at` and `.hash`), and the approval holds
 * only while the file still hashes to exactly that. With no cap standing yet,
 * the body names the hash alone (`{ hash }`, `Task.fileReview.hash`) and
 * approves the file as it is now (DOR-5060). A person's action only, behind
 * the bar `PATCH /api/tasks/:id` holds `status` to (`clearsTheAgentBar`), and refused from Wi-Fi like any
 * approval of a schedule (DOR-3037). It then waits for the owner to confirm
 * it's them (DOR-4355), since the approval lasts for every later run.
 *
 * @module routes/task-file-approve
 */
import type { Hono } from 'hono';
import type { ApiEnv } from '../http/api-chain.js';
import { honoRequestFacts } from '../http/request-facts.js';
import { clearsTheAgentBar } from '../lib/caller-authority.js';
import { readActivityActor } from '../services/activity/activity-actor.js';
import {
  approveCappedFile,
  approveFileAsItIs,
} from '../services/tasks/agent-mode/file-cap/file-cap-person.js';
import { readJsonBody } from '../http/request-body.js';
import { broadcastTasksChanged } from '../services/tasks/task-sse-events.js';
import { operatorOnlyTaskRefusal } from './task-route-answers.js';
import { wifiScheduleRefusal } from './task-wifi-guard.js';
import { holdTaskArm } from './task-arm-raise.js';
import type { TaskModeUndoDeps } from './task-mode-undo.js';

/** What a request that names no hash, or a cap that is not text, reads. */
const APPROVE_NEEDS_ITS_CAP = {
  error: 'Approve needs its cap',
  code: 'approve_needs_cap',
  message: 'Approve the file from the diff the task shows.',
} as const;

/**
 * Mount the route on the Tasks router.
 *
 * @param router - The Tasks router, mounted at `/api/tasks`.
 * @param deps - The undo route's dependencies, which this shares.
 */
export function mountTaskFileApprove(router: Hono<ApiEnv>, deps: TaskModeUndoDeps): void {
  router.post('/:id/approve-file', async (c) => {
    const caller = honoRequestFacts(c);
    const refusal = operatorOnlyTaskRefusal({ status: true }, clearsTheAgentBar(caller));
    if (refusal) return c.json(refusal, 403);
    const existing = deps.store.getTask(c.req.param('id'));
    const wifiRefusal = existing
      ? wifiScheduleRefusal(caller, { status: 'active' }, existing)
      : undefined;
    if (wifiRefusal) return c.json(wifiRefusal, 403);
    const body = readJsonBody(c) as { capAt?: unknown; hash?: unknown } | null;
    const named = body?.capAt ?? null;
    if (typeof body?.hash !== 'string' || (named !== null && typeof named !== 'string')) {
      return c.json(APPROVE_NEEDS_ITS_CAP, 400);
    }
    // No cap named: the file as it is now, while no cap stands (DOR-5060).
    const capAt = typeof named === 'string' ? named : null;
    const id = c.req.param('id');
    const { hash } = body;
    // Lifting the cap lets the file's runs go on unwatched, so it waits for the owner (DOR-4355).
    return holdTaskArm(c, {
      target: `scheduled-task:${id}`,
      input: { capAt, hash },
      reason:
        capAt === null
          ? 'Approve this scheduled task’s file as it is now.'
          : 'Approve this scheduled task’s changed file.',
      run: async (confirming) => {
        const outcome =
          capAt === null
            ? await approveFileAsItIs(deps.store, id, hash)
            : await approveCappedFile(deps.store, id, capAt, hash);
        if (!outcome.ok) return c.json(outcome.body, outcome.status);
        const { task } = outcome;
        broadcastTasksChanged();
        deps.activity?.emit({
          ...readActivityActor(confirming),
          category: 'tasks',
          eventType: 'tasks.task_approved',
          resourceType: 'schedule',
          resourceId: task.id,
          resourceLabel: task.displayName ?? task.name,
          summary: `Approved the ${capAt === null ? 'file' : 'changed file'} of scheduled task ${task.displayName ?? task.name}`,
          linkPath: '/',
        });
        return c.json(task);
      },
    });
  });
}
