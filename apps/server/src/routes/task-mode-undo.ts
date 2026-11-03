/**
 * `POST /api/tasks/:id/undo-agent-mode`: the Undo on the notice DorkOS posts
 * when one of our agents changes how a running schedule runs without asking
 * (DOR-3703, final rulings, condition 4).
 *
 * The body names the notice (`{ notificationId }`), and the Undo acts only on
 * the exact change that notice named (M9): a mode, a prompt, or an agent's
 * lift of a file cap (M4), which this caps again.
 *
 * A person's action only, behind the same bar as `PATCH /api/tasks/:id`'s
 * `permissionMode` (`clearsTheAgentBar`): an agent, an agent token or an
 * approval token is refused with the same envelope, so an agent can never
 * undo, or redo, a mode through this door.
 *
 * @module routes/task-mode-undo
 */
import type { Hono } from 'hono';
import type { MeshCore } from '@dorkos/mesh';
import type { ApiEnv } from '../http/api-chain.js';
import { honoRequestFacts } from '../http/request-facts.js';
import { clearsTheAgentBar } from '../lib/caller-authority.js';
import { readActivityActor } from '../services/activity/activity-actor.js';
import type { ActivityService } from '../services/activity/activity-service.js';
import type { TaskStore } from '../services/tasks/task-store.js';
import type { TaskRegistrar } from '../services/tasks/task-registrar.js';
import {
  undoAgentModeChange,
  type NamedChange,
} from '../services/tasks/agent-mode/agent-mode-undo.js';
import { storedNotificationPayload } from '../services/notifications/notification-service.js';
import type { ScheduleArmedPayload } from '../services/notifications/schedule-armed-copy.js';
import { readJsonBody } from '../http/request-body.js';
import { broadcastTasksChanged } from '../services/tasks/task-sse-events.js';
import { operatorOnlyTaskRefusal } from './task-route-answers.js';
import { wifiScheduleRefusal } from './task-wifi-guard.js';
import { mountTaskFileApprove } from './task-file-approve.js';

/** What a request that names no notice reads: an Undo acts only on what its notice named (M9). */
const UNDO_NEEDS_ITS_NOTICE = {
  error: 'Undo needs its notice',
  code: 'undo_needs_notice',
  message: 'Undo from the notice that named the change.',
} as const;

/**
 * The change the notice named, read back from the notice itself (M9), or
 * `null` when the body names no notice of this task's own agent change.
 *
 * @param body - The request body: `{ notificationId }`.
 * @param taskId - The task the route was called for.
 */
function namedChangeOf(body: unknown, taskId: string): NamedChange | null {
  const id = (body as { notificationId?: unknown } | null)?.notificationId;
  if (typeof id !== 'string') return null;
  const stored = storedNotificationPayload(id);
  if (stored?.kind !== 'schedule.armed_by_agent') return null;
  const payload = stored.payload as Partial<ScheduleArmedPayload> | null;
  if (payload?.taskId !== taskId) return null;
  const named: NamedChange = {
    ...(payload.modeChange?.at ? { modeAt: payload.modeChange.at } : {}),
    ...(payload.promptChange?.at ? { promptAt: payload.promptChange.at } : {}),
    ...(payload.fileChange?.kind === 'lifted' ? { fileLiftAt: payload.fileChange.at } : {}),
  };
  return Object.keys(named).length > 0 ? named : null;
}

/** What the undo route reads: the Tasks router's own dependencies. */
export interface TaskModeUndoDeps {
  /** Where schedules are kept. */
  store: TaskStore;
  /** Re-registers the schedule once its row changed. */
  registrar: Pick<TaskRegistrar, 'syncTask'>;
  /** The data directory, for the SKILL file. */
  dorkHome: string;
  /** Agents' folders; absent when Mesh is off. */
  meshCore?: MeshCore;
  /** Where the person's undo is recorded. */
  activity?: Pick<ActivityService, 'emit'>;
}

/**
 * Mount the undo route on the Tasks router.
 *
 * @param router - The Tasks router, mounted at `/api/tasks`.
 * @param deps - See {@link TaskModeUndoDeps}.
 */
export function mountTaskModeUndo(router: Hono<ApiEnv>, deps: TaskModeUndoDeps): void {
  // A person approving a changed SKILL file sits beside the Undo (M4).
  mountTaskFileApprove(router, deps);
  router.post('/:id/undo-agent-mode', async (c) => {
    const caller = honoRequestFacts(c);
    // The same refusal, word for word, as an agent naming permissionMode on PATCH.
    const refusal = operatorOnlyTaskRefusal({ permissionMode: true }, clearsTheAgentBar(caller));
    if (refusal) return c.json(refusal, 403);
    const existing = deps.store.getTask(c.req.param('id'));
    const previous = existing?.agentModeRecord?.previousMode;
    const wifiRefusal = previous
      ? wifiScheduleRefusal(caller, { permissionMode: previous }, existing)
      : undefined;
    if (wifiRefusal) return c.json(wifiRefusal, 403);

    const named = namedChangeOf(readJsonBody(c), c.req.param('id'));
    if (!named) return c.json(UNDO_NEEDS_ITS_NOTICE, 400);
    const outcome = await undoAgentModeChange(deps, c.req.param('id'), named, true);
    if (!outcome.ok) return c.json(outcome.body, outcome.status);
    const { task } = outcome;
    deps.registrar.syncTask(task.id);
    broadcastTasksChanged();
    deps.activity?.emit({
      ...readActivityActor(honoRequestFacts(c)),
      category: 'tasks',
      eventType: 'tasks.task_mode_changed',
      resourceType: 'schedule',
      resourceId: task.id,
      resourceLabel: task.displayName ?? task.name,
      summary: `Put scheduled task ${task.displayName ?? task.name} back to ${outcome.restored}`,
      linkPath: '/',
    });
    return c.json(task);
  });
}
