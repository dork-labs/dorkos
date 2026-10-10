import { describe, expect, it } from 'vitest';
import { REMOTE_EDGE_PROOF_OVERLAP_SECONDS } from '@dork-labs/cloud-api';
import {
  checkEdgeProof,
  dropPreviousEdgeProof,
  initialEdgeProofState,
  rotateEdgeProofState,
  stripEdgeProofHeaders,
} from '../edge-proof.js';

const OLD = { header: 'x-dorkos-edge', secret: 'a'.repeat(40) };
const NEW = { header: 'x-dorkos-edge', secret: 'b'.repeat(40) };
const T0 = 1_000_000;
const OVERLAP_MS = REMOTE_EDGE_PROOF_OVERLAP_SECONDS * 1000;

describe('checkEdgeProof', () => {
  const state = initialEdgeProofState(OLD);

  it('accepts exactly one matching copy, whatever the header case', () => {
    expect(checkEdgeProof(['Host', 'h', 'X-DorkOS-Edge', OLD.secret], state, T0)).toEqual({
      ok: true,
      matched: 'current',
    });
  });

  it('refuses a request with no copy', () => {
    expect(checkEdgeProof(['Host', 'h'], state, T0)).toEqual({ ok: false, reason: 'missing' });
  });

  it('refuses two copies even when one of them matches', () => {
    const raw = ['x-dorkos-edge', OLD.secret, 'X-DorkOS-Edge', OLD.secret];
    expect(checkEdgeProof(raw, state, T0)).toEqual({ ok: false, reason: 'duplicate' });
    const mixed = ['x-dorkos-edge', 'wrong', 'x-dorkos-edge', OLD.secret];
    expect(checkEdgeProof(mixed, state, T0)).toEqual({ ok: false, reason: 'duplicate' });
  });

  it('refuses a wrong value, including a prefix or an extension of the secret', () => {
    for (const value of ['wrong', OLD.secret.slice(1), `${OLD.secret}a`, '']) {
      expect(checkEdgeProof(['x-dorkos-edge', value], state, T0)).toEqual({
        ok: false,
        reason: 'mismatch',
      });
    }
  });
});

describe('rotation overlap', () => {
  const rotated = rotateEdgeProofState(initialEdgeProofState(OLD), NEW, T0);

  it('accepts the new secret at once', () => {
    expect(checkEdgeProof(['x-dorkos-edge', NEW.secret], rotated, T0)).toEqual({
      ok: true,
      matched: 'current',
    });
  });

  it('accepts the previous secret only within the overlap window', () => {
    const raw = ['x-dorkos-edge', OLD.secret];
    expect(checkEdgeProof(raw, rotated, T0 + OVERLAP_MS - 1)).toEqual({
      ok: true,
      matched: 'previous',
    });
    expect(checkEdgeProof(raw, rotated, T0 + OVERLAP_MS)).toEqual({
      ok: false,
      reason: 'mismatch',
    });
  });

  it('stops accepting the previous secret at once when it is dropped (revoke)', () => {
    const dropped = dropPreviousEdgeProof(rotated);
    expect(checkEdgeProof(['x-dorkos-edge', OLD.secret], dropped, T0)).toEqual({
      ok: false,
      reason: 'mismatch',
    });
  });

  it('never accepts a third secret: a second rotation forgets the first', () => {
    const third = { header: 'x-dorkos-edge', secret: 'c'.repeat(40) };
    const twice = rotateEdgeProofState(rotated, third, T0 + 1);
    expect(checkEdgeProof(['x-dorkos-edge', OLD.secret], twice, T0 + 2).ok).toBe(false);
    expect(checkEdgeProof(['x-dorkos-edge', NEW.secret], twice, T0 + 2).ok).toBe(true);
  });

  it('treats a repeat of the same proof as no rotation', () => {
    const same = rotateEdgeProofState(rotated, NEW, T0 + 5);
    expect(same).toBe(rotated);
  });
});

describe('stripEdgeProofHeaders', () => {
  it('removes every copy from both rawHeaders and headers', () => {
    const req = {
      rawHeaders: ['Host', 'h', 'X-DorkOS-Edge', OLD.secret, 'Accept', '*/*'],
      headers: { host: 'h', 'x-dorkos-edge': OLD.secret, accept: '*/*' } as Record<string, unknown>,
    };
    stripEdgeProofHeaders(req, initialEdgeProofState(OLD));
    expect(req.rawHeaders).toEqual(['Host', 'h', 'Accept', '*/*']);
    expect(req.headers).toEqual({ host: 'h', accept: '*/*' });
  });
});
