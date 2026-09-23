declare global {
  interface Window {
    __readDorkosOwnerClaimFragment?: () => string | null;
    __clearDorkosOwnerClaimFragment?: () => void;
  }
}

/** The host-level browser route where an intended owner redeems an owner claim. */
export const OWNER_CLAIM_PATH = '/claim';

const PENDING_KEY = 'communityOwnerClaimPending';
/** Preflight's HTTP-only claim cookie lasts thirty minutes on the server. */
const PENDING_LIFETIME_MS = 30 * 60_000;

/** Non-secret marker that lets a reload or sign-in callback resume a preflighted claim. */
export type PendingOwnerClaim = { communityId: string; resumeUntil: string };

/**
 * Build the link a host administrator hands to the intended owner.
 *
 * The secret rides in the fragment, which browsers never send to the server, and the page's
 * inline bootstrap erases it from the address bar before any module or network work starts.
 */
export function ownerClaimLink(origin: string, token: string): string {
  return `${origin}${OWNER_CLAIM_PATH}#claim=${encodeURIComponent(token)}`;
}

/**
 * Accept either a full owner-claim link or the bare secret pasted into the claim form.
 *
 * Returns null when nothing usable was entered.
 */
export function parseOwnerClaimInput(value: string): string | null {
  const trimmed = value.trim();
  if (!trimmed) return null;
  const hash = trimmed.indexOf('#');
  if (hash === -1) return /^[\w-]+$/u.test(trimmed) ? trimmed : null;
  const claim = new URLSearchParams(trimmed.slice(hash + 1)).get('claim')?.trim();
  return claim ? claim : null;
}

/** Read the secret the inline bootstrap captured from the link fragment, if any. */
export function readOwnerClaimFragment(): string | null {
  return window.__readDorkosOwnerClaimFragment?.() ?? null;
}

/** Erase the captured secret from page memory once the server has exchanged it. */
export function clearOwnerClaimFragment(): void {
  window.__clearDorkosOwnerClaimFragment?.();
}

/** Remember which pending community this browser preflighted; never the secret itself. */
export function rememberPendingOwnerClaim(
  communityId: string,
  claimExpiresAt: string,
  now = Date.now()
): void {
  const resumeUntil = Math.min(now + PENDING_LIFETIME_MS, Date.parse(claimExpiresAt));
  const value: PendingOwnerClaim = {
    communityId,
    resumeUntil: new Date(resumeUntil).toISOString(),
  };
  try {
    sessionStorage.setItem(PENDING_KEY, JSON.stringify(value));
  } catch {
    /* Without storage, a reload asks for the link again. */
  }
}

/** Read a still-live pending claim marker, discarding stale or malformed values. */
export function readPendingOwnerClaim(now = Date.now()): PendingOwnerClaim | null {
  let raw: string | null;
  try {
    raw = sessionStorage.getItem(PENDING_KEY);
  } catch {
    return null;
  }
  const pending = parsePendingOwnerClaim(raw, now);
  if (raw && !pending) forgetPendingOwnerClaim();
  return pending;
}

/** Validate a stored marker without trusting its shape. */
export function parsePendingOwnerClaim(raw: string | null, now = Date.now()) {
  if (!raw) return null;
  try {
    const value = JSON.parse(raw) as Partial<PendingOwnerClaim>;
    if (typeof value.communityId !== 'string' || typeof value.resumeUntil !== 'string') return null;
    if (!/^[0-9a-f-]{36}$/iu.test(value.communityId)) return null;
    const until = Date.parse(value.resumeUntil);
    if (!Number.isFinite(until) || until <= now) return null;
    return { communityId: value.communityId, resumeUntil: value.resumeUntil };
  } catch {
    return null;
  }
}

/** Drop the pending marker after a claim finishes or can no longer succeed. */
export function forgetPendingOwnerClaim(): void {
  try {
    sessionStorage.removeItem(PENDING_KEY);
  } catch {
    /* Nothing to clear. */
  }
}
