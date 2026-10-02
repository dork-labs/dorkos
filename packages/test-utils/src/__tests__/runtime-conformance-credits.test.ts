/**
 * The credits gate's own judgments (ADR 261001-000811): the declaration rule a
 * runtime's wiring is held to, and the search that decides whether a token
 * reached a backend.
 */
import { describe, expect, it } from 'vitest';
import {
  CONFORMANCE_CREDITS_TOKEN,
  evaluateCreditsDeclaration,
  handedCarriesToken,
} from '../runtime-conformance.js';

describe('the credits declaration rule', () => {
  it('accepts a driver or a written reason, never both and never neither', () => {
    expect(evaluateCreditsDeclaration(true, undefined)).toBeNull();
    expect(evaluateCreditsDeclaration(false, 'a live binary cannot be read back')).toBeNull();
    expect(evaluateCreditsDeclaration(true, 'and a reason')).not.toBeNull();
    expect(evaluateCreditsDeclaration(false, undefined)).not.toBeNull();
    expect(evaluateCreditsDeclaration(false, '   ')).not.toBeNull();
  });
});

describe('finding a token in what a backend was handed', () => {
  it('finds it anywhere, however deep', () => {
    expect(
      handedCarriesToken(
        [{ env: { PATH: '/bin', DEEP: { x: `Bearer ${CONFORMANCE_CREDITS_TOKEN}` } } }],
        CONFORMANCE_CREDITS_TOKEN
      )
    ).toBe(true);
  });

  it('reports a clean observation as clean', () => {
    expect(handedCarriesToken({ env: { PATH: '/bin' } }, CONFORMANCE_CREDITS_TOKEN)).toBe(false);
    expect(handedCarriesToken(undefined, CONFORMANCE_CREDITS_TOKEN)).toBe(false);
  });

  it('never reads something it cannot search as clean', () => {
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    expect(handedCarriesToken(cyclic, CONFORMANCE_CREDITS_TOKEN)).toBe(true);
  });
});
