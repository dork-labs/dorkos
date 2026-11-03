/**
 * `POST /api/tasks/:id/approve-file`: a person approving a scheduled task's
 * SKILL file as it is now, which lifts the cap a change outside the task tools
 * put on its runs (DOR-3703, M4). The task row offers it when its agent has
 * no ordinary chat lately to lift the cap from.
 *
 * The body names the cap the person saw and the file hash its diff showed
 * (`{ capAt, hash }`, `Task.fileCap.at` and `.hash`), and the approval holds
 * only while the file still hashes to exactly that. A person's action only, behind the bar `PATCH /api/tasks/:id`
 * holds `status` to (`clearsTheAgentBar`), and refused from Wi-Fi like any
 * approval of a schedule (DOR-3037).
 *
 * @module routes/task-file-approve
 */
import type { Hono } from 'hono';
import type { ApiEnv } from '../http/api-chain.js';
import { honoRequestFacts } from '../http/request-facts.js';
import { clearsTheAgentBar } from '../lib/caller-authority.js';
import { readActivityActor } from '../services/activity/activity-actor.js';
import { approveCappedFile } from '../services/tasks/agent-mode/file-cap/file-cap-person.js';
import { readJsonBody } from '../http/request-body.js';
import { broadcastTasksChanged } from '../services/tasks/task-sse-events.js';
import { operatorOnlyTaskRefusal } from './task-route-answers.js';
import { wifiScheduleRefusal } from './task-wifi-guard.js';
import type { TaskModeUndoDeps } from './task-mode-undo.js';

/** What a request that names no cap reads. */
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
    if (typeof body?.capAt !== 'string' || typeof body.hash !== 'string') {
      return c.json(APPROVE_NEEDS_ITS_CAP, 400);
    }
    const outcome = await approveCappedFile(deps.store, c.req.param('id'), body.capAt, body.hash);
    if (!outcome.ok) return c.json(outcome.body, outcome.status);
    const { task } = outcome;
    broadcastTasksChanged();
    deps.activity?.emit({
      ...readActivityActor(honoRequestFacts(c)),
      category: 'tasks',
      eventType: 'tasks.task_approved',
      resourceType: 'schedule',
      resourceId: task.id,
      resourceLabel: task.displayName ?? task.name,
      summary: `Approved the changed file of scheduled task ${task.displayName ?? task.name}`,
      linkPath: '/',
    });
    return c.json(task);
  });
}
