import { useFeatureEnabled, useFeatureEnabledState } from '@/layers/shared/model';
import type { FeatureEnabledState } from '@/layers/shared/model';

/** Fetch server config and derive whether the Relay message bus is enabled. */
export function useRelayEnabled(): boolean {
  return useFeatureEnabled('relay');
}

/** Fetch Relay's running state without treating an unanswered config read as disabled. */
export function useRelayEnabledState(): FeatureEnabledState {
  return useFeatureEnabledState('relay');
}
