import type { CommunityWireInvitePending } from '@dorkos/shared/community-wire';
import { RequestError, request } from './api.js';

/** The pending join attempt a clean join URL resumes from its HttpOnly cookie. */
export type PendingAdmission = CommunityWireInvitePending;

/**
 * The single next step a failed join offers. Only `retry` is a button: the other two ask the
 * person to do something outside this page, so they are said in words rather than faked as
 * controls.
 */
export type AdmissionRecovery =
  'retry' | 'new-invitation' | 'reopen' | 'wait-for-room' | 'wait-for-release';

/** What the person reads when joining stops short of a membership. */
export type AdmissionFailure = {
  /** Always states plainly that membership was not added. */
  title: string;
  detail: string;
  recovery: AdmissionRecovery;
};

/** Where in the join the failure happened, and what already exists because of it. */
export type AdmissionFailureContext = {
  /** Checking the invitation link, before any join attempt exists. */
  phase: 'check' | 'join';
  /** This page just created the host account, and it stays even though joining failed. */
  accountCreated: boolean;
};

const NEW_INVITATION = 'Ask the person who invited you for a new invitation link.';
const REOPEN = 'Open your invitation link again in this browser.';
const WAIT_FOR_ROOM = 'Your invitation still works. Open it again once the owner has made room.';
const WAIT_FOR_RELEASE = 'Your invitation still works until it expires. Open it again then.';

/**
 * Explain a failed invitation step without revealing why an invitation is unusable.
 *
 * Every refused invitation reads the same, so a guessed or stolen link learns nothing. Two
 * reasons are shown, because the server itself reveals them only to a genuinely signed link: a
 * community closed to new members, and a community that is full. A full community is not a
 * dead link: the same invitation works again once there is room.
 */
export function describeAdmissionFailure(
  cause: unknown,
  context: AdmissionFailureContext
): AdmissionFailure {
  const title = context.accountCreated
    ? 'Your account was created, but membership was not added.'
    : 'Membership was not added.';
  if (cause instanceof RequestError) {
    // A hold keeps the invitation; it works again when the host releases the community.
    if (cause.status === 423 && cause.code === 'COMMUNITY_HELD')
      return {
        title,
        detail: 'This community is on hold. You can join when the hold ends.',
        recovery: 'wait-for-release',
      };
    if (cause.status === 409 && cause.code === 'MEMBER_LIMIT_REACHED')
      return { title, detail: cause.message, recovery: 'wait-for-room' };
    if (cause.status === 409 && cause.message === 'This community is closed to new members.')
      return { title, detail: cause.message, recovery: 'new-invitation' };
    if (cause.status === 403 && context.phase === 'join') {
      if (/another account/u.test(cause.message))
        return {
          title,
          detail:
            'This invitation was opened with a different account in this browser. Sign out, then open the link again with the account you want to join with.',
          recovery: 'reopen',
        };
      return {
        title,
        detail: 'This join attempt expired or can no longer be used.',
        recovery: 'reopen',
      };
    }
    if (cause.status === 403 || cause.status === 404 || cause.status === 409)
      return { title, detail: 'This invitation cannot be used.', recovery: 'new-invitation' };
  }
  const detail =
    cause instanceof RequestError && cause.status !== 0 && cause.status < 500
      ? cause.message
      : cause instanceof RequestError && cause.status === 0
        ? 'You appear to be offline. Check your connection.'
        : 'The community did not respond.';
  return { title, detail, recovery: 'retry' };
}

/** The sentence that tells the person what to do next for a recovery that is not a button. */
export function recoveryInstruction(recovery: AdmissionRecovery): string | null {
  if (recovery === 'new-invitation') return NEW_INVITATION;
  if (recovery === 'reopen') return REOPEN;
  if (recovery === 'wait-for-room') return WAIT_FOR_ROOM;
  if (recovery === 'wait-for-release') return WAIT_FOR_RELEASE;
  return null;
}

/**
 * Name what rejoining brings back and what it does not.
 *
 * Reactivation keeps the member's name and handle but never revives the machine authority or
 * channel memberships the member had before (02-specification.md, "Invitation model").
 */
export function reactivationScope(channelName: string | null): {
  restored: string[];
  notRestored: string[];
} {
  return {
    restored: [
      'Your name and handle in this community.',
      channelName ? `Access to #${channelName}, which this invitation includes.` : null,
    ].filter((line): line is string => line !== null),
    notRestored: [
      'Your role. You rejoin as a member.',
      channelName
        ? 'Other channels you were in before.'
        : 'Channels you were in before. You can join public channels again after you rejoin.',
      'Agents you added before, and their access.',
      'DorkOS installations you connected before. Connect each one again if you need it.',
    ],
  };
}

/**
 * Read back the live join attempt this browser's HttpOnly cookie holds.
 *
 * Returns null when there is none (never started, expired, used, or its invitation stopped
 * working); any other failure is the caller's to explain.
 */
export async function readPendingAdmission(): Promise<PendingAdmission | null> {
  try {
    return await request<PendingAdmission>('/api/v1/invites/pending');
  } catch (cause) {
    if (cause instanceof RequestError && cause.status === 403) return null;
    throw cause;
  }
}
