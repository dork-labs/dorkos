import { useEffect } from 'react';
import { setBlockBuddiesEnabled } from '@/layers/shared/lib';
import { BLOCK_BUDDIES_EXPERIMENT } from '@/layers/shared/model';
import { useExperimentEnabledState } from './use-experiment-enabled';

/**
 * Tell every avatar what the Block Buddies experiment says (DOR-3065), once the
 * config has answered. `IdentityAvatar` sits in `shared/ui` and cannot read the
 * config itself. The app shell runs this once.
 */
export function useBlockBuddiesSync(): void {
  const { enabled, isLoading } = useExperimentEnabledState(BLOCK_BUDDIES_EXPERIMENT);
  useEffect(() => {
    if (!isLoading) setBlockBuddiesEnabled(enabled);
  }, [enabled, isLoading]);
}
