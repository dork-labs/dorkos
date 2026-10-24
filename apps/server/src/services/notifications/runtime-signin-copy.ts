import { runtimeDisplayName } from '@dorkos/shared/agent-runtime';
import type { NotificationPayload } from './notification-registry.js';

/** Account-aware wording for the immutable raise and recovery history rows. */
export function runtimeSigninTitle(p: NotificationPayload<'signin.required'>): string {
  const name = p.accountName ?? runtimeDisplayName(p.runtime);
  if (!p.clearedAt) return `Your ${name} sign-in stopped working`;
  return p.closedAtBoot
    ? `DorkOS restarted while your ${name} sign-in was broken`
    : `Your ${name} sign-in is working again`;
}

/** Distinguish an orphaned episode from proof that a credential works. */
export function runtimeSigninBody(p: NotificationPayload<'signin.required'>): string | undefined {
  if (!p.clearedAt) return 'Its tasks and replies wait until you sign in.';
  return p.closedAtBoot ? 'Sign in again if it still needs you.' : undefined;
}
