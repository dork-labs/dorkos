/**
 * Every sentence the hosted-community surfaces say about a state, in one place.
 *
 * The service's own words (a problem's `title` and `detail`, a community's
 * `notice`) are shown as given and never live here. What lives here is what
 * the app says about the mechanism: a lifecycle state, a hold, a failed move.
 * Each has a line for a value this release does not know (`unrecognised`), so a
 * newer service never leaves the app with nothing to say.
 *
 * @module features/community-hosting/model/hosting-copy
 */
import {
  CommunityShortNameSchema,
  type CommunityMoveFailureCode,
  type HostedCommunity,
} from '@dork-labs/cloud-api';
import type { CloudCommunityAllowance } from '@dorkos/shared/cloud-schemas';

/** A value this release does not know, as tolerant enums deliver it. */
type Unrecognised = 'unrecognised';

/** What the app says about a failed move: what happened, then what to do. */
export interface MoveFailureCopy {
  title: string;
  next: string;
}

/**
 * One plain sentence per failure, with the next step.
 *
 * @param code - The move's failure code.
 */
export function moveFailureCopy(code: CommunityMoveFailureCode | Unrecognised): MoveFailureCopy {
  switch (code) {
    case 'not_owner_export':
      return {
        title: 'This file is a personal export, not an owner export.',
        next: 'Sign in to the old community as its owner, export it from Settings, then try again.',
      };
    case 'archive_invalid':
      return {
        title: 'This file is damaged, or it isn’t a community export.',
        next: 'Export the old community again, then try again.',
      };
    case 'checksum_mismatch':
      return {
        title: 'Part of this export is damaged.',
        next: 'Export the old community again, then try again.',
      };
    case 'version_unsupported':
      return {
        title: 'This export comes from a version the new host can’t read.',
        next: 'Update the old community, export it again, then try again.',
      };
    case 'too_large':
      return {
        title: 'This export is too large to move.',
        next: 'Delete some large files in the old community, export it again, then try again.',
      };
    case 'storage_limit_reached':
      return {
        title: 'The files don’t fit in the new community’s file space.',
        next: 'Delete some files in the old community, export it again, then try again.',
      };
    case 'upload_expired':
      return {
        title: 'The file didn’t arrive before the upload window closed.',
        next: 'Start the move again.',
      };
    case 'storage_unavailable':
      return {
        title: 'The new host couldn’t store the files just now.',
        next: 'Wait a little while, then start the move again.',
      };
    default:
      return {
        title: 'The move stopped for a reason this version of DorkOS doesn’t know.',
        next: 'Update DorkOS to see more, or start the move again.',
      };
  }
}

/**
 * A short label for where a hosted community is.
 *
 * @param state - The community's state.
 */
export function communityStateLabel(state: HostedCommunity['state']): string {
  switch (state) {
    case 'provisioning':
      return 'Being set up';
    case 'pending_owner':
      return 'Waiting for its owner';
    case 'active':
      return 'Open';
    case 'archived':
      return 'Archived';
    case 'held':
      return 'On hold';
    case 'suspended':
      return 'Suspended';
    case 'deletion_pending':
      return 'Being deleted';
    default:
      return 'Unknown state';
  }
}

/**
 * Why a community is on hold, and what the owner can do about it.
 *
 * @param reason - The hold's reason.
 */
export function holdReasonCopy(reason: NonNullable<HostedCommunity['hold']>['reason']): string {
  switch (reason) {
    case 'over_limit':
      return 'Your account has more communities than it allows. Choose which ones stay open.';
    case 'inactive':
      return 'Nobody has posted here in a long time. You can reopen it.';
    case 'host':
      return 'The host put this community on hold. People can still read it.';
    default:
      return 'This community is on hold for a reason this version of DorkOS doesn’t know.';
  }
}

/**
 * A date a person reads, in their own locale, without a time.
 *
 * Read in UTC: the service sets these as whole days, and a local reading
 * would show a hold that began on August 1 as July 31 west of Greenwich.
 *
 * @param iso - An ISO timestamp.
 */
export function formatDay(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return date.toLocaleDateString(undefined, {
    year: 'numeric',
    month: 'long',
    day: 'numeric',
    timeZone: 'UTC',
  });
}

/**
 * A byte count a person reads ("48 MB").
 *
 * @param bytes - A non-negative count.
 */
export function formatBytes(bytes: number): string {
  const units = ['bytes', 'KB', 'MB', 'GB', 'TB'];
  let value = bytes;
  let unit = 0;
  while (value >= 1000 && unit < units.length - 1) {
    value /= 1000;
    unit++;
  }
  const rounded = unit === 0 || value >= 10 ? Math.round(value) : Math.round(value * 10) / 10;
  return `${rounded} ${units[unit]}`;
}

/**
 * What to say about how many more communities the account can start, or
 * `null` when the service did not send both numbers.
 *
 * @param allowance - The account's allowance, when known.
 */
export function allowanceCopy(allowance: CloudCommunityAllowance | null): string | null {
  if (allowance?.maxCommunities == null || allowance.usedCommunities == null) return null;
  const left = allowance.maxCommunities - allowance.usedCommunities;
  if (left <= 0) return 'Your account has no room for another community right now.';
  return `You can start ${left} more ${left === 1 ? 'community' : 'communities'}.`;
}

/** The web address grammar, said plainly. Shown under the field as a hint. */
export const WEB_ADDRESS_HINT =
  'Lower-case letters, numbers and single hyphens. 3 to 32 characters, starting with a letter.';

/**
 * Fold what a person typed into a web address, or say why it cannot be one.
 *
 * Empty is allowed: the web address is optional.
 *
 * @param raw - What was typed.
 * @returns The folded name (`''` when empty) and whether it obeys the grammar.
 */
export function readWebAddress(raw: string): { value: string; valid: boolean } {
  const value = raw.trim().toLowerCase();
  if (value === '') return { value, valid: true };
  return { value, valid: CommunityShortNameSchema.safeParse(value).success };
}

/** The longest community name the service accepts. */
export const COMMUNITY_NAME_MAX = 80;
