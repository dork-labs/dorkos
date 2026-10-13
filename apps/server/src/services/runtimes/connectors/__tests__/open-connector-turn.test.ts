import { describe, it, expect, vi } from 'vitest';
import { ConnectorRuntimeAuthorityError } from '../../../connectors/principal/runtime-principal-service.js';
import type { ConnectorRuntimeTools } from '../../connector-tools.js';
import { openConnectorTurn, type OpenConnectorTurnRequest } from '../open-connector-turn.js';

const BINDING = {
  bindingId: 'binding-1',
  bearer: 'secret',
  expiresAt: '2099-01-01T00:00:00.000Z',
  renewalPermit: {} as never,
};

function tools(openTurn: ConnectorRuntimeTools['principals']['openTurn']) {
  const principals = { openTurn, renew: vi.fn(), resolve: vi.fn(), revoke: vi.fn() };
  return {
    principals: principals as unknown as ConnectorRuntimeTools['principals'],
    revoke: principals.revoke,
    listenerUrl: 'http://127.0.0.1:4341/mcp',
    agentToolsUrl: 'http://127.0.0.1:4341/agent-mcp',
    isConnectorCapabilityId: () => false,
    createLeaseSupervisor: vi.fn(() => ({
      state: 'active' as const,
      stop: vi.fn(),
      assertUsable: vi.fn(),
    })),
  };
}

function request(overrides: Partial<OpenConnectorTurnRequest> = {}): OpenConnectorTurnRequest {
  return {
    runtime: 'codex',
    sessionId: 's1',
    agentPath: '/agents/a',
    cwd: '/agents/a',
    signal: new AbortController().signal,
    isCurrent: () => true,
    onLost: vi.fn(),
    ...overrides,
  };
}

const refused = () => new ConnectorRuntimeAuthorityError('authority_refused', 'not confirmed');

describe('openConnectorTurn (DOR-2752)', () => {
  it('opens the binding, its lease and the MCP injection', async () => {
    const t = tools(vi.fn().mockResolvedValue(BINDING));
    const opened = await openConnectorTurn(t, request());
    expect(opened?.binding).toBe(BINDING);
    expect(opened?.injection.url).toBe(t.listenerUrl);
    expect(t.createLeaseSupervisor).toHaveBeenCalledOnce();
  });

  it('returns null when the chat’s agent cannot be confirmed', async () => {
    const t = tools(vi.fn().mockRejectedValue(refused()));
    await expect(openConnectorTurn(t, request())).resolves.toBeNull();
  });

  it('still throws when a newer turn replaced this one', async () => {
    const t = tools(vi.fn().mockRejectedValue(refused()));
    await expect(openConnectorTurn(t, request({ isCurrent: () => false }))).rejects.toThrow(
      ConnectorRuntimeAuthorityError
    );
  });

  it('still throws when the turn was cancelled', async () => {
    const controller = new AbortController();
    controller.abort(new Error('cancelled'));
    const t = tools(vi.fn().mockRejectedValue(refused()));
    await expect(openConnectorTurn(t, request({ signal: controller.signal }))).rejects.toThrow(
      'cancelled'
    );
  });

  it('still throws any other failure', async () => {
    const t = tools(vi.fn().mockRejectedValue(new Error('database is locked')));
    await expect(openConnectorTurn(t, request())).rejects.toThrow('database is locked');
  });

  it('revokes the binding when the lease cannot be set up', async () => {
    const t = tools(vi.fn().mockResolvedValue(BINDING));
    t.createLeaseSupervisor.mockImplementationOnce(() => {
      throw new Error('no lease');
    });
    await expect(openConnectorTurn(t, request())).rejects.toThrow('no lease');
    expect(t.revoke).toHaveBeenCalledWith('binding-1', 'setup_failed');
  });
});
