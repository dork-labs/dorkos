import { readStorage, writeStorage } from '../remembered-community.js';

declare global {
  interface Window {
    __readDorkosOwnerReplacementFragment?: () => string | null;
    __clearDorkosOwnerReplacementFragment?: () => void;
  }
}

/** The page the owner's emailed link opens: it can only keep ownership. */
export const KEEP_OWNERSHIP_PATH = '/keep-ownership';
/** The page the new owner's claim link opens. */
export const OWNER_REPLACEMENT_CLAIM_PATH = '/owner-replacement';

/**
 * Read the token the page's inline bootstrap took from the link fragment, if any. The bootstrap
 * has already erased it from the address bar, so it lives only in page memory.
 */
export function readReplacementFragment(): string | null {
  return window.__readDorkosOwnerReplacementFragment?.() ?? null;
}

/** Erase the captured token from page memory; the server has what it needs by now. */
export function clearReplacementFragment(): void {
  window.__clearDorkosOwnerReplacementFragment?.();
}

const PENDING_KEY = 'communityOwnerReplacementPending';
/** The claim preflight's HTTP-only cookie lasts thirty minutes on the server. */
const PENDING_LIFETIME_MS = 30 * 60_000;

/**
 * What a reload or a sign-in round trip needs to resume a claim this browser preflighted. The
 * claim itself rides in the server's HTTP-only cookie; this never holds the token.
 */
export type PendingReplacementClaim = {
  communityId: string;
  communityName: string;
  requiresSingleSignOn: boolean;
  resumeUntil: string;
};

/** Remember a preflighted claim for up to thirty minutes, never past its claim window. */
export function rememberPendingReplacementClaim(
  claim: Omit<PendingReplacementClaim, 'resumeUntil'> & { claimExpiresAt: string | null },
  now = Date.now()
): void {
  const until = Math.min(
    now + PENDING_LIFETIME_MS,
    claim.claimExpiresAt ? Date.parse(claim.claimExpiresAt) : Infinity
  );
  const value: PendingReplacementClaim = {
    communityId: claim.communityId,
    communityName: claim.communityName,
    requiresSingleSignOn: claim.requiresSingleSignOn,
    resumeUntil: new Date(until).toISOString(),
  };
  writeStorage(() => sessionStorage, PENDING_KEY, JSON.stringify(value));
}

/** Validate a stored marker without trusting its shape. */
export function parsePendingReplacementClaim(
  raw: string | null,
  now = Date.now()
): PendingReplacementClaim | null {
  if (!raw) return null;
  try {
    const value = JSON.parse(raw) as Partial<PendingReplacementClaim>;
    if (
      typeof value.communityId !== 'string' ||
      !/^[0-9a-f-]{36}$/iu.test(value.communityId) ||
      typeof value.communityName !== 'string' ||
      !value.communityName ||
      typeof value.requiresSingleSignOn !== 'boolean' ||
      typeof value.resumeUntil !== 'string'
    )
      return null;
    const until = Date.parse(value.resumeUntil);
    if (!Number.isFinite(until) || until <= now) return null;
    return {
      communityId: value.communityId,
      communityName: value.communityName,
      requiresSingleSignOn: value.requiresSingleSignOn,
      resumeUntil: value.resumeUntil,
    };
  } catch {
    return null;
  }
}

/** A still-live marker, discarding a stale or malformed one. */
export function readPendingReplacementClaim(now = Date.now()): PendingReplacementClaim | null {
  const raw = readStorage(() => sessionStorage, PENDING_KEY);
  const pending = parsePendingReplacementClaim(raw, now);
  if (raw && !pending) forgetPendingReplacementClaim();
  return pending;
}

/** Drop the marker once the claim finishes or can no longer succeed. */
export function forgetPendingReplacementClaim(): void {
  writeStorage(() => sessionStorage, PENDING_KEY, null);
}

const DISMISSED_KEY = 'communityOwnerReplacementCompletionDismissed';

/** One completion notice per community and completion, so a later change shows again. */
function dismissedKey(communityId: string, completedAt: string): string {
  return `${DISMISSED_KEY}:${communityId}:${completedAt}`;
}

/**
 * Whether this browser dismissed the notice that the community has a new owner. A convenience
 * only: without storage the notice simply shows again, which is the safe side.
 */
export function completionNoticeDismissed(
  communityId: string,
  completedAt: string,
  storage: () => Storage = () => localStorage
): boolean {
  return readStorage(storage, dismissedKey(communityId, completedAt)) === '1';
}

/** Remember in this browser that the completion notice was dismissed. */
export function dismissCompletionNotice(
  communityId: string,
  completedAt: string,
  storage: () => Storage = () => localStorage
): void {
  writeStorage(storage, dismissedKey(communityId, completedAt), '1');
}
