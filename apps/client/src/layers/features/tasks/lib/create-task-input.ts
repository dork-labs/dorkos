/** Build the transport input for a schedule created from the task form. */
import type { CreateTaskInput, EffortLevel } from '@dorkos/shared/types';
import type { ScheduleFormValues } from '../ui/task-form-values';

/**
 * Turn new-schedule form values into the create request sent to the server.
 *
 * @param value - The current form values.
 * @param defaultTimezone - The browser zone used while the picker stays at its default.
 * @returns The create request, omitting fields the person did not choose.
 */
export function createTaskInput(
  value: ScheduleFormValues,
  defaultTimezone: () => string | null
): CreateTaskInput {
  const cron = value.cron.trim() || undefined;
  const timezone = value.timezone || defaultTimezone();
  return {
    name: value.name.trim(),
    description: value.description.trim() || value.name.trim(),
    prompt: value.prompt.trim(),
    target: value.agentId.trim() || 'global',
    cron,
    ...(cron && timezone ? { timezone } : {}),
    permissionMode: value.permissionMode,
    maxRuntime: value.maxRuntime.trim() || undefined,
    ...(value.sticky ? { sticky: true } : {}),
    ...(value.runtime ? { runtime: value.runtime } : {}),
    ...(value.model ? { model: value.model } : {}),
    ...(value.effort ? { effort: value.effort as EffortLevel } : {}),
  };
}
