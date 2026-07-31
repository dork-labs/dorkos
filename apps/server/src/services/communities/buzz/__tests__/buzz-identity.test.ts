/**
 * @vitest-environment node
 *
 * The identity derivation and the NIP-42 event it signs.
 *
 * Two properties matter enough to pin. **Determinism**: the pubkey is what a
 * relay operator admitted, so a credential that derived a different key on the
 * next boot would lock an install out of a community it was already in.
 * **Totality**: an operator may set `DORKOS_COMMUNITY_SECRET_*` to any string at
 * all, and none of them may leave an install with no identity.
 */
import { describe, expect, it } from 'vitest';
import { schnorr } from '@noble/curves/secp256k1.js';
import { buildAuthEvent, deriveBuzzIdentity } from '../buzz-identity.js';
import { eventId, KIND_CLIENT_AUTH } from '../buzz-protocol.js';

describe('deriveBuzzIdentity', () => {
  it('derives the same key from the same credential, every time', () => {
    const credential = 'd'.repeat(64);
    expect(deriveBuzzIdentity(credential).pubkey).toBe(deriveBuzzIdentity(credential).pubkey);
    expect(deriveBuzzIdentity(credential).pubkey).not.toBe(
      deriveBuzzIdentity('e'.repeat(64)).pubkey
    );
  });

  it.each([
    ['a hex credential, used directly', 'a'.repeat(64)],
    ['an operator-set passphrase', 'correct horse battery staple'],
    ['something with whitespace and punctuation', '  hunter2!  '],
    ['a single character', 'x'],
  ])('produces a usable key from %s', (_case, credential) => {
    const identity = deriveBuzzIdentity(credential);
    expect(identity.pubkey, 'a pubkey is 32 bytes of hex').toMatch(/^[0-9a-f]{64}$/);
    const signed = identity.sign({ created_at: 1, kind: 1, tags: [], content: 'hello' });
    expect(
      schnorr.verify(hex(signed.sig), hex(signed.id), hex(signed.pubkey)),
      'and it can sign something a relay would accept'
    ).toBe(true);
  });

  it('computes the NIP-01 event id over the canonical serialization', () => {
    const identity = deriveBuzzIdentity('f'.repeat(64));
    const signed = identity.sign({ created_at: 42, kind: 9, tags: [['h', 'x']], content: 'hi' });
    expect(
      signed.id,
      'an id that is not a hash of the content lets an event be edited in flight'
    ).toBe(eventId({ ...signed }));
  });
});

describe('buildAuthEvent', () => {
  it('answers the challenge the relay actually issued, over the URL we dialled', () => {
    const identity = deriveBuzzIdentity('b'.repeat(64));
    const event = buildAuthEvent(identity, 'ws://relay.test/', 'challenge-1234', 1_780_000_000);

    expect(event.kind).toBe(KIND_CLIENT_AUTH);
    expect(event.tags).toContainEqual(['relay', 'ws://relay.test/']);
    expect(event.tags).toContainEqual(['challenge', 'challenge-1234']);
    expect(event.content, 'a NIP-42 event carries no payload').toBe('');
    expect(schnorr.verify(hex(event.sig), hex(event.id), hex(event.pubkey))).toBe(true);
  });
});

/**
 * Hex to bytes — the curve library takes bytes, the wire carries hex.
 *
 * @param value - Lowercase hex.
 */
function hex(value: string): Uint8Array {
  return Uint8Array.from(Buffer.from(value, 'hex'));
}
