/**
 * The app's Community watchers, mounted once in the shell.
 *
 * @module app/use-community-watchers
 */
import {
  useCommunityApprovalWatcher,
  useCommunityConnectionsSync,
  useCommunityOwnerNoticeAnnouncer,
} from '@/layers/entities/community';
import { useCommunityRevocationCleanup } from './use-community-revocation-cleanup';

/**
 * Run every Community watcher that must not depend on what is on screen.
 *
 * - A Community that stops being connected is erased and routed away from,
 *   whichever surface is showing it.
 * - The connection list is re-read the moment the server says a connection
 *   changed, so that cleanup runs within seconds instead of on the next poll.
 * - Every pending connection is checked, because checking is what finishes
 *   its pairing: it cannot wait for a dialog to be open or a sidebar drawn.
 * - A request to replace the person as a community's owner is announced once
 *   when it first shows, and once when it completes, whatever is on screen.
 */
export function useCommunityWatchers(): void {
  useCommunityRevocationCleanup();
  useCommunityConnectionsSync();
  useCommunityApprovalWatcher();
  useCommunityOwnerNoticeAnnouncer();
}
