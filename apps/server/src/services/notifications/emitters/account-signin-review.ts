/**
 * Say a Claude sign-in is new or changed, once, as a notice (DOR-3245). A
 * changed one also leaves one line in Activity, `account.login_changed`, so
 * the history keeps it after the notice is gone. Neither holds the turn.
 *
 * @module services/notifications/emitters/account-signin-review
 */
import path from 'node:path';
import type { ActivityService } from '../../activity/activity-service.js';
import { configManager } from '../../core/config-manager.js';
import {
  setAccountLoginNoticeSink,
  type AccountLoginNotice,
} from '../../runtimes/claude-code/accounts/account-login-metadata.js';
import { notify } from '../notification-service.js';

/**
 * Install the sink the launch check tells about new and changed sign-ins.
 *
 * @param activity - The Activity feed writer, when the server has one.
 * @returns A function that uninstalls it.
 */
export function watchAccountSigninReviews(activity: ActivityService | undefined): () => void {
  setAccountLoginNoticeSink((notice) => {
    const accountName = accountNameOf(notice.accountRoot);
    void notify('account.signin_review', { ...notice, accountName });
    if (notice.change === 'changed') recordLoginChanged(activity, notice, accountName);
  });
  return () => setAccountLoginNoticeSink(null);
}

/** The one Activity line for a changed sign-in: masked emails, and whether the org changed. */
function recordLoginChanged(
  activity: ActivityService | undefined,
  notice: AccountLoginNotice,
  accountName: string
): void {
  if (!activity) return;
  const from = notice.previousEmail ?? 'an earlier sign-in';
  const to = notice.email ?? 'another sign-in';
  void activity
    .emit({
      actorType: 'system',
      actorLabel: 'DorkOS',
      category: 'system',
      eventType: 'account.login_changed',
      resourceType: 'account',
      resourceId: notice.fingerprint,
      summary: `${accountName}'s Claude sign-in changed from ${from} to ${to}${
        notice.orgChanged ? ', in another organization' : ''
      }`,
      metadata: {
        accountName,
        previousEmail: notice.previousEmail ?? null,
        email: notice.email ?? null,
        orgChanged: notice.orgChanged === true,
      },
    })
    .catch(() => undefined);
}

/** The person's name for the folder, never anything read from inside it. */
function accountNameOf(root: string): string {
  try {
    const row = configManager
      .get('runtimes')
      ?.claudeCode?.accounts.find((a) => path.resolve(a.path) === path.resolve(root));
    if (row?.label) return row.label;
  } catch {
    /* A missing config must not suppress the notice. */
  }
  return path.basename(root) === '.claude' ? 'Main' : path.basename(root);
}
