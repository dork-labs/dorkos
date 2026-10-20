/**
 * @vitest-environment node
 *
 * The soft authenticator signs what a real one would: authenticatorData with
 * the relying party's hash, the flags and the counter, over SHA-256 of the
 * client data, checkable with the public key it exports.
 */
import { createHash, createPublicKey, verify } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { SoftAuthenticator, type SoftAuthenticatorAlg } from '../soft-authenticator.js';

const RP = { rpId: 'approve.example.test', origin: 'https://approve.example.test' };
const USER = Buffer.from('owner-handle').toString('base64url');

/** The public key back out of the authenticator's COSE bytes, via its JWK coordinates. */
function publicKeyOf(auth: SoftAuthenticator) {
  const cose = Buffer.from(auth.cosePublicKey());
  if (auth.alg === 'Ed25519') {
    // [map(4) 1:1 3:-8 -1:6 -2:bytes(32)]: the last 32 bytes are x.
    const x = cose.subarray(cose.length - 32);
    return createPublicKey({
      key: { kty: 'OKP', crv: 'Ed25519', x: x.toString('base64url') },
      format: 'jwk',
    });
  }
  // [... -2:bytes(32) -3:bytes(32)]: x then y, each after a 2-byte head and key.
  const y = cose.subarray(cose.length - 32);
  const x = cose.subarray(cose.length - 32 - 3 - 32, cose.length - 32 - 3);
  return createPublicKey({
    key: { kty: 'EC', crv: 'P-256', x: x.toString('base64url'), y: y.toString('base64url') },
    format: 'jwk',
  });
}

describe.each<SoftAuthenticatorAlg>(['ES256', 'Ed25519'])('SoftAuthenticator (%s)', (alg) => {
  it('signs an assertion its own public key verifies', () => {
    const auth = new SoftAuthenticator({ ...RP, userHandle: USER, alg });
    const assertion = auth.assert({ challenge: 'Y2hhbGxlbmdl' });
    const authData = Buffer.from(assertion.authenticatorData, 'base64url');
    const clientData = Buffer.from(assertion.clientDataJSON, 'base64url');
    const signed = Buffer.concat([authData, createHash('sha256').update(clientData).digest()]);
    const signature = Buffer.from(assertion.signature, 'base64url');
    const key = publicKeyOf(auth);
    expect(
      alg === 'ES256'
        ? verify('sha256', signed, { key, dsaEncoding: 'der' }, signature)
        : verify(null, signed, key, signature)
    ).toBe(true);
    expect(authData.subarray(0, 32)).toEqual(createHash('sha256').update(RP.rpId).digest());
    expect(authData[32]).toBe(0x05);
    expect(authData.readUInt32BE(33)).toBe(1);
    expect(JSON.parse(clientData.toString('utf8'))).toEqual({
      type: 'webauthn.get',
      challenge: 'Y2hhbGxlbmdl',
      origin: RP.origin,
      crossOrigin: false,
    });
    expect(assertion.userHandle).toBe(USER);
    expect(auth.coseAlg).toBe(alg === 'ES256' ? -7 : -8);
  });

  it('breaks exactly what a test asks it to', () => {
    const auth = new SoftAuthenticator({ ...RP, userHandle: USER, alg, signCount: 9 });
    const assertion = auth.assert({
      challenge: 'abc',
      userPresent: false,
      userVerified: false,
      signCount: 3,
      crossOrigin: true,
      topOrigin: 'https://evil.example.test',
      userHandle: null,
    });
    const authData = Buffer.from(assertion.authenticatorData, 'base64url');
    expect(authData[32]).toBe(0);
    expect(authData.readUInt32BE(33)).toBe(3);
    expect(JSON.parse(Buffer.from(assertion.clientDataJSON, 'base64url').toString())).toMatchObject(
      {
        crossOrigin: true,
        topOrigin: 'https://evil.example.test',
      }
    );
    expect(assertion.userHandle).toBeUndefined();
    expect(auth.signCount).toBe(9);
  });

  it('makes a none attestation carrying its credential and key', () => {
    const auth = new SoftAuthenticator({ ...RP, userHandle: USER, alg, credentialId: 'AQID' });
    const attestation = auth.attest({ challenge: 'enrol' });
    const object = Buffer.from(attestation.attestationObject, 'base64url');
    expect(object.includes(Buffer.from('none'))).toBe(true);
    expect(object.includes(Buffer.from(auth.cosePublicKey()))).toBe(true);
    expect(JSON.parse(Buffer.from(attestation.clientDataJSON, 'base64url').toString()).type).toBe(
      'webauthn.create'
    );
    expect(attestation.credentialId).toBe('AQID');
  });
});
