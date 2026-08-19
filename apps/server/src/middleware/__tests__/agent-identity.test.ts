import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { Request, Response, NextFunction } from 'express';
import { createTestDb } from '@dorkos/test-utils/db';
import {
  AgentIdentityService,
  initAgentIdentityService,
  resetAgentIdentityService,
} from '../../services/core/agent-identity/agent-identity-service.js';
import {
  resolveAgentIdentity,
  getRequestAgentIdentity,
  presentsAgentIdentity,
} from '../agent-identity.js';
import { logger } from '../../lib/logger.js';

vi.mock('../../lib/logger.js', () => ({
  logger: { warn: vi.fn(), debug: vi.fn(), info: vi.fn(), error: vi.fn() },
}));

const AGENT_PATH = '/projects/researcher';

/** Minimal Express doubles — the middleware only touches headers and locals. */
function makeReqRes(headers: Record<string, string | string[]> = {}) {
  const req = { headers, path: '/api/capabilities/demo.thing/invoke' } as unknown as Request;
  const res = { locals: {} as Record<string, unknown> } as unknown as Response;
  const next = vi.fn() as unknown as NextFunction;
  return { req, res, next };
}

describe('resolveAgentIdentity', () => {
  let service: AgentIdentityService;

  beforeEach(() => {
    resetAgentIdentityService();
    service = initAgentIdentityService(createTestDb());
  });

  afterEach(() => {
    resetAgentIdentityService();
    vi.restoreAllMocks();
  });

  it('resolves a valid token onto the request context', async () => {
    const token = await service.mint({ agentPath: AGENT_PATH, displayName: 'Researcher' });
    const { req, res, next } = makeReqRes({ 'x-dorkos-agent': token });

    await resolveAgentIdentity(req, res, next);

    expect(getRequestAgentIdentity(res)).toMatchObject({
      agentPath: AGENT_PATH,
      displayName: 'Researcher',
      tierCeiling: 'destructive',
    });
    expect(next).toHaveBeenCalledOnce();
  });

  it('tolerates surrounding whitespace on the header value', async () => {
    const token = await service.mint({ agentPath: AGENT_PATH, displayName: 'Researcher' });
    const { req, res, next } = makeReqRes({ 'x-dorkos-agent': `  ${token}  ` });

    await resolveAgentIdentity(req, res, next);

    expect(getRequestAgentIdentity(res)).toBeDefined();
    expect(next).toHaveBeenCalledOnce();
  });

  it('takes the first value when the header is repeated', async () => {
    const token = await service.mint({ agentPath: AGENT_PATH, displayName: 'Researcher' });
    const { req, res, next } = makeReqRes({ 'x-dorkos-agent': [token, 'second'] });

    await resolveAgentIdentity(req, res, next);

    expect(getRequestAgentIdentity(res)).toBeDefined();
  });

  // ── Identity is NEVER required: every miss falls through untouched ────────

  it('passes through with no identity when the header is absent', async () => {
    const { req, res, next } = makeReqRes();

    await resolveAgentIdentity(req, res, next);

    expect(getRequestAgentIdentity(res)).toBeUndefined();
    expect(res.locals).toEqual({});
    expect(next).toHaveBeenCalledOnce();
  });

  it('never touches the database when the header is absent', async () => {
    const resolveSpy = vi.spyOn(AgentIdentityService.prototype, 'resolve');
    const { req, res, next } = makeReqRes();

    await resolveAgentIdentity(req, res, next);

    expect(resolveSpy).not.toHaveBeenCalled();
    expect(next).toHaveBeenCalledOnce();
  });

  it('passes through with no identity for an unknown token', async () => {
    const { req, res, next } = makeReqRes({ 'x-dorkos-agent': 'bogus' });

    await resolveAgentIdentity(req, res, next);

    expect(getRequestAgentIdentity(res)).toBeUndefined();
    expect(next).toHaveBeenCalledOnce();
  });

  it('passes through with no identity for a revoked token', async () => {
    const token = await service.mint({ agentPath: AGENT_PATH, displayName: 'Researcher' });
    await service.revoke(AGENT_PATH);
    const { req, res, next } = makeReqRes({ 'x-dorkos-agent': token });

    await resolveAgentIdentity(req, res, next);

    expect(getRequestAgentIdentity(res)).toBeUndefined();
    expect(next).toHaveBeenCalledOnce();
  });

  it('passes through when the service was never initialized', async () => {
    resetAgentIdentityService();
    const { req, res, next } = makeReqRes({ 'x-dorkos-agent': 'anything' });

    await resolveAgentIdentity(req, res, next);

    expect(getRequestAgentIdentity(res)).toBeUndefined();
    expect(next).toHaveBeenCalledOnce();
  });

  it('calls next() and never rejects when resolution throws', async () => {
    vi.spyOn(AgentIdentityService.prototype, 'resolve').mockRejectedValueOnce(new Error('db down'));
    const { req, res, next } = makeReqRes({ 'x-dorkos-agent': 'token' });

    await expect(resolveAgentIdentity(req, res, next)).resolves.toBeUndefined();

    expect(getRequestAgentIdentity(res)).toBeUndefined();
    expect(next).toHaveBeenCalledOnce();
  });
});

/**
 * A presented token that resolves to nothing is what a revoked or expired agent
 * looks like from the operator's side. Without a line in the log that agent
 * silently degrades to "unattributed" forever, so the failure has to be visible —
 * and the credential still must never be.
 */
describe('resolveAgentIdentity — unresolved token visibility', () => {
  let service: AgentIdentityService;

  beforeEach(() => {
    resetAgentIdentityService();
    service = initAgentIdentityService(createTestDb());
    vi.mocked(logger.debug).mockClear();
  });

  afterEach(() => {
    resetAgentIdentityService();
  });

  it('logs a digest prefix, never the token, when a revoked token is presented', async () => {
    const token = await service.mint({ agentPath: AGENT_PATH, displayName: 'Researcher' });
    await service.revoke(AGENT_PATH);
    const { req, res, next } = makeReqRes({ 'x-dorkos-agent': token });

    await resolveAgentIdentity(req, res, next);

    expect(getRequestAgentIdentity(res)).toBeUndefined();
    expect(next).toHaveBeenCalledOnce();
    expect(logger.debug).toHaveBeenCalledWith(
      '[agent-identity] Presented token did not resolve',
      expect.objectContaining({ tokenDigestPrefix: expect.any(String) })
    );

    const logged = JSON.stringify(vi.mocked(logger.debug).mock.calls);
    expect(logged).not.toContain(token);
  });

  it('says nothing when a token resolves', async () => {
    const token = await service.mint({ agentPath: AGENT_PATH, displayName: 'Researcher' });
    const { req, res, next } = makeReqRes({ 'x-dorkos-agent': token });

    await resolveAgentIdentity(req, res, next);

    expect(logger.debug).not.toHaveBeenCalled();
  });

  it('says nothing when no token was presented at all', async () => {
    const { req, res, next } = makeReqRes();

    await resolveAgentIdentity(req, res, next);

    expect(logger.debug).not.toHaveBeenCalled();
  });
});

/**
 * `presentsAgentIdentity` is the wider question — "is a machine calling" rather
 * than "which agent is this" — and two surfaces refuse on it now:
 * `readCallerAuthority`'s `agentIdentityPresented` (the Ask's answer routes,
 * capability approvals) and `GET /api/rooms/:id/sessions` (DOR-1357). The case
 * that matters is the middle one: a token that did NOT resolve leaves `locals`
 * empty, so anything reading only {@link getRequestAgentIdentity} calls a revoked
 * agent a person.
 *
 * **Seeded defect:** drop the raw-header disjunct → "a token that resolved to
 * nothing" goes red, and only it.
 */
describe('presentsAgentIdentity', () => {
  beforeEach(() => {
    resetAgentIdentityService();
  });

  afterEach(() => {
    resetAgentIdentityService();
  });

  it('is true for a token the middleware resolved', async () => {
    const service = initAgentIdentityService(createTestDb());
    const token = await service.mint({ agentPath: AGENT_PATH, displayName: 'Researcher' });
    const { req, res, next } = makeReqRes({ 'x-dorkos-agent': token });
    await resolveAgentIdentity(req, res, next);

    expect(getRequestAgentIdentity(res)).toBeDefined();
    expect(presentsAgentIdentity(req, res)).toBe(true);
  });

  it('is true for a token that resolved to nothing, which is what a revoked agent looks like', async () => {
    const service = initAgentIdentityService(createTestDb());
    const token = await service.mint({ agentPath: AGENT_PATH, displayName: 'Researcher' });
    await service.revoke(AGENT_PATH);
    const { req, res, next } = makeReqRes({ 'x-dorkos-agent': token });
    await resolveAgentIdentity(req, res, next);

    // Nothing resolved — so the narrow reader says "no agent here", and the
    // wide one still says a machine called.
    expect(getRequestAgentIdentity(res)).toBeUndefined();
    expect(presentsAgentIdentity(req, res)).toBe(true);
  });

  it('is false when no header was presented at all, which is every person in the cockpit', () => {
    const { req, res } = makeReqRes();

    expect(presentsAgentIdentity(req, res)).toBe(false);
  });
});
