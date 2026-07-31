/**
 * This machine's Buzz identity: one secp256k1 keypair, derived from the
 * community credential the server already mints, and the NIP-42 event it signs
 * to answer a relay's challenge.
 *
 * **Why there is a key at all.** The original ticket assumed a keyless read-only
 * adapter, because reads in base NIP-01 are unauthenticated. Buzz is not base
 * NIP-01: `handle_req` refuses every `REQ` from a connection that is not
 * `Authenticated`, with no branch on channel visibility and no config flag, and
 * the connection state machine has no anonymous variant to reach
 * (`crates/buzz-relay/src/handlers/req.rs:50-87`,
 * `crates/buzz-relay/src/connection.rs:37-47`). A client with no keypair cannot
 * receive a single message. The spike settled this
 * (`research/20260727_buzz-protocol-capability-spike.md` §4).
 *
 * **Why the zero-user-facing-keys principle survives it.** The key is machine
 * infrastructure. It is derived from `resolveCommunityCredential` — the existing
 * `0600` file, generated on first use, never logged and never surfaced — so
 * there is nothing for a person to write down, nothing to lose, and no
 * configuration step that can be skipped. That is what `credential:
 * 'machine-managed'` claims, and C16 asserts it by connecting a freshly
 * constructed adapter with no hook in between.
 *
 * **Deriving rather than storing a second secret** is the point of this module.
 * A separate keyfile would be a second thing to generate, permission, repair and
 * migrate, for no property the first one does not already have.
 *
 * @module server/services/communities/buzz/buzz-identity
 */
import { createHash } from 'node:crypto';
import { schnorr } from '@noble/curves/secp256k1.js';
import { eventId, KIND_CLIENT_AUTH, type NostrEvent } from './buzz-protocol.js';

/** How many hex characters a 32-byte secret key is written as. */
const SECRET_HEX_LENGTH = 64;

/** This machine's Buzz identity — the key, and what it can do with it. */
export interface BuzzIdentity {
  /** The x-only public key, lowercase hex. This is the member id Buzz knows us by. */
  readonly pubkey: string;
  /**
   * Sign an event: fill in `pubkey`, `id` and `sig`.
   *
   * @param draft - Everything but the three fields signing produces.
   */
  sign(draft: Pick<NostrEvent, 'created_at' | 'kind' | 'tags' | 'content'>): NostrEvent;
}

/**
 * Derive this machine's Buzz identity from a community credential.
 *
 * A credential minted by `resolveCommunityCredential` is 32 random bytes in hex,
 * which is already a valid secret key with overwhelming probability — so it is
 * used directly. Anything else (an operator's `DORKOS_COMMUNITY_SECRET_*`
 * override, which may be any string at all) is hashed to 32 bytes first. Both
 * paths are deterministic: the same credential always yields the same pubkey,
 * which matters because the pubkey is the identity a relay operator admitted.
 *
 * A hex credential that lands outside the curve order is astronomically unlikely
 * and is handled by the same hash path rather than by throwing, so no install can
 * be bricked by its own random bytes.
 *
 * @param credential - The community credential, from `resolveCommunityCredential`.
 */
export function deriveBuzzIdentity(credential: string): BuzzIdentity {
  const secret = toSecretKey(credential);
  const pubkey = Buffer.from(schnorr.getPublicKey(secret)).toString('hex');

  return {
    pubkey,
    sign(draft) {
      const unsigned = { ...draft, pubkey };
      const id = eventId(unsigned);
      const sig = Buffer.from(schnorr.sign(Buffer.from(id, 'hex'), secret)).toString('hex');
      return { ...unsigned, id, sig };
    },
  };
}

/**
 * Build the NIP-42 event that answers a relay's challenge.
 *
 * Kind 22242 over two tags — the relay URL we believe we are talking to, and the
 * challenge the relay pushed. Buzz verifies both and the signature, with no
 * network call and no token lookup (`crates/buzz-auth/src/lib.rs:114-143`).
 *
 * @param identity - The identity to sign as.
 * @param relayUrl - The relay URL, exactly as this client dialled it.
 * @param challenge - The challenge string from the relay's `AUTH` frame.
 * @param nowSeconds - Unix seconds to stamp; injected so a test is not a clock.
 */
export function buildAuthEvent(
  identity: BuzzIdentity,
  relayUrl: string,
  challenge: string,
  nowSeconds: number = Math.floor(Date.now() / 1000)
): NostrEvent {
  return identity.sign({
    created_at: nowSeconds,
    kind: KIND_CLIENT_AUTH,
    tags: [
      ['relay', relayUrl],
      ['challenge', challenge],
    ],
    content: '',
  });
}

/**
 * Reduce any credential string to 32 bytes usable as a secret key.
 *
 * @param credential - The credential to reduce.
 */
function toSecretKey(credential: string): Uint8Array {
  const trimmed = credential.trim();
  if (trimmed.length === SECRET_HEX_LENGTH && /^[0-9a-fA-F]+$/.test(trimmed)) {
    const bytes = Uint8Array.from(Buffer.from(trimmed.toLowerCase(), 'hex'));
    if (isValidSecret(bytes)) return bytes;
  }
  // Re-hashing on the (astronomically unlikely) out-of-range digest keeps this
  // total: there is no credential a person can set that leaves an install with
  // no identity, and the derivation stays deterministic either way.
  let candidate = Uint8Array.from(createHash('sha256').update(trimmed, 'utf8').digest());
  for (let attempt = 0; attempt < 8 && !isValidSecret(candidate); attempt += 1) {
    candidate = Uint8Array.from(createHash('sha256').update(candidate).digest());
  }
  return candidate;
}

/**
 * Whether these bytes are a usable secret key — the library is the authority, so
 * this asks it rather than restating the curve order.
 *
 * @param bytes - Candidate 32-byte secret.
 */
function isValidSecret(bytes: Uint8Array): boolean {
  try {
    schnorr.getPublicKey(bytes);
    return true;
  } catch {
    return false;
  }
}
