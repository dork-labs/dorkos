import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createTestDb } from '@dorkos/test-utils/db';
import {
  AgentIdentityService,
  initAgentIdentityService,
  resetAgentIdentityService,
} from '../../services/core/agent-identity/agent-identity-service.js';
import { resolveAgentIdentityFromHeaders, presentsAgentIdentity } from '../agent-identity.js';
import type { AgentIdentity } from '../../services/core/agent-identity/agent-identity-service.js';
import { logger } from '../../lib/logger.js';
import { requestFactsFor } from '../../http/__tests__/described-request.js';

vi.mock('../../lib/logger.js', () => ({
  logger: { warn: vi.fn(), debug: vi.fn(), info: vi.fn(), error: vi.fn() },
}));

const AGENT_PATH = '/projects/researcher';

/** A request's headers, and where the chain's identity step leaves what it resolved. */
function makeReqRes(headers: Record<string, string | string[]> = {}) {
  const req = { headers, path: '/api/capabilities/demo.thing/invoke' };
  const res: { identity?: AgentIdentity } = {};
  return { req, res };
}

/** The chain's agent-identity step (`http/api-chain.ts`), for one request. */
async function resolveAgentIdentity(
  req: ReturnType<typeof makeReqRes>['req'],
  res: ReturnType<typeof makeReqRes>['res']
): Promise<void> {
  const identity = await resolveAgentIdentityFromHeaders(req.headers, req.path);
  if (identity) res.identity = identity;
}

/** What the identity step resolved for a request. */
function getRequestAgentIdentity(res: ReturnType<typeof makeReqRes>['res']) {
  return res.identity;
}

/** The facts a policy reads for the request. */
function factsOf(
  req: ReturnType<typeof makeReqRes>['req'],
  res: ReturnType<typeof makeReqRes>['res']
) {
  return { headers: req.headers, agentIdentity: res.identity };
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
    const { req, res } = makeReqRes({ 'x-dorkos-agent': token });

    await resolveAgentIdentity(req, res);

    expect(getRequestAgentIdentity(res)).toMatchObject({
      agentPath: AGENT_PATH,
      displayName: 'Researcher',
    });
  });

  it('tolerates surrounding whitespace on the header value', async () => {
    const token = await service.mint({ agentPath: AGENT_PATH, displayName: 'Researcher' });
    const { req, res } = makeReqRes({ 'x-dorkos-agent': `  ${token}  ` });

    await resolveAgentIdentity(req, res);

    expect(getRequestAgentIdentity(res)).toBeDefined();
  });

  it('takes the first value when the header is repeated', async () => {
    const token = await service.mint({ agentPath: AGENT_PATH, displayName: 'Researcher' });
    const { req, res } = makeReqRes({ 'x-dorkos-agent': [token, 'second'] });

    await resolveAgentIdentity(req, res);

    expect(getRequestAgentIdentity(res)).toBeDefined();
  });

  // ── Identity is NEVER required: every miss falls through untouched ────────

  it('passes through with no identity when the header is absent', async () => {
    const { req, res } = makeReqRes();

    await resolveAgentIdentity(req, res);

    expect(getRequestAgentIdentity(res)).toBeUndefined();
    expect(res).toEqual({});
  });

  it('never touches the database when the header is absent', async () => {
    const resolveSpy = vi.spyOn(AgentIdentityService.prototype, 'resolve');
    const { req, res } = makeReqRes();

    await resolveAgentIdentity(req, res);

    expect(resolveSpy).not.toHaveBeenCalled();
  });

  it('passes through with no identity for an unknown token', async () => {
    const { req, res } = makeReqRes({ 'x-dorkos-agent': 'bogus' });

    await resolveAgentIdentity(req, res);

    expect(getRequestAgentIdentity(res)).toBeUndefined();
  });

  it('passes through NAMING a revoked token, marked as shut off', async () => {
    // Changed contract, and the change is the point (DOR-486). This used to
    // resolve to `undefined`, which every consumer reads as "unidentified" — and
    // an unidentified caller gets the WIDEST tier ceiling, so revoking a capped
    // agent widened it. The identity is now carried and marked instead, and each
    // consumer fails closed on the mark: the tier gate caps it at `observe`, the
    // tool-group gate hands it no grant, and `room-caller.ts` still 401s.
    const token = await service.mint({ agentPath: AGENT_PATH, displayName: 'Researcher' });
    await service.revoke(AGENT_PATH);
    const { req, res } = makeReqRes({ 'x-dorkos-agent': token });

    await resolveAgentIdentity(req, res);

    expect(getRequestAgentIdentity(res)).toMatchObject({
      agentPath: AGENT_PATH,
      inactive: 'revoked',
    });
    // Still never rejects: identity is attribution, not authorization.
  });

  it('passes through when the service was never initialized', async () => {
    resetAgentIdentityService();
    const { req, res } = makeReqRes({ 'x-dorkos-agent': 'anything' });

    await resolveAgentIdentity(req, res);

    expect(getRequestAgentIdentity(res)).toBeUndefined();
  });

  it('never rejects when resolution throws', async () => {
    vi.spyOn(AgentIdentityService.prototype, 'resolve').mockRejectedValueOnce(new Error('db down'));
    const { req, res } = makeReqRes({ 'x-dorkos-agent': 'token' });

    await expect(resolveAgentIdentity(req, res)).resolves.toBeUndefined();

    expect(getRequestAgentIdentity(res)).toBeUndefined();
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

  it('logs a digest prefix, never the token, when an unknown token is presented', async () => {
    // A token from NO agent, which is the case that still resolves to nothing.
    // A revoked one no longer does — it resolves to a marked identity and is
    // refused loudly at the gates, which is louder than a debug line (DOR-486).
    const token = 'deadbeefdeadbeefdeadbeefdeadbeef';
    const { req, res } = makeReqRes({ 'x-dorkos-agent': token });

    await resolveAgentIdentity(req, res);

    expect(getRequestAgentIdentity(res)).toBeUndefined();
    expect(logger.debug).toHaveBeenCalledWith(
      '[agent-identity] Presented token did not resolve',
      expect.objectContaining({ tokenDigestPrefix: expect.any(String) })
    );

    const logged = JSON.stringify(vi.mocked(logger.debug).mock.calls);
    expect(logged).not.toContain(token);
  });

  it('says nothing when a token resolves', async () => {
    const token = await service.mint({ agentPath: AGENT_PATH, displayName: 'Researcher' });
    const { req, res } = makeReqRes({ 'x-dorkos-agent': token });

    await resolveAgentIdentity(req, res);

    expect(logger.debug).not.toHaveBeenCalled();
  });

  it('says nothing when no token was presented at all', async () => {
    const { req, res } = makeReqRes();

    await resolveAgentIdentity(req, res);

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
    const { req, res } = makeReqRes({ 'x-dorkos-agent': token });
    await resolveAgentIdentity(req, res);

    expect(getRequestAgentIdentity(res)).toBeDefined();
    expect(presentsAgentIdentity(factsOf(req, res))).toBe(true);
  });

  it('is true for a token that resolved to nothing, which is what an unknown token looks like', async () => {
    initAgentIdentityService(createTestDb());
    const { req, res } = makeReqRes({ 'x-dorkos-agent': 'deadbeefdeadbeefdeadbeefdeadbeef' });
    await resolveAgentIdentity(req, res);

    // Nothing resolved — so the narrow reader says "no agent here", and the
    // wide one still says a machine called.
    expect(getRequestAgentIdentity(res)).toBeUndefined();
    expect(presentsAgentIdentity(factsOf(req, res))).toBe(true);
  });

  it('is false when no header was presented at all, which is every person in the cockpit', () => {
    const { req, res } = makeReqRes();

    expect(presentsAgentIdentity(factsOf(req, res))).toBe(false);
  });
});

/**
 * The same question asked of a request's facts as `honoRequestFacts` builds
 * them, which is how every route asks it.
 */
describe('presentsAgentIdentity, on facts built by the chain', () => {
  it('is true for an identity the middleware resolved', async () => {
    const facts = await requestFactsFor({
      headers: { 'x-dorkos-agent': 'token' },
      agentIdentity: { agentId: 'agent_1' } as never,
    });
    expect(presentsAgentIdentity(facts)).toBe(true);
  });

  it('is true for a header that resolved to nothing', async () => {
    expect(
      presentsAgentIdentity(await requestFactsFor({ headers: { 'x-dorkos-agent': 'x' } }))
    ).toBe(true);
  });

  it('is false when no header was presented at all', async () => {
    expect(presentsAgentIdentity(await requestFactsFor({ headers: {} }))).toBe(false);
  });
});
