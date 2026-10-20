/**
 * Schedules from Wi-Fi run at Default at most (DOR-3037).
 *
 * A turn started from Wi-Fi is held to the runtime's default level. A schedule
 * set, armed, edited or run from Wi-Fi would start turns later with no such
 * hold, so from Wi-Fi:
 *
 * - a new schedule that names no mode is made at Default rather than at the
 *   level the operator's trust stop would give it;
 * - naming a mode above Default, approving or editing a schedule that runs
 *   above Default, or running one now, is refused. Pausing one stays allowed,
 *   and so does lowering its mode.
 *
 * A schedule's mode is judged against the modes its runtime declares
 * (`capabilitiesForTaskRuntime`, as its runs resolve them), through the same
 * ordering every other Wi-Fi check uses (`modeRaises`). With no runtime to ask,
 * only Default and Plan count as not above Default.
 *
 * @module routes/task-wifi-guard
 */
import type { Task } from '@dorkos/shared/schemas';
import type { RequestFacts } from '../http/request-facts.js';
import { capabilitiesForTaskRuntime } from '../services/tasks/scheduled-run-power.js';
import { isFromWifi } from '../services/core/auth/sessions/wifi-level.js';
import { modeRaises, wifiRaiseRefusal } from '../services/core/auth/sessions/wifi-raise-guard.js';

/** The Default mode id a schedule made from Wi-Fi gets when it names none. */
const DEFAULT_MODE_ID = 'default';

/** Whether a schedule's mode runs above Default on its runtime. An unknown one does. */
function aboveDefault(mode: string, runtime: string | null | undefined): boolean {
  const declared = capabilitiesForTaskRuntime(runtime)?.permissionModes;
  if (!declared) return mode !== DEFAULT_MODE_ID && mode !== 'plan';
  return modeRaises(declared, DEFAULT_MODE_ID, mode);
}

/** The fields of a schedule write that only pause it. */
const PAUSE_ONLY_FIELDS = new Set(['enabled', 'status']);

/** Whether a write only pauses a schedule. */
function onlyPauses(body: Record<string, unknown>): boolean {
  return Object.entries(body).every(
    ([key, value]) =>
      PAUSE_ONLY_FIELDS.has(key) &&
      ((key === 'enabled' && value === false) || (key === 'status' && value === 'paused'))
  );
}

/**
 * The refusal for a schedule write from Wi-Fi that would run above Default, or
 * `undefined` when it may go on. A new schedule that names no mode is given
 * Default here, in the body the route goes on to read.
 *
 * @param caller - The request facts.
 * @param body - The raw request body; a create's may gain `permissionMode`.
 * @param existing - The schedule an edit changes; absent for a create.
 */
export function wifiScheduleRefusal(
  caller: RequestFacts,
  body: unknown,
  existing?: Pick<Task, 'permissionMode' | 'runtime'>
): ReturnType<typeof wifiRaiseRefusal> | undefined {
  if (!isFromWifi(caller) || typeof body !== 'object' || body === null) return undefined;
  const fields = body as Record<string, unknown>;
  const named = typeof fields.permissionMode === 'string' ? fields.permissionMode : undefined;
  if (!existing && named === undefined) {
    fields.permissionMode = DEFAULT_MODE_ID;
    return undefined;
  }
  const mode = named ?? existing?.permissionMode ?? DEFAULT_MODE_ID;
  const runtime = typeof fields.runtime === 'string' ? fields.runtime : existing?.runtime;
  if (!aboveDefault(mode, runtime)) return undefined;
  return existing && named === undefined && onlyPauses(fields) ? undefined : wifiRaiseRefusal();
}

/**
 * The refusal for running a schedule now from Wi-Fi when it runs above
 * Default, or `undefined` when it may run.
 *
 * @param caller - The request facts.
 * @param task - The schedule, when it exists.
 */
export function wifiRunNowRefusal(
  caller: RequestFacts,
  task: Pick<Task, 'permissionMode' | 'runtime'> | undefined
): ReturnType<typeof wifiRaiseRefusal> | undefined {
  if (!task || !isFromWifi(caller)) return undefined;
  if (!aboveDefault(task.permissionMode, task.runtime)) return undefined;
  return wifiRaiseRefusal();
}
