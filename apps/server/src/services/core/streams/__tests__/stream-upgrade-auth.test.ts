import { describe, it, expect, vi, beforeEach } from 'vitest';

// `vi.mock` is hoisted above every top-level binding, so the factories may not
// close over locals — they reach the spies through the mocked modules instead.
vi.mock('../../config-manager.js', () => ({
  configManager: { get: vi.fn() },
}));
vi.mock('../../auth/session-gate.js', () => ({
  verifyRequestAuth: vi.fn(),
}));
vi.mock('../../../../middleware/agent-identity.js', () => ({
  resolveAgentIdentityFromHeaders: vi.fn(),
}));

import type { AgentIdentity } from '../../agent-identity/agent-identity-service.js';
import { authorizeStreamUpgrade } from '../stream-upgrade-auth.js';
import { configManager } from '../../config-manager.js';
import { verifyRequestAuth as verifyRequestAuthImport } from '../../auth/session-gate.js';
import { resolveAgentIdentityFromHeaders as resolveAgentIdentityImport } from '../../../../middleware/agent-identity.js';

const configGet = vi.mocked(configManager.get);
const verifyRequestAuth = vi.mocked(verifyRequestAuthImport);
const resolveAgentIdentityFromHeaders = vi.mocked(resolveAgentIdentityImport);

/** A resolved agent identity, as the middleware would return one. */
const ALPHA: AgentIdentity = {
  agentPath: '/agents/alpha',
  displayName: 'Alpha',
  tierCeiling: 'observe',
  createdAt: '2026-08-04T00:00:00.000Z',
};

/**
 * The credential gate for durable-stream upgrades.
 *
 * This stands in for `sessionGate`, which does NOT run for a WebSocket upgrade
 * because an upgrade never enters Express. Without it, moving the cockpit's
 * streams onto sockets would have silently un-gated all three on an install
 * with login enabled: same URL, same data, no credential. That is the whole
 * reason these tests exist, so they assert the refusal as hard as the pass.
 */
describe('authorizeStreamUpgrade', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resolveAgentIdentityFromHeaders.mockResolvedValue(undefined);
  });

  it('passes through with no identity when login is disabled', async () => {
    configGet.mockReturnValue({ enabled: false });

    const result = await authorizeStreamUpgrade({});

    expect(result).toEqual({ ok: true, locals: {} });
    expect(verifyRequestAuth, 'no credential work when the gate is off').not.toHaveBeenCalled();
  });

  it('REFUSES with 401 when login is enabled and no credential verifies', async () => {
    configGet.mockReturnValue({ enabled: true });
    verifyRequestAuth.mockResolvedValue(null);

    const result = await authorizeStreamUpgrade({ cookie: 'nonsense=1' });

    expect(result).toEqual({ ok: false, status: 401, message: 'Unauthorized' });
  });

  it('attaches the verified user when login is enabled and a cookie verifies', async () => {
    configGet.mockReturnValue({ enabled: true });
    verifyRequestAuth.mockResolvedValue({ userId: 'user-1', credential: 'cookie' });

    const result = await authorizeStreamUpgrade({ cookie: 'session=good' });

    expect(result).toEqual({
      ok: true,
      locals: { user: { userId: 'user-1', credential: 'cookie' } },
    });
  });

  it('accepts a per-user API key exactly as the HTTP gate does', async () => {
    configGet.mockReturnValue({ enabled: true });
    verifyRequestAuth.mockResolvedValue({ userId: 'user-1', credential: 'api-key' });

    const result = await authorizeStreamUpgrade({ authorization: 'Bearer key' });

    expect(result).toMatchObject({ ok: true, locals: { user: { credential: 'api-key' } } });
  });

  it('hands the upgrade headers to the SAME verifier the HTTP gate uses', async () => {
    // One credential path, not two: a second implementation is how the socket
    // gate and the request gate would drift apart without anyone noticing.
    configGet.mockReturnValue({ enabled: true });
    verifyRequestAuth.mockResolvedValue({ userId: 'user-1', credential: 'cookie' });
    const headers = { cookie: 'session=good', origin: 'http://localhost:4242' };

    await authorizeStreamUpgrade(headers);

    expect(verifyRequestAuth).toHaveBeenCalledWith({ headers });
  });

  it('resolves an agent identity additively, never as a rejection', async () => {
    // A room stream is membership-scoped and an agent reading one must resolve
    // to itself rather than to the operator. Identity is attribution, so a
    // token that does not resolve leaves the caller unattributed, not refused.
    configGet.mockReturnValue({ enabled: false });
    resolveAgentIdentityFromHeaders.mockResolvedValue(ALPHA);

    const result = await authorizeStreamUpgrade({ 'x-dorkos-agent': 'token' });

    expect(result).toEqual({ ok: true, locals: { agentIdentity: ALPHA } });
  });

  it('refuses BEFORE resolving an agent identity when the credential fails', async () => {
    configGet.mockReturnValue({ enabled: true });
    verifyRequestAuth.mockResolvedValue(null);

    await authorizeStreamUpgrade({ 'x-dorkos-agent': 'token' });

    expect(resolveAgentIdentityFromHeaders).not.toHaveBeenCalled();
  });
});
