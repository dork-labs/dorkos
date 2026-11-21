/**
 * Signing a device in over Wi-Fi with a one-time code from this computer
 * (DOR-4744).
 *
 * Over Wi-Fi a device never types the owner's password. Instead:
 *
 * 1. **The device asks.** It starts a sign-in request, keeps the request's
 *    secret id, and shows a short match code ({@link startWifiSignIn}).
 *    Nothing is approved yet.
 * 2. **The owner approves at this computer.** The request shows in the app at
 *    this computer, with the device's name, when it asked and the same match
 *    code, under a second, separate id. The owner approves only the request
 *    whose code matches the one on the device. Approving it makes a one-time
 *    code bound to that one request ({@link approveWifiSignIn}), and the app
 *    shows it.
 * 3. **The device types the code.** The code signs in only the request it was
 *    made for, once, within {@link WIFI_SIGN_IN_CODE_TTL_MS}
 *    ({@link redeemWifiSignIn}). The sign-in it makes is an ordinary Wi-Fi
 *    sign-in, held to the Wi-Fi level.
 *
 * Everything is kept in memory and as hashes: a request id and a code are
 * never stored as themselves. A restart drops every open request.
 *
 * Limits: a request lives {@link WIFI_SIGN_IN_REQUEST_TTL_MS}; at most
 * {@link MAX_OPEN_REQUESTS} are open at once; one address may start
 * {@link MAX_STARTS_PER_ADDRESS} per {@link START_WINDOW_MS}; a request survives
 * {@link MAX_MISSES_PER_REQUEST} wrong codes; the listener as a whole takes
 * {@link MAX_MISSES_PER_WINDOW} wrong codes per {@link MISS_WINDOW_MS}.
 *
 * A code typed for the wrong request ends the request it was made for too, so
 * a code only ever works on the one device it was approved for.
 *
 * Every refusal reads the same, so a caller cannot tell an unknown id from an
 * expired or used one.
 *
 * @module services/core/auth/sessions/wifi-sign-in-requests
 */
import { createHash, randomBytes, randomInt, timingSafeEqual } from 'node:crypto';

/** How long a device's request waits for approval: 5 minutes. */
export const WIFI_SIGN_IN_REQUEST_TTL_MS = 5 * 60 * 1000;

/** How long an approved code may be typed: 5 minutes from approval, never past the request. */
export const WIFI_SIGN_IN_CODE_TTL_MS = 5 * 60 * 1000;

/** Most requests open at once on this computer. */
export const MAX_OPEN_REQUESTS = 5;

/**
 * Most requests one address may have open at once. A new one from the same
 * address ends the one before, so one device cannot fill every open slot.
 */
export const MAX_OPEN_PER_ADDRESS = 1;

/** Most requests one address may start per window. */
export const MAX_STARTS_PER_ADDRESS = 5;

/** The window {@link MAX_STARTS_PER_ADDRESS} counts over. */
export const START_WINDOW_MS = 15 * 60 * 1000;

/** Wrong codes one request survives. */
export const MAX_MISSES_PER_REQUEST = 5;

/** Wrong codes the Wi-Fi listener takes per window, across every request. */
export const MAX_MISSES_PER_WINDOW = 20;

/** The window {@link MAX_MISSES_PER_WINDOW} counts over. */
export const MISS_WINDOW_MS = 15 * 60 * 1000;

/** Characters a code is made of: no 0/O, 1/I/L, so it reads aloud and types cleanly. */
const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';

/**
 * Code length: 6 characters, about 29 bits, shown as two groups of three. Short
 * enough to type, and the miss limits below leave a guesser nowhere near it.
 */
export const WIFI_SIGN_IN_CODE_LENGTH = 6;

/** Match code length: 4 characters, enough to tell two requests apart by eye. */
export const WIFI_SIGN_IN_MATCH_LENGTH = 4;

/** What the app at this computer shows about one open request. Never its secret. */
export interface WifiSignInRequestView {
  /** The id the app approves or declines it by. Not the device's secret. */
  readonly id: string;
  /** What the device says it is ("Safari on iPhone"). A label, never a check. */
  readonly deviceName: string;
  /** The address it asked from on this network. */
  readonly address: string;
  /** When it asked (ISO 8601). */
  readonly requestedAt: string;
  /** When it stops waiting (ISO 8601). */
  readonly expiresAt: string;
  /** The short code the device shows, to match before approving. */
  readonly matchCode: string;
  /** Whether a code was already shown for it. */
  readonly approved: boolean;
}

/** Why a code did not sign in. The device reads one sentence for all of them. */
export type WifiSignInRefusal = 'refused' | 'too-many-tries';

interface OpenRequest {
  /** SHA-256 of the device's secret request id. */
  secretHash: Buffer;
  /** The id the app at this computer names it by. */
  viewId: string;
  deviceName: string;
  address: string;
  requestedAt: number;
  expiresAt: number;
  matchCode: string;
  /** Set once approved: who it signs in, the code's hash, when the code ends. */
  approval: { userId: string; codeHash: Buffer; expiresAt: number } | null;
  misses: number;
}

/** Open requests by view id. */
const open = new Map<string, OpenRequest>();
/** Start times per address, for {@link MAX_STARTS_PER_ADDRESS}. */
const starts = new Map<string, number[]>();
/** Times of wrong codes on the listener, for {@link MAX_MISSES_PER_WINDOW}. */
let misses: number[] = [];

/** SHA-256 of a secret, so the secret itself is never held. */
function hash(value: string): Buffer {
  return createHash('sha256').update(value, 'utf8').digest();
}

/** A fresh code from {@link CODE_ALPHABET}. */
function newCode(length = WIFI_SIGN_IN_CODE_LENGTH): string {
  let code = '';
  for (let i = 0; i < length; i += 1) {
    code += CODE_ALPHABET[randomInt(CODE_ALPHABET.length)];
  }
  return code;
}

/** A code as typed, made comparable: case, spaces and dashes ignored. */
export function normalizeWifiSignInCode(typed: string): string {
  return typed.toUpperCase().replace(/[\s-]/g, '');
}

/** Drop what has expired. */
function sweep(now: number): void {
  for (const [id, request] of open) {
    const ends = request.approval ? Math.min(request.approval.expiresAt, request.expiresAt) : 0;
    if (now >= request.expiresAt || (request.approval && now >= ends)) open.delete(id);
  }
  for (const [address, times] of starts) {
    const kept = times.filter((at) => now - at < START_WINDOW_MS);
    if (kept.length === 0) starts.delete(address);
    else starts.set(address, kept);
  }
  misses = misses.filter((at) => now - at < MISS_WINDOW_MS);
}

/** The open request a device's secret names, or `undefined`. */
function bySecret(secret: string): OpenRequest | undefined {
  const wanted = hash(secret);
  for (const request of open.values()) {
    if (timingSafeEqual(request.secretHash, wanted)) return request;
  }
  return undefined;
}

/** What {@link startWifiSignIn} needs to know about the device. */
export interface WifiSignInStart {
  /** The device's name, from its user agent. */
  readonly deviceName: string;
  /** Its address on this network. */
  readonly address: string;
}

/**
 * Start a sign-in request for a device on Wi-Fi.
 *
 * @param device - See {@link WifiSignInStart}.
 * @param now - The current time, for tests.
 * @returns The request's secret id, its match code and when it stops waiting, or `null` when
 *   too many are open or this address has started too many.
 */
export function startWifiSignIn(
  device: WifiSignInStart,
  now = Date.now()
): { requestId: string; matchCode: string; expiresAt: string } | null {
  sweep(now);
  const recent = starts.get(device.address) ?? [];
  if (recent.length >= MAX_STARTS_PER_ADDRESS) return null;
  const mine = [...open.values()].filter((request) => request.address === device.address);
  if (open.size - mine.length >= MAX_OPEN_REQUESTS) return null;
  // Asking again from the same address replaces the request it had open.
  for (const request of mine) open.delete(request.viewId);
  starts.set(device.address, [...recent, now]);
  // 256 bits for the device's secret, 128 for the id the app shows.
  const requestId = randomBytes(32).toString('base64url');
  const viewId = randomBytes(16).toString('base64url');
  const expiresAt = now + WIFI_SIGN_IN_REQUEST_TTL_MS;
  const matchCode = newCode(WIFI_SIGN_IN_MATCH_LENGTH);
  open.set(viewId, {
    secretHash: hash(requestId),
    viewId,
    deviceName: device.deviceName,
    address: device.address,
    requestedAt: now,
    expiresAt,
    matchCode,
    approval: null,
    misses: 0,
  });
  return { requestId, matchCode, expiresAt: new Date(expiresAt).toISOString() };
}

/**
 * The open requests, newest first, for the app at this computer.
 *
 * @param now - The current time, for tests.
 */
export function listWifiSignInRequests(now = Date.now()): WifiSignInRequestView[] {
  sweep(now);
  return [...open.values()]
    .sort((a, b) => b.requestedAt - a.requestedAt)
    .map((request) => ({
      id: request.viewId,
      deviceName: request.deviceName,
      address: request.address,
      requestedAt: new Date(request.requestedAt).toISOString(),
      expiresAt: new Date(request.expiresAt).toISOString(),
      matchCode: request.matchCode,
      approved: request.approval !== null,
    }));
}

/**
 * Approve one open request for an account and make its one-time code. Callers
 * check that a person at this computer is asking first (`routes/devices.ts`).
 * A request is approved once: approving it again is refused like an unknown one.
 *
 * @param viewId - The request's id from {@link listWifiSignInRequests}.
 * @param userId - The account it signs in.
 * @param now - The current time, for tests.
 * @returns The code to show, and when it stops working, or `null`.
 */
export function approveWifiSignIn(
  viewId: string,
  userId: string,
  now = Date.now()
): { code: string; expiresAt: string } | null {
  sweep(now);
  const request = open.get(viewId);
  if (!request || request.approval) return null;
  const code = newCode();
  const expiresAt = Math.min(now + WIFI_SIGN_IN_CODE_TTL_MS, request.expiresAt);
  request.approval = { userId, codeHash: hash(code), expiresAt };
  return { code, expiresAt: new Date(expiresAt).toISOString() };
}

/**
 * Decline one open request: it is gone, and no code can sign it in.
 *
 * @param viewId - The request's id from {@link listWifiSignInRequests}.
 * @returns Whether an open request was declined.
 */
export function declineWifiSignIn(viewId: string): boolean {
  return open.delete(viewId);
}

/**
 * Trade a request's code for the account it signs in. Good once, only for the
 * request it was made for, and only before it expires.
 *
 * @param requestId - The device's secret request id.
 * @param typed - The code as the person typed it.
 * @param now - The current time, for tests.
 * @returns The account to sign in, or why not.
 */
export function redeemWifiSignIn(
  requestId: string,
  typed: string,
  now = Date.now()
): { userId: string } | { refusal: WifiSignInRefusal } {
  sweep(now);
  const typedHash = hash(normalizeWifiSignInCode(typed));
  const request = bySecret(requestId);
  // A right code for its own request works even while others are guessing:
  // the limit below holds wrong codes back, never the person with the right one.
  if (request?.approval && timingSafeEqual(typedHash, request.approval.codeHash)) {
    open.delete(request.viewId);
    return { userId: request.approval.userId };
  }
  if (misses.length >= MAX_MISSES_PER_WINDOW) return { refusal: 'too-many-tries' };
  // A code made for another request ends that request too (see the module doc).
  for (const other of open.values()) {
    if (
      other !== request &&
      other.approval &&
      timingSafeEqual(typedHash, other.approval.codeHash)
    ) {
      open.delete(other.viewId);
    }
  }
  misses.push(now);
  if (!request?.approval) return { refusal: 'refused' };
  request.misses += 1;
  if (request.misses >= MAX_MISSES_PER_REQUEST) {
    open.delete(request.viewId);
    return { refusal: 'too-many-tries' };
  }
  return { refusal: 'refused' };
}

/**
 * Forget every request and count. Tests only.
 *
 * @internal
 */
export function resetWifiSignInForTests(): void {
  open.clear();
  starts.clear();
  misses = [];
}
