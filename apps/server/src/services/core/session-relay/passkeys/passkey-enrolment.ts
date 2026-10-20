/**
 * Adding an approvals passkey at this computer (spec `everything-is-a-space`
 * B4c; plan part 1 and Security's Must 2).
 *
 * `/start` writes a {@link PasskeyEnrolStatementV1} and keeps it as the one
 * live enrolment on this server (a new start replaces it). The approve page
 * creates the passkey over `SHA-256` of the statement's bytes and sends the
 * browser back to the statement's loopback `returnTo`, whose page posts the
 * result to `/finish`. `/finish` accepts it only when:
 *
 * 1. a live statement exists, and the statement sent is the same bytes;
 * 2. it decodes as one canonical enrol statement and has not expired;
 * 3. `@simplewebauthn/server` verifies the registration against the
 *    statement's own challenge, origin and relying party, with the person
 *    verified (UV), and `clientDataJSON` carries no `crossOrigin` or `topOrigin`;
 * 4. the key signs with ES256, EdDSA or RS256 only;
 * 5. it is not already pinned.
 *
 * The live statement is taken on every `/finish`, pass or fail, so each one
 * is used once. The origin and relying party come from the statement this
 * computer wrote, never from the request that finishes it. The pin must still
 * be the one the statement was written for (same computer, same account), and
 * unlinking or linking again drops the live statement.
 *
 * `returnTo` names the loopback address the `/start` request actually arrived
 * on: `127.0.0.1` for IPv4 loopback, `[::1]` for `::1` (a default install
 * binds `localhost`, which on macOS is `::1` only). Never the name `localhost`:
 * a loopback redirect uses the IP literal (RFC 8252 §8.3), because a hosts file,
 * a VPN or an old browser can resolve the name somewhere else.
 *
 * **Residuals.** Only a request the classifier calls this computer can enrol,
 * so a container install, whose browser reaches it through the bridge, cannot
 * add a passkey. The label is not signed: a process on this machine that can
 * read the browser's history in the two minutes a statement lives could post
 * the fragment itself, under the label the owner typed. It would need a shell
 * on this computer, which is outside B4's threat model.
 *
 * @module services/core/session-relay/passkeys/passkey-enrolment
 */
import { createHash, randomBytes } from 'node:crypto';
import { ulid } from 'ulidx';
import { verifyRegistrationResponse } from '@simplewebauthn/server';
import { cose, decodeCredentialPublicKey } from '@simplewebauthn/server/helpers';
import {
  PasskeyEnrolStatementV1Schema,
  STEP_UP_ENROL_STATEMENT_TYPE,
  StepUpStatementError,
  decodeStepUpBase64url,
  decodeStepUpStatement,
  encodeStepUpBase64url,
  encodeStepUpStatement,
  stepUpChallenge,
  type PasskeyEnrolStatementV1,
} from '@dork-labs/cloud-api';
import { links } from '@dorkos/shared/links';
import {
  SESSION_RELAY_PASSKEY_STATEMENT_MAX_CHARS,
  type SessionRelayPasskeyFinishBodySchema,
} from '@dorkos/shared/session-relay-link';
import type { z } from 'zod';
import { APPROVAL_KEY_ALGS, type ApprovalKey, type ApprovalKeys } from '../approval-key-store.js';

/** DorkOS's own approve page: the relying party every dorkos.ai account uses. */
export const DEFAULT_APPROVE_ORIGIN = links.approve;

/** How long an enrol statement lives. */
export const ENROL_STATEMENT_TTL_MS = 2 * 60 * 1000;

/** The loopback page the approve page sends the browser back to. */
export const RELAY_PASSKEY_RETURN_PATH = '/relay-passkey';

/** The passkey the approve page made, as `/finish` receives it. */
export type PasskeyAttestation = z.output<
  typeof SessionRelayPasskeyFinishBodySchema
>['attestation'];

/** Why `/start` could not begin. */
export type EnrolStartRefusal =
  'bad-origin' | 'other-origin' | 'hub-origin' | 'cloud-only' | 'no-account' | 'cannot-start';

/** Why `/finish` refused a passkey. Recorded in the audit log; the owner reads a sentence. */
export type EnrolFinishRefusal =
  | 'no-enrolment'
  | 'not-this-statement'
  | 'expired'
  | 'unlinked'
  | 'not-verified'
  | 'algorithm'
  | 'already-added';

/** What `/start` hands back. */
export interface StartedEnrolment {
  /** The statement, base64url of its bytes. */
  statement: string;
  /** Base64url `SHA-256` of the statement bytes. */
  challenge: string;
  /** `${origin}/enrol#${statement}`. */
  approveUrl: string;
  /** When it stops being accepted. */
  expiresAt: string;
}

/** What `/finish` produced: the key to pin, and the relying party it belongs to. */
export type FinishedEnrolment =
  | {
      ok: true;
      party: Pick<ApprovalKeys, 'rpId' | 'origin' | 'userHandle'>;
      key: ApprovalKey;
      /** The link the statement was written for, to check again as the key is written. */
      link: { computerId: string; accountId: string };
    }
  | { ok: false; refusal: EnrolFinishRefusal };

/** What `/start` needs. */
export interface StartEnrolmentInput {
  /** This computer's id as its hub knows it. */
  computerId: string;
  /** This computer's name, as the approve page shows it. */
  computerName: string;
  /** The hub owner's account id, from the pin. */
  accountId: string | undefined;
  /** What the owner called the passkey. Kept with the live statement, never in it. */
  label: string;
  /** The approve page's origin the owner asked for, if any. */
  origin?: string;
  /** Its relying party the owner asked for, if any. */
  rpId?: string;
  /** The keys already pinned, if any. */
  pinned: ApprovalKeys | null;
  /** The pinned hub's origin: never an approve page. */
  hubOrigin: string;
  /** The issuer of the hub owner's account, when the hub named one. */
  issuer: string | undefined;
  /** The local address the `/start` request arrived on, as its socket reports it. */
  localAddress: string | undefined;
  /** The local port it arrived on. */
  port: number | undefined;
}

/** The pin `/finish` checks the statement against. */
export interface EnrolmentPin {
  computerId: string;
  accountId?: string | undefined;
}

/**
 * The host a loopback socket address is reached by in a browser: `127.0.0.1`
 * for IPv4 loopback (plain or IPv4-mapped), `[::1]` for `::1`, and
 * `undefined` for anything else.
 */
export function loopbackReturnHost(address: string | undefined): string | undefined {
  if (!address) return undefined;
  const v4 = address.replace(/^::ffff:/i, '');
  if (/^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(v4)) return '127.0.0.1';
  if (address === '::1') return '[::1]';
  return undefined;
}

/** Whether an issuer is DorkOS Cloud's: its host is the site's host or under it. */
function isDorkosIssuer(issuer: string | undefined): boolean {
  if (!issuer) return false;
  try {
    // A fully qualified host (`cloud.dorkos.ai.`) is the same host.
    const host = new URL(issuer).hostname.replace(/\.$/, '');
    const site = new URL(links.site).hostname;
    return host === site || host.endsWith(`.${site}`);
  } catch {
    return false;
  }
}

/**
 * The WebAuthn user handle of every approvals passkey on this computer:
 * base64url `SHA-256(accountId ‖ 0x00 ‖ computerId)`. Never the dorkos.ai
 * sign-in passkey's, so creating one cannot overwrite that passkey in a
 * password manager. The zero byte keeps the two ids from running together;
 * neither may contain one.
 *
 * @param accountId - The hub owner's account id.
 * @param computerId - This computer's id as its hub knows it.
 */
export function approvalUserHandle(accountId: string, computerId: string): string {
  return createHash('sha256')
    .update(accountId, 'utf8')
    .update(Buffer.from([0]))
    .update(computerId, 'utf8')
    .digest('base64url');
}

/** The relying party a start asks for: what it names, else what is pinned, else DorkOS's. */
function relyingPartyFor(
  input: Pick<StartEnrolmentInput, 'origin' | 'rpId' | 'pinned' | 'hubOrigin' | 'issuer'>
): { origin: string; rpId: string } | EnrolStartRefusal {
  let origin = input.origin ?? (input.rpId ? `https://${input.rpId}` : undefined);
  origin ??= input.pinned?.origin ?? DEFAULT_APPROVE_ORIGIN;
  let url: URL;
  try {
    url = new URL(origin);
  } catch {
    return 'bad-origin';
  }
  if (url.protocol !== 'https:' || url.origin !== origin) return 'bad-origin';
  const rpId = input.rpId ?? url.hostname;
  if (rpId !== url.hostname) return 'bad-origin';
  if (input.pinned && (input.pinned.origin !== origin || input.pinned.rpId !== rpId)) {
    return 'other-origin';
  }
  // The hub must never be its own approve page: it could then sign for the owner.
  if (url.hostname === new URL(input.hubOrigin).hostname) return 'hub-origin';
  // A DorkOS Cloud account uses DorkOS's approve page and no other.
  if (origin !== DEFAULT_APPROVE_ORIGIN && isDorkosIssuer(input.issuer)) return 'cloud-only';
  return { origin, rpId };
}

/** The one enrolment this server has open. */
interface LiveEnrolment {
  bytes: Uint8Array;
  statement: PasskeyEnrolStatementV1;
  label: string;
}

/** Whether two byte arrays hold the same bytes. */
function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.byteLength !== b.byteLength) return false;
  for (let i = 0; i < a.byteLength; i += 1) if (a[i] !== b[i]) return false;
  return true;
}

/** `clientDataJSON` carries no `crossOrigin: true` and no `topOrigin`. */
function notFramed(clientDataJSON: string): boolean {
  try {
    const data = JSON.parse(
      new TextDecoder('utf-8', { fatal: true }).decode(decodeStepUpBase64url(clientDataJSON))
    ) as Record<string, unknown>;
    return (data.crossOrigin === undefined || data.crossOrigin === false) && !('topOrigin' in data);
  } catch {
    return false;
  }
}

/** The COSE algorithm a public key names, or `undefined` when it names none. */
function algOf(publicKey: Parameters<typeof decodeCredentialPublicKey>[0]): number | undefined {
  try {
    const alg = decodeCredentialPublicKey(publicKey).get(cose.COSEKEYS.alg);
    return typeof alg === 'number' ? alg : undefined;
  } catch {
    return undefined;
  }
}

/** Holds the one live enrolment, and starts and finishes it. */
export class PasskeyEnrolment {
  private live: LiveEnrolment | null = null;

  /**
   * Make the holder, with nothing open.
   *
   * @param now - The clock; injectable for tests.
   * @param libraryAlgorithms - The algorithms `@simplewebauthn/server` is told
   *   to accept. Always the allowed set; a test widens it to reach this
   *   module's own algorithm check behind the library's.
   */
  constructor(
    private readonly now: () => Date = () => new Date(),
    private readonly libraryAlgorithms: readonly number[] = APPROVAL_KEY_ALGS
  ) {}

  /**
   * Write an enrol statement and keep it as the one live enrolment.
   *
   * @param input - See {@link StartEnrolmentInput}.
   * @returns The statement and the approve page to open, or why not.
   */
  async start(input: StartEnrolmentInput): Promise<StartedEnrolment | EnrolStartRefusal> {
    // The user handle needs an account. A self-hosted hub that names none is
    // refused for now; a follow-up gives it a handle of its own.
    if (!input.accountId || !/^[\w.:-]{1,64}$/.test(input.accountId)) return 'no-account';
    const party = relyingPartyFor(input);
    if (typeof party === 'string') return party;
    const host = loopbackReturnHost(input.localAddress);
    if (!host || !input.port) return 'cannot-start';
    const issuedAt = this.now();
    const statement: PasskeyEnrolStatementV1 = {
      t: STEP_UP_ENROL_STATEMENT_TYPE,
      challengeId: ulid(),
      computerId: input.computerId,
      computerName: input.computerName,
      accountId: input.accountId,
      userHandle: approvalUserHandle(input.accountId, input.computerId),
      nonce: randomBytes(32).toString('base64url'),
      issuedAt: issuedAt.toISOString(),
      expiresAt: new Date(issuedAt.getTime() + ENROL_STATEMENT_TTL_MS).toISOString(),
      rpId: party.rpId,
      origin: party.origin,
      returnTo: `http://${host}:${input.port}${RELAY_PASSKEY_RETURN_PATH}`,
      excludeCredentialIds: input.pinned?.keys.map((key) => key.credentialId) ?? [],
    };
    // The schema refusing the origin or relying party is the owner's to fix;
    // anything else it refuses is this computer's.
    const checked = PasskeyEnrolStatementV1Schema.safeParse(statement);
    if (!checked.success) {
      const aboutOrigin = checked.error.issues.some(
        (issue) => issue.path.length === 0 || ['origin', 'rpId'].includes(String(issue.path[0]))
      );
      return aboutOrigin ? 'bad-origin' : 'cannot-start';
    }
    let bytes: Uint8Array<ArrayBuffer>;
    try {
      bytes = encodeStepUpStatement(statement);
    } catch (error) {
      if (error instanceof StepUpStatementError) return 'cannot-start';
      throw error;
    }
    const encoded = encodeStepUpBase64url(bytes);
    // Many long excluded ids can make a statement the contract allows but `/finish`
    // would refuse: never issue one a passkey could be made for and then turned away.
    if (encoded.length > SESSION_RELAY_PASSKEY_STATEMENT_MAX_CHARS) return 'cannot-start';
    this.live = { bytes, statement, label: input.label };
    return {
      statement: encoded,
      challenge: await stepUpChallenge(bytes),
      // The approve page's enrol page reads the statement from the fragment,
      // which never reaches its server: `<origin>/enrol#<base64url statement>`.
      // It hashes those exact bytes for the challenge and never re-writes them.
      approveUrl: `${party.origin}/enrol#${encoded}`,
      expiresAt: statement.expiresAt,
    };
  }

  /** Whether an enrolment is open; for tests. */
  get open(): boolean {
    return this.live !== null;
  }

  /** The origin of the live statement's return page, or `null` when none is open. */
  returnOrigin(): string | null {
    return this.live ? new URL(this.live.statement.returnTo).origin : null;
  }

  /** Drop the live enrolment, as a finish that could not even be read does. */
  cancel(): void {
    this.live = null;
  }

  /**
   * Check a new passkey against the live statement, taking the statement
   * whether it passes or not.
   *
   * @param body - The statement sent back, and the registration response.
   * @param pinned - The keys already pinned, if any.
   * @param pin - The relay pin as it stands now; `null` once unlinked.
   * @returns The key to pin, or why not.
   */
  async finish(
    body: { statement: string; attestation: PasskeyAttestation },
    pinned: ApprovalKeys | null,
    pin: EnrolmentPin | null
  ): Promise<FinishedEnrolment> {
    const now = this.now();
    const live = this.live;
    this.live = null;
    const refuse = (refusal: EnrolFinishRefusal): FinishedEnrolment => ({ ok: false, refusal });
    if (!live) return refuse('no-enrolment');

    let bytes: Uint8Array;
    let statement;
    try {
      bytes = decodeStepUpBase64url(body.statement);
      statement = decodeStepUpStatement(bytes);
    } catch (error) {
      if (error instanceof StepUpStatementError) return refuse('not-this-statement');
      throw error;
    }
    if (!sameBytes(bytes, live.bytes) || statement.t !== STEP_UP_ENROL_STATEMENT_TYPE) {
      return refuse('not-this-statement');
    }
    if (now.getTime() >= Date.parse(statement.expiresAt)) return refuse('expired');
    // Still linked to the hub and account the statement was written for.
    if (!pin || pin.computerId !== statement.computerId || pin.accountId !== statement.accountId) {
      return refuse('unlinked');
    }

    const { attestation } = body;
    if (!notFramed(attestation.response.clientDataJSON)) return refuse('not-verified');
    let verified;
    try {
      verified = await verifyRegistrationResponse({
        response: attestation,
        expectedChallenge: await stepUpChallenge(bytes),
        expectedOrigin: statement.origin,
        expectedRPID: statement.rpId,
        expectedType: 'webauthn.create',
        requireUserVerification: true,
        supportedAlgorithmIDs: [...this.libraryAlgorithms],
      });
    } catch {
      return refuse('not-verified');
    }
    if (!verified.verified || !verified.registrationInfo.userVerified) {
      return refuse('not-verified');
    }

    const { credential } = verified.registrationInfo;
    const alg = algOf(credential.publicKey);
    if (!APPROVAL_KEY_ALGS.some((allowed) => allowed === alg)) return refuse('algorithm');
    if (pinned?.keys.some((key) => key.credentialId === credential.id)) {
      return refuse('already-added');
    }
    return {
      ok: true,
      party: { rpId: statement.rpId, origin: statement.origin, userHandle: statement.userHandle },
      link: { computerId: statement.computerId, accountId: statement.accountId },
      key: {
        credentialId: credential.id,
        cosePublicKey: encodeStepUpBase64url(credential.publicKey),
        alg: alg as ApprovalKey['alg'],
        signCount: credential.counter,
        label: live.label,
        addedAt: now.toISOString(),
      },
    };
  }
}

let liveEnrolment: PasskeyEnrolment | null = null;

/** This server's one enrolment, made on first use. */
export function passkeyEnrolment(): PasskeyEnrolment {
  liveEnrolment ??= new PasskeyEnrolment();
  return liveEnrolment;
}
