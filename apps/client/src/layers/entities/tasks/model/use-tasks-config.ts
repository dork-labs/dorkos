import { useFeatureEnabled, useFeatureEnabledState } from '@/layers/shared/model';
import type { FeatureEnabledState } from '@/layers/shared/model';

/** Fetch server config and derive whether the Tasks scheduler is enabled. */
export function useTasksEnabled(): boolean {
  return useFeatureEnabled('tasks');
}

/**
 * The same answer, with the config read's own pending state beside it.
 *
 * For the one caller that gates a QUERY on it: a query disabled while the
 * config is still in flight reports `isLoading: false`, so "no schedules" and
 * "we have not looked yet" become the same value — and anything watching for
 * arrivals then treats every schedule that was already parked as newly arrived
 * (DOR-1391). See {@link FeatureEnabledState.isLoading}.
 */
export function useTasksEnabledState(): FeatureEnabledState {
  return useFeatureEnabledState('tasks');
}
