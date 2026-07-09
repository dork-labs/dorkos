import { describe, it, expect } from 'vitest';
import { WorkbenchTokenSigner, WorkbenchTokenError } from '../token.js';

// A signed workbench token authorizes the (auth-gate-exempt) serve/proxy routes,
// so its verification is the security boundary: it must accept only unexpired,
// untampered tokens minted with the same secret. These tests pin that contract.

const SECRET = 'test-secret-fixed-for-determinism';

describe('WorkbenchTokenSigner', () => {
  it('round-trips a serve scope: a freshly minted token verifies to its payload', () => {
    const signer = new WorkbenchTokenSigner({ secret: SECRET });
    const token = signer.mint({ kind: 'serve', cwd: '/work/dir' });
    const payload = signer.verify(token);
    expect(payload.scope).toEqual({ kind: 'serve', cwd: '/work/dir' });
    expect(payload.exp).toBeGreaterThan(Date.now());
  });

  it('round-trips a proxy scope carrying the port', () => {
    const signer = new WorkbenchTokenSigner({ secret: SECRET });
    const token = signer.mint({ kind: 'proxy', port: 5173 });
    expect(signer.verify(token).scope).toEqual({ kind: 'proxy', port: 5173 });
  });

  it('rejects an EXPIRED token (valid signature, past its TTL)', () => {
    // 1ms TTL: mint at t=0, verify at t=10 → expired.
    const signer = new WorkbenchTokenSigner({ secret: SECRET, ttlMs: 1 });
    const token = signer.mint({ kind: 'serve', cwd: '/work/dir' }, 0);
    expect(() => signer.verify(token, 10)).toThrowError(
      expect.objectContaining({ code: 'EXPIRED' })
    );
  });

  it('rejects a FORGED token (signature does not match the secret)', () => {
    const minted = new WorkbenchTokenSigner({ secret: SECRET }).mint({
      kind: 'serve',
      cwd: '/work/dir',
    });
    // A different secret cannot have produced this signature.
    const attacker = new WorkbenchTokenSigner({ secret: 'different-secret' });
    expect(() => attacker.verify(minted)).toThrowError(
      expect.objectContaining({ code: 'BAD_SIGNATURE' })
    );
  });

  it('rejects a TAMPERED payload (attacker swaps the cwd but keeps the old signature)', () => {
    const signer = new WorkbenchTokenSigner({ secret: SECRET });
    const token = signer.mint({ kind: 'serve', cwd: '/work/dir' });
    const [, sig] = token.split('.');
    const forgedPayload = Buffer.from(
      JSON.stringify({ scope: { kind: 'serve', cwd: '/etc' }, exp: Date.now() + 60_000 })
    ).toString('base64url');
    expect(() => signer.verify(`${forgedPayload}.${sig}`)).toThrowError(
      expect.objectContaining({ code: 'BAD_SIGNATURE' })
    );
  });

  it('rejects a MALFORMED token (no separator)', () => {
    const signer = new WorkbenchTokenSigner({ secret: SECRET });
    expect(() => signer.verify('not-a-token')).toThrowError(WorkbenchTokenError);
  });
});
