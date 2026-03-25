import { describe, it, expect } from 'vitest';
import { hashPasscode, verifyPasscode } from '../passcode-hash.js';

describe('passcode-hash', () => {
  describe('hashPasscode', () => {
    it('returns hash and salt as hex strings', async () => {
      const result = await hashPasscode('123456');
      expect(result.hash).toMatch(/^[0-9a-f]+$/);
      expect(result.salt).toMatch(/^[0-9a-f]+$/);
    });

    it('returns a 128-character hex hash (64 bytes)', async () => {
      const result = await hashPasscode('123456');
      expect(result.hash.length).toBe(128);
    });

    it('returns a 64-character hex salt (32 bytes)', async () => {
      const result = await hashPasscode('123456');
      expect(result.salt.length).toBe(64);
    });

    it('produces different salts for each call', async () => {
      const a = await hashPasscode('123456');
      const b = await hashPasscode('123456');
      expect(a.salt).not.toBe(b.salt);
    });

    it('produces different hashes for the same input due to unique salts', async () => {
      const a = await hashPasscode('123456');
      const b = await hashPasscode('123456');
      expect(a.hash).not.toBe(b.hash);
    });
  });

  describe('verifyPasscode', () => {
    it('returns true for correct passcode', async () => {
      const { hash, salt } = await hashPasscode('654321');
      const valid = await verifyPasscode('654321', hash, salt);
      expect(valid).toBe(true);
    });

    it('returns false for incorrect passcode', async () => {
      const { hash, salt } = await hashPasscode('654321');
      const valid = await verifyPasscode('000000', hash, salt);
      expect(valid).toBe(false);
    });

    it('returns false when hash length does not match (no throw)', async () => {
      const { salt } = await hashPasscode('654321');
      const valid = await verifyPasscode('654321', 'short', salt);
      expect(valid).toBe(false);
    });

    it('different salts produce different hashes for the same passcode', async () => {
      const a = await hashPasscode('111111');
      const b = await hashPasscode('111111');
      const crossValid = await verifyPasscode('111111', a.hash, b.salt);
      expect(crossValid).toBe(false);
    });
  });
});
