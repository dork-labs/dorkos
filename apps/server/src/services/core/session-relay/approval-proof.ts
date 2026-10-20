/**
 * Checking a passkey proof for an approval from the web (spec
 * `everything-is-a-space` B4, plan part 2, steps 1 to 8), in exactly this
 * order, stopping at the first that fails:
 *
 * 1. the challenge was issued here, has not expired, and is for this chat,
 *    tool call and decision;
 * 2. the passkey is one pinned here, and one the statement named;
 * 3. `clientDataJSON` is a `webauthn.get` over this challenge from the pinned
 *    origin, with no `crossOrigin` and no `topOrigin`;
 * 4. `authenticatorData` is for the pinned relying party, with the person
 *    present (UP) and verified (UV);
 * 5. the signature verifies against the pinned key (`@simplewebauthn/server`);
 * 6. a passkey that counts signatures has counted up;
 * 7. the user handle is the pinned one;
 * 8. the chat is still waiting on that tool call, with the same input.
 *
 * The origin and relying party come from what was pinned at enrolment, never
 * from the request. The caller acts only on a passing verdict.
 *
 * @module services/core/session-relay/approval-proof
 */
import { createHash } from 'node:crypto';
import { verifyAuthenticationResponse } from '@simplewebauthn/server';
import { StepUpStatementError, decodeStepUpBase64url } from '@dork-labs/cloud-api';
import type { RelayApprovalProof } from '@dorkos/shared/session-relay';
import { hashApprovalInput } from '../approvals/approval-input-hash.js';
import {
  pendingApprovalInput,
  type ApprovalDecision,
  type IssuedApprovalChallenge,
  type PendingApprovalCard,
} from './approval-challenges.js';
import type { ApprovalKey, ApprovalKeys } from './approval-key-store.js';

/** The flag bits in `authenticatorData` this check reads. */
const FLAG_USER_PRESENT = 0x01;
const FLAG_USER_VERIFIED = 0x04;

/** Which check a proof failed, for the audit log. Never sent to the web side. */
export type ApprovalProofFailure =
  | 'no-challenge'
  | 'expired'
  | 'mismatch'
  | 'unknown-credential'
  | 'client-data'
  | 'authenticator-data'
  | 'signature'
  | 'sign-count'
  | 'user-handle'
  | 'not-pending'
  | 'input-changed';

/** A proof's verdict. */
export type ApprovalProofVerdict =
  | {
      ok: true;
      /** The pinned key that signed. */
      key: ApprovalKey;
      /** The sign counter the proof carried, to record. */
      signCount: number;
      /** The input hash the owner signed. */
      inputSha256: string;
    }
  | { ok: false; failure: ApprovalProofFailure };

/** What {@link verifyApprovalProof} checks. */
export interface VerifyApprovalProofInput {
  /** The challenge the proof named, already taken out of its book; `undefined` when none. */
  issued: IssuedApprovalChallenge | undefined;
  /** What the answer says it decides. */
  answer: { sessionId: string; toolCallId: string; decision: ApprovalDecision };
  /** The proof. */
  proof: RelayApprovalProof;
  /** The pinned keys. */
  keys: ApprovalKeys;
  /** The pending approval as it stands now, read at step 8. */
  pendingApproval: () => PendingApprovalCard | null;
  /** The current time; injectable for tests. */
  now?: Date;
}

/** Base64url bytes, or `null` when the text is not canonical base64url. */
function bytesOf(text: string): Uint8Array<ArrayBuffer> | null {
  try {
    return decodeStepUpBase64url(text);
  } catch (error) {
    if (error instanceof StepUpStatementError) return null;
    throw error;
  }
}

/** Step 3: the client data, read and checked against the pinned origin. */
function clientDataPasses(proof: RelayApprovalProof, expected: string, origin: string): boolean {
  const bytes = bytesOf(proof.clientDataJSON);
  if (!bytes) return false;
  let data: unknown;
  try {
    data = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  } catch {
    return false;
  }
  if (data === null || typeof data !== 'object' || Array.isArray(data)) return false;
  const record = data as Record<string, unknown>;
  return (
    record.type === 'webauthn.get' &&
    record.challenge === expected &&
    record.origin === origin &&
    // An approve page framed by another page, or one reporting a top origin, is refused.
    (record.crossOrigin === undefined || record.crossOrigin === false) &&
    !('topOrigin' in record)
  );
}

/** Steps 4 and 6's input: the relying party hash, the flags and the counter. */
function readAuthenticatorData(
  proof: RelayApprovalProof
): { rpIdHash: Buffer; flags: number; signCount: number } | null {
  const bytes = bytesOf(proof.authenticatorData);
  if (!bytes || bytes.byteLength < 37) return null;
  const view = Buffer.from(bytes);
  return { rpIdHash: view.subarray(0, 32), flags: view[32]!, signCount: view.readUInt32BE(33) };
}

/** Step 5: the signature, by `@simplewebauthn/server`, against the pinned key. */
async function signaturePasses(
  proof: RelayApprovalProof,
  key: ApprovalKey,
  keys: ApprovalKeys,
  expectedChallenge: string
): Promise<boolean> {
  const publicKey = bytesOf(key.cosePublicKey);
  if (!publicKey) return false;
  try {
    const { verified } = await verifyAuthenticationResponse({
      response: {
        id: proof.credentialId,
        rawId: proof.credentialId,
        type: 'public-key',
        response: {
          clientDataJSON: proof.clientDataJSON,
          authenticatorData: proof.authenticatorData,
          signature: proof.signature,
          ...(proof.userHandle !== undefined ? { userHandle: proof.userHandle } : {}),
        },
        clientExtensionResults: {},
      },
      expectedChallenge,
      expectedOrigin: keys.origin,
      expectedRPID: keys.rpId,
      // The counter is step 6, checked here after the signature; 0 turns off the
      // library's own check, which runs before it.
      credential: { id: key.credentialId, publicKey, counter: 0 },
      requireUserVerification: true,
    });
    return verified;
  } catch {
    return false;
  }
}

/** Step 8's comparison: the input as the card holds it now, hashed as at issue. */
function inputHashOf(card: PendingApprovalCard): string | null {
  try {
    return hashApprovalInput(pendingApprovalInput(card.input));
  } catch {
    return null;
  }
}

/**
 * Check one proof for an approval from the web, in the plan's order.
 *
 * @param input - See {@link VerifyApprovalProofInput}.
 * @returns A passing verdict with the key and its new counter, or the first check that failed.
 */
export async function verifyApprovalProof(
  input: VerifyApprovalProofInput
): Promise<ApprovalProofVerdict> {
  const { issued, answer, proof, keys } = input;
  const now = input.now ?? new Date();
  const fail = (failure: ApprovalProofFailure): ApprovalProofVerdict => ({ ok: false, failure });

  // 1. Issued here, unexpired, for this chat, tool call and decision.
  if (!issued || issued.statement.challengeId !== proof.challengeId) return fail('no-challenge');
  const { statement } = issued;
  if (now.getTime() >= Date.parse(statement.expiresAt)) return fail('expired');
  if (
    statement.sessionId !== answer.sessionId ||
    statement.toolCallId !== answer.toolCallId ||
    statement.decision !== answer.decision ||
    statement.rpId !== keys.rpId ||
    statement.origin !== keys.origin
  ) {
    return fail('mismatch');
  }

  // 2. A pinned key the statement named.
  const key = keys.keys.find((pinned) => pinned.credentialId === proof.credentialId);
  if (!key || !statement.credentialIds.includes(key.credentialId)) {
    return fail('unknown-credential');
  }

  // 3. The client data.
  if (!clientDataPasses(proof, issued.expectedChallenge, keys.origin)) return fail('client-data');

  // 4. The relying party and the UP and UV flags.
  const authData = readAuthenticatorData(proof);
  const rpIdHash = createHash('sha256').update(keys.rpId, 'utf8').digest();
  if (
    !authData ||
    !authData.rpIdHash.equals(rpIdHash) ||
    (authData.flags & FLAG_USER_PRESENT) === 0 ||
    (authData.flags & FLAG_USER_VERIFIED) === 0
  ) {
    return fail('authenticator-data');
  }

  // 5. The signature.
  if (!(await signaturePasses(proof, key, keys, issued.expectedChallenge))) {
    return fail('signature');
  }

  // 6. A counting passkey has counted up.
  if (key.signCount > 0 && authData.signCount <= key.signCount) return fail('sign-count');

  // 7. The pinned user handle.
  if (proof.userHandle !== keys.userHandle) return fail('user-handle');

  // 8. Still waiting, on the same tool and the same input.
  const pending = input.pendingApproval();
  if (!pending) return fail('not-pending');
  if (pending.toolName !== statement.toolName || inputHashOf(pending) !== statement.inputSha256) {
    return fail('input-changed');
  }

  return { ok: true, key, signCount: authData.signCount, inputSha256: statement.inputSha256 };
}
