import { useFeatureEnabled, useFeatureEnabledState } from '@/layers/shared/model';
import type { FeatureEnabledState } from '@/layers/shared/model';

/**
 * Whether the server has to-dos switched on (`DORKOS_TODOS_ENABLED`). An older server that does
 * not report it reads as off.
 */
export function useTodosEnabled(): boolean {
  return useFeatureEnabled('todos');
}

/**
 * The same answer, with the config read's own pending state beside it, for the page that must
 * not show "To-dos is off" before the config has answered.
 */
export function useTodosEnabledState(): FeatureEnabledState {
  return useFeatureEnabledState('todos');
}
