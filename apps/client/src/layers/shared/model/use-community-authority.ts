import { useSyncExternalStore } from 'react';
import {
  getCommunityAuthority,
  subscribeCommunityAuthority,
} from '../lib/community-authority-state';

/** Read the current confirmed local-owner authority generation. */
export function useCommunityAuthority() {
  return useSyncExternalStore(
    subscribeCommunityAuthority,
    getCommunityAuthority,
    getCommunityAuthority
  );
}
