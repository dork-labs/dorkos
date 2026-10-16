/**
 * @vitest-environment node
 *
 * The setup-code step of an owner-less sign-up from another device (F5,
 * DOR-2968), and the one-release exception for a container's published port
 * (ADR 261015-125850 rule 11).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const posture = vi.hoisted(() => ({ insecureBind: false, refusal: 'required' as string | null }));
vi.mock('../gate-policy.js', () => ({
  isContainerPortClass: (requestClass: { reason?: string }) =>
    posture.insecureBind && requestClass.reason === 'peer-not-loopback',
}));
vi.mock('../setup-code.js', () => ({
  checkSetupCode: () => posture.refusal,
  currentSetupCodeAttempt: () => ({ code: undefined, address: '10.0.0.2' }),
}));
vi.mock('../../../../lib/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { refuseWithoutSetupCode } from '../setup-code-gate.js';
import { logger } from '../../../../lib/logger.js';

const CONTAINER_PORT = {
  kind: 'other-device',
  route: 'network',
  reason: 'peer-not-loopback',
} as const;
const TUNNEL = { kind: 'other-device', route: 'own-tunnel', reason: 'ingress' } as const;

describe('refuseWithoutSetupCode', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    posture.insecureBind = false;
    posture.refusal = 'required';
  });

  it('lets a browser at a container port in with no code, this release, and warns loudly', () => {
    posture.insecureBind = true;
    expect(() => refuseWithoutSetupCode(CONTAINER_PORT)).not.toThrow();
    expect(vi.mocked(logger.warn).mock.calls[0]?.[0]).toMatch(/setup code/);
  });

  it('asks the same request for a code when the container flag is off', () => {
    expect(() => refuseWithoutSetupCode(CONTAINER_PORT)).toThrow(
      expect.objectContaining({ body: expect.objectContaining({ code: 'SETUP_CODE_REQUIRED' }) })
    );
  });

  it('asks a tunnel for a code even inside a container', () => {
    posture.insecureBind = true;
    expect(() => refuseWithoutSetupCode(TUNNEL)).toThrow(
      expect.objectContaining({ body: expect.objectContaining({ code: 'SETUP_CODE_REQUIRED' }) })
    );
  });

  it.each([
    ['invalid', 'SETUP_CODE_INVALID'],
    ['too-many-attempts', 'SETUP_CODE_TOO_MANY_ATTEMPTS'],
  ])('answers a %s code with %s', (refusal, code) => {
    posture.refusal = refusal;
    expect(() => refuseWithoutSetupCode(TUNNEL)).toThrow(
      expect.objectContaining({ body: expect.objectContaining({ code }) })
    );
  });

  it('lets the request through when the code is good', () => {
    posture.refusal = null;
    expect(() => refuseWithoutSetupCode(TUNNEL)).not.toThrow();
  });
});
