import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { Request, Response, NextFunction } from 'express';
import { createTestDb } from '@dorkos/test-utils/db';
import {
  AgentIdentityService,
  initAgentIdentityService,
  resetAgentIdentityService,
} from '../../services/core/agent-identity/agent-identity-service.js';
import { resolveAgentIdentity, getRequestAgentIdentity } from '../agent-identity.js';

vi.mock('../../lib/logger.js', () => ({
  logger: { warn: vi.fn(), debug: vi.fn(), info: vi.fn(), error: vi.fn() },
}));

const AGENT_PATH = '/projects/researcher';

/** Minimal Express doubles — the middleware only touches headers and locals. */
function makeReqRes(headers: Record<string, string | string[]> = {}) {
  const req = { headers } as unknown as Request;
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
