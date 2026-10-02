import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
/** Retain only a fixed digest; raw secrets are returned once to trusted engine startup. */
export function brokerCredential() {
  let secret: string | undefined = randomBytes(32).toString('base64url');
  const digest = createHash('sha256').update(secret).digest();
  return {
    take() {
      if (!secret) throw new Error('CREDENTIAL_ALREADY_DELIVERED');
      const value = secret;
      secret = undefined;
      return value;
    },
    verify(candidate: string, maxBytes: number) {
      if (typeof candidate !== 'string' || Buffer.byteLength(candidate) > maxBytes) return false;
      return timingSafeEqual(digest, createHash('sha256').update(candidate).digest());
    },
  };
}
