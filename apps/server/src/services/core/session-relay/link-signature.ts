/**
 * Signing and checking the two link messages (step B3, DOR-2946), over the
 * transcripts `@dorkos/shared/session-relay-link` fixes. A computer signs its
 * request with its own long-lived key ({@link signRelayLinkRequest}) and checks
 * the hub's answer ({@link verifyRelayLinkResponse}); a hub checks the request
 * ({@link verifyRelayLinkRequest}) and signs its answer with its injected key.
 *
 * Every check fails closed and never throws on what the other end sent.
 *
 * @module services/core/session-relay/link-signature
 */
import { createHash, createPublicKey, sign, verify, type KeyObject } from 'node:crypto';
import {
  relayLinkRequestTranscript,
  relayLinkResponseTranscript,
  type RelayLinkRequest,
  type RelayLinkResponse,
  type RelayLinkTranscriptInput,
} from '@dorkos/shared/session-relay-link';
import { pinnableKey } from './channel.js';

/** The DER prefix of an Ed25519 SubjectPublicKeyInfo, before the raw 32 bytes. */
const ED25519_SPKI_PREFIX = Buffer.from('302a300506032b6570032100', 'hex');

/**
 * The hash both transcripts carry of a link code: SHA-256 of the canonical
 * code, base64url.
 *
 * @param code - The canonical code (`normalizeRelayLinkCode`).
 */
export function relayLinkCodeHash(code: string): string {
  return createHash('sha256').update(code, 'utf8').digest('base64url');
}

/**
 * An Ed25519 public key from its raw 32 bytes in canonical base64url, or
 * `null` when it is not one.
 */
function ed25519FromRaw(rawBase64url: string): KeyObject | null {
  const raw = Buffer.from(rawBase64url, 'base64url');
  if (raw.length !== 32 || raw.toString('base64url') !== rawBase64url) return null;
  try {
    return createPublicKey({
      key: Buffer.concat([ED25519_SPKI_PREFIX, raw]),
      format: 'der',
      type: 'spki',
    });
  } catch {
    return null;
  }
}

/** Verify a signature by a raw key, as `false` on anything malformed. */
function verifyByRawKey(data: () => Uint8Array, rawKey: string, signature: string): boolean {
  const key = ed25519FromRaw(rawKey);
  const bytes = Buffer.from(signature, 'base64url');
  if (!key || bytes.length !== 64) return false;
  try {
    return verify(null, data(), key, bytes);
  } catch {
    return false;
  }
}

/** The fields of a request that both transcripts cover. */
function transcriptInput(
  request: Pick<RelayLinkRequest, 'computerId' | 'computerKey' | 'secretHash'>,
  hubOrigin: string,
  codeHash: string
): RelayLinkTranscriptInput {
  return {
    hubOrigin,
    codeHash,
    computerId: request.computerId,
    computerKey: request.computerKey,
    secretHash: request.secretHash,
  };
}

/**
 * Sign a link request as the computer: fills in `computerKey` from the key
 * and the signature over the request transcript.
 *
 * @param fields - Everything the request carries but its key and signature.
 * @param hubOrigin - The hub's origin, as the link code named it.
 * @param signingKey - The computer's long-lived Ed25519 private key.
 */
export function signRelayLinkRequest(
  fields: Omit<RelayLinkRequest, 'computerKey' | 'signature'>,
  hubOrigin: string,
  signingKey: KeyObject
): RelayLinkRequest {
  const computerKey = pinnableKey(signingKey);
  const input = transcriptInput(
    { ...fields, computerKey },
    hubOrigin,
    relayLinkCodeHash(fields.code)
  );
  const signature = sign(null, relayLinkRequestTranscript(input, fields.computerName), signingKey);
  return { ...fields, computerKey, signature: signature.toString('base64url') };
}

/**
 * Whether a link request is signed by the key it carries, over this hub's
 * origin and this code.
 *
 * @param request - The parsed request.
 * @param hubOrigin - The origin this hub serves.
 * @param codeHash - {@link relayLinkCodeHash} of the canonical code.
 */
export function verifyRelayLinkRequest(
  request: RelayLinkRequest,
  hubOrigin: string,
  codeHash: string
): boolean {
  return verifyByRawKey(
    () =>
      relayLinkRequestTranscript(
        transcriptInput(request, hubOrigin, codeHash),
        request.computerName
      ),
    request.computerKey,
    request.signature
  );
}

/**
 * The bytes a hub signs to answer a request.
 *
 * @param request - The request it accepted.
 * @param hubOrigin - The origin this hub serves.
 * @param codeHash - {@link relayLinkCodeHash} of the canonical code.
 * @param answer - The hub's key and owner.
 */
export function relayLinkAnswerBytes(
  request: RelayLinkRequest,
  hubOrigin: string,
  codeHash: string,
  answer: Pick<RelayLinkResponse, 'hubKey' | 'ownerAccountId' | 'issuer'>
): Uint8Array {
  return relayLinkResponseTranscript(transcriptInput(request, hubOrigin, codeHash), answer);
}

/**
 * Whether a hub's answer is signed by the key it hands over, over exactly the
 * request this computer sent.
 *
 * @param response - The parsed answer.
 * @param request - The request this computer sent.
 * @param hubOrigin - The origin it sent it to.
 */
export function verifyRelayLinkResponse(
  response: RelayLinkResponse,
  request: RelayLinkRequest,
  hubOrigin: string
): boolean {
  return verifyByRawKey(
    () => relayLinkAnswerBytes(request, hubOrigin, relayLinkCodeHash(request.code), response),
    response.hubKey,
    response.signature
  );
}
