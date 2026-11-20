/**
 * The owner's passkeys (DOR-3647, DOR-4744): signing in from another device
 * with one, and confirming a sensitive action at this computer with one.
 *
 * Built on `@simplewebauthn/server` and the checks the session relay's
 * approvals passkeys already use (`session-relay/passkeys/passkey-enrolment.ts`:
 * the same allowed algorithms, the same "not in a frame" check). The rules:
 *
 * - **Fixed origins.** A ceremony may run only on one of
 *   {@link passkeyOrigins}: this computer's own addresses, and the live tunnel
 *   or managed address. The list comes from config and server state, never
 *   from the request's `Host` or a forwarding header. The browser's `Origin`
 *   must be on it exactly, and the signed `clientDataJSON` must name that same
 *   origin; the relying party is that origin's host name.
 * - **A passkey works where it was added.** Each stores its relying party, and
 *   only works on an origin with that host name.
 * - **The person is verified** (`userVerification: 'required'`), at creation
 *   and at every use.
 * - **One challenge, one use, one purpose.** A challenge is kept for
 *   {@link PASSKEY_CHALLENGE_TTL_MS}, bound to what it was made for (adding a
 *   passkey for one sign-in, signing in, or confirming one action for one
 *   sign-in), and taken on first use, pass or fail.
 * - **Counters never go back.** A signature counter at or below the last one
 *   seen, when either is above zero, is refused.
 *
 * @module services/core/auth/factors/owner-passkeys
 */
import { randomBytes } from 'node:crypto';
import {
  generateAuthenticationOptions,
  generateRegistrationOptions,
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
  type AuthenticationResponseJSON,
  type PublicKeyCredentialCreationOptionsJSON,
  type PublicKeyCredentialRequestOptionsJSON,
  type RegistrationResponseJSON,
} from '@simplewebauthn/server';

import { getStaticLocalOrigins, getTunnelOrigins } from '../../../../lib/trusted-origins.js';
import { APPROVAL_KEY_ALGS } from '../../session-relay/approval-key-store.js';
import { algOf, notFramed } from '../../session-relay/passkeys/passkey-enrolment.js';
import { addPasskey, confirmedFactors, findPasskey, usePasskey } from './owner-factors.js';

/** How long a passkey challenge lives. */
export const PASSKEY_CHALLENGE_TTL_MS = 2 * 60 * 1000;

/** Most challenges kept at once; the oldest goes first. */
const MAX_CHALLENGES = 50;

/** What a challenge was made for. */
export type PasskeyPurpose =
  | { readonly kind: 'add'; readonly userId: string; readonly sessionId: string }
  | { readonly kind: 'sign-in'; readonly userId: string }
  | {
      readonly kind: 'confirm';
      readonly userId: string;
      readonly sessionId: string;
      /** The one action it confirms, e.g. `wifi-sign-in-approve:<id>`. */
      readonly action: string;
    };

/** Why a passkey ceremony was refused. */
export type PasskeyRefusal =
  | 'origin'
  | 'no-passkey'
  | 'challenge'
  | 'not-verified'
  | 'algorithm'
  | 'counter'
  | 'already-added';

interface LiveChallenge {
  purpose: PasskeyPurpose;
  origin: string;
  expiresAt: number;
  label?: string;
}

/** Live challenges by their base64url value. */
const challenges = new Map<string, LiveChallenge>();

/**
 * The origins a passkey ceremony may run on, right now: this computer's own
 * addresses and the live tunnel or managed address. Wi-Fi addresses are never
 * here: a browser offers passkeys only on a secure page, and plain `http` on a
 * network address is not one.
 */
export function passkeyOrigins(): string[] {
  return [...new Set([...getStaticLocalOrigins(), ...getTunnelOrigins()])];
}

/** This computer's own origins, where confirming an action by passkey happens. */
export function thisComputerPasskeyOrigins(): string[] {
  return getStaticLocalOrigins();
}

/** The relying party id an origin stands for: its host name. */
function rpIdOf(origin: string): string {
  return new URL(origin).hostname;
}

function keep(challenge: string, live: LiveChallenge): void {
  const now = Date.now();
  for (const [value, entry] of challenges) if (entry.expiresAt <= now) challenges.delete(value);
  if (challenges.size >= MAX_CHALLENGES) challenges.delete(challenges.keys().next().value!);
  challenges.set(challenge, live);
}

/** The challenge a response's `clientDataJSON` names, or `null`. */
function challengeOf(clientDataJSON: string): string | null {
  try {
    const data = JSON.parse(Buffer.from(clientDataJSON, 'base64url').toString('utf8')) as {
      challenge?: unknown;
    };
    return typeof data.challenge === 'string' ? data.challenge : null;
  } catch {
    return null;
  }
}

/** Whether two purposes are the same one. */
function samePurpose(a: PasskeyPurpose, b: PasskeyPurpose): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

/**
 * Take the live challenge a response answers, if it was made for `purpose`.
 * Taken whether it matches or not.
 */
function takeChallenge(
  clientDataJSON: string,
  purpose: PasskeyPurpose,
  now: number
): { challenge: string; live: LiveChallenge } | null {
  const challenge = challengeOf(clientDataJSON);
  if (!challenge) return null;
  const live = challenges.get(challenge);
  if (!live) return null;
  challenges.delete(challenge);
  if (now >= live.expiresAt || !samePurpose(live.purpose, purpose)) return null;
  // The origin it was made on must still be one of ours.
  if (!passkeyOrigins().includes(live.origin)) return null;
  return { challenge, live };
}

/**
 * Start adding a passkey for the owner, on the origin the browser is on.
 *
 * @param input - Who, for which sign-in, on which origin, and its label.
 * @param now - The current time, for tests.
 */
export async function startAddingPasskey(
  input: { userId: string; userName: string; sessionId: string; origin: string; label: string },
  now = Date.now()
): Promise<PublicKeyCredentialCreationOptionsJSON | PasskeyRefusal> {
  if (!passkeyOrigins().includes(input.origin)) return 'origin';
  const rpID = rpIdOf(input.origin);
  const existing = confirmedFactors(input.userId, 'passkey').filter((row) => row.rpId === rpID);
  const options = await generateRegistrationOptions({
    rpName: 'DorkOS',
    rpID,
    userName: input.userName,
    userID: Buffer.from(input.userId, 'utf8'),
    challenge: randomBytes(32),
    attestationType: 'none',
    excludeCredentials: existing.map((row) => ({ id: row.credentialId! })),
    authenticatorSelection: { residentKey: 'preferred', userVerification: 'required' },
    supportedAlgorithmIDs: [...APPROVAL_KEY_ALGS],
  });
  keep(options.challenge, {
    purpose: { kind: 'add', userId: input.userId, sessionId: input.sessionId },
    origin: input.origin,
    expiresAt: now + PASSKEY_CHALLENGE_TTL_MS,
    label: input.label,
  });
  return options;
}

/**
 * Finish adding a passkey: verify it against its challenge and store it.
 *
 * @param input - Who, for which sign-in, and the browser's response.
 * @param now - The current time, for tests.
 * @returns The new factor's id and its host, or why not.
 */
export async function finishAddingPasskey(
  input: { userId: string; sessionId: string; response: RegistrationResponseJSON },
  now = Date.now()
): Promise<{ factorId: string; host: string } | PasskeyRefusal> {
  const taken = takeChallenge(
    input.response.response.clientDataJSON,
    { kind: 'add', userId: input.userId, sessionId: input.sessionId },
    now
  );
  if (!taken) return 'challenge';
  if (!notFramed(input.response.response.clientDataJSON)) return 'not-verified';
  const rpID = rpIdOf(taken.live.origin);
  let verified;
  try {
    verified = await verifyRegistrationResponse({
      response: input.response,
      expectedChallenge: taken.challenge,
      expectedOrigin: taken.live.origin,
      expectedRPID: rpID,
      requireUserVerification: true,
      supportedAlgorithmIDs: [...APPROVAL_KEY_ALGS],
    });
  } catch {
    return 'not-verified';
  }
  if (!verified.verified || !verified.registrationInfo.userVerified) return 'not-verified';
  const { credential } = verified.registrationInfo;
  const alg = algOf(credential.publicKey);
  if (alg === undefined || !APPROVAL_KEY_ALGS.some((allowed) => allowed === alg)) {
    return 'algorithm';
  }
  if (findPasskey(credential.id)) return 'already-added';
  const factorId = addPasskey(
    {
      userId: input.userId,
      label: taken.live.label ?? 'Passkey',
      credentialId: credential.id,
      publicKey: Buffer.from(credential.publicKey).toString('base64url'),
      alg,
      signCount: credential.counter,
      rpId: rpID,
    },
    now
  );
  return { factorId, host: rpID };
}

/**
 * Start a passkey check for one purpose, on the origin the browser is on.
 *
 * @param purpose - What it is for.
 * @param origin - The browser's `Origin`; must be one of {@link passkeyOrigins}.
 * @param now - The current time, for tests.
 * @returns The options to hand the browser, or `no-passkey` when the owner has
 *   none for that origin's host.
 */
export async function startPasskeyCheck(
  purpose: Exclude<PasskeyPurpose, { kind: 'add' }>,
  origin: string,
  now = Date.now()
): Promise<PublicKeyCredentialRequestOptionsJSON | PasskeyRefusal> {
  const allowed = purpose.kind === 'confirm' ? thisComputerPasskeyOrigins() : passkeyOrigins();
  if (!allowed.includes(origin)) return 'origin';
  const rpID = rpIdOf(origin);
  const keys = confirmedFactors(purpose.userId, 'passkey').filter((row) => row.rpId === rpID);
  if (keys.length === 0) return 'no-passkey';
  const options = await generateAuthenticationOptions({
    rpID,
    challenge: randomBytes(32),
    allowCredentials: keys.map((row) => ({ id: row.credentialId! })),
    userVerification: 'required',
  });
  keep(options.challenge, { purpose, origin, expiresAt: now + PASSKEY_CHALLENGE_TTL_MS });
  return options;
}

/**
 * Finish a passkey check: the person behind it, when it answers a live
 * challenge made for exactly this purpose with one of their passkeys.
 *
 * @param purpose - What it must have been made for.
 * @param response - The browser's response.
 * @param now - The current time, for tests.
 */
export async function finishPasskeyCheck(
  purpose: Exclude<PasskeyPurpose, { kind: 'add' }>,
  response: AuthenticationResponseJSON,
  now = Date.now()
): Promise<{ userId: string; factorId: string } | PasskeyRefusal> {
  const taken = takeChallenge(response.response.clientDataJSON, purpose, now);
  if (!taken) return 'challenge';
  if (purpose.kind === 'confirm' && !thisComputerPasskeyOrigins().includes(taken.live.origin)) {
    return 'origin';
  }
  if (!notFramed(response.response.clientDataJSON)) return 'not-verified';
  const key = findPasskey(response.id);
  if (!key || key.userId !== purpose.userId || key.confirmedAt === null) return 'no-passkey';
  const rpID = rpIdOf(taken.live.origin);
  if (key.rpId !== rpID) return 'no-passkey';
  const stored = key.signCount ?? 0;
  let verified;
  try {
    verified = await verifyAuthenticationResponse({
      response,
      expectedChallenge: taken.challenge,
      expectedOrigin: taken.live.origin,
      expectedRPID: rpID,
      credential: {
        id: key.credentialId!,
        publicKey: new Uint8Array(Buffer.from(key.publicKey!, 'base64url')),
        counter: stored,
      },
      requireUserVerification: true,
    });
  } catch (error) {
    return /counter/i.test(String(error)) ? 'counter' : 'not-verified';
  }
  if (!verified.verified || !verified.authenticationInfo.userVerified) return 'not-verified';
  const next = verified.authenticationInfo.newCounter;
  if ((next > 0 || stored > 0) && next <= stored) return 'counter';
  usePasskey(key.id, next, now);
  return { userId: key.userId, factorId: key.id };
}

/**
 * Forget every challenge. Tests only.
 *
 * @internal
 */
export function resetPasskeyChallengesForTests(): void {
  challenges.clear();
}
