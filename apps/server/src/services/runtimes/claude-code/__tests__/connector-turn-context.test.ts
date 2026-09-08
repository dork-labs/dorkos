import { describe, expect, it, vi } from 'vitest';
import type { ServerPrincipalProof } from '../../../connectors/principal/server-principal.js';
import type { ConnectorRuntimePrincipalPort } from '../../../connectors/runtime-principal-port.js';
import type { ConnectorRuntimeTools } from '../../connector-tools.js';
import { ClaudeConnectorTurnContext } from '../connector-turn-context.js';

const principal = {
  claims: {
    kind: 'runtime',
    owner: { kind: 'local_install', installationId: 'install-1' },
    bindingId: 'binding-1',
    runtime: 'claude-code',
    canonicalSessionId: 'canonical-session',
    agentId: 'agent-1',
    agentPath: '/repo',
    canonicalCwd: '/repo',
  },
} as ServerPrincipalProof;

function tooling(port: ConnectorRuntimePrincipalPort): ConnectorRuntimeTools {
  const ids = new Set([
    'connectors.execute_read',
    'connectors.execute_write',
    'connectors.execute_destructive',
  ]);
  return {
    principals: port,
    listenerUrl: 'http://127.0.0.1:4341/mcp',
    agentToolsUrl: 'http://127.0.0.1:4341/agent-mcp',
    isConnectorCapabilityId: (id) => ids.has(id),
  };
}

function port(): ConnectorRuntimePrincipalPort {
  return {
    openTurn: vi.fn().mockResolvedValue({
      bindingId: 'binding-1',
      bearer: 'secret-1',
      expiresAt: '2099-01-01T00:00:00.000Z',
    }),
    resolve: vi.fn().mockResolvedValue({ status: 'resolved', principal }),
    revoke: vi.fn().mockResolvedValue(undefined),
  };
}

describe('ClaudeConnectorTurnContext', () => {
  it('opens lazily with the SDK canonical id observed at tool-call time', async () => {
    const principals = port();
    let canonicalSessionId = 'request-id';
    const context = new ClaudeConnectorTurnContext({
      tools: tooling(principals),
      canonicalSessionId: () => canonicalSessionId,
      agentPath: '/repo',
      cwd: '/repo',
    });

    expect(principals.openTurn).not.toHaveBeenCalled();
    canonicalSessionId = 'canonical-session';
    await expect(context.resolvePrincipal()).resolves.toBe(principal);
    await expect(context.resolvePrincipal()).resolves.toBe(principal);

    expect(principals.openTurn).toHaveBeenCalledTimes(1);
    expect(principals.openTurn).toHaveBeenCalledWith({
      runtime: 'claude-code',
      canonicalSessionId: 'canonical-session',
      agentPath: '/repo',
      canonicalCwd: '/repo',
      signal: expect.any(AbortSignal),
    });
    expect(principals.resolve).toHaveBeenCalledWith({
      bearer: 'secret-1',
      expectedRuntime: 'claude-code',
      expectedCanonicalCwd: '/repo',
    });
  });

  it('uses the broker-owned exact capability predicate', () => {
    const context = new ClaudeConnectorTurnContext({
      tools: tooling(port()),
      canonicalSessionId: () => 'canonical-session',
      agentPath: '/repo',
      cwd: '/repo',
    });

    expect(context.isConnectorCapabilityId('connectors.execute_read')).toBe(true);
    expect(context.isConnectorCapabilityId('connector_attach_account')).toBe(false);
    expect(context.isConnectorCapabilityId('marketplace.install')).toBe(false);
    expect(context.isConnectorCapabilityId('connectors.execute_read_suffix')).toBe(false);
  });

  it('revokes a refused structural resolution as setup failure', async () => {
    const principals = port();
    vi.mocked(principals.resolve).mockResolvedValue({
      status: 'refused',
      reason: 'authority_changed',
    });
    const context = new ClaudeConnectorTurnContext({
      tools: tooling(principals),
      canonicalSessionId: () => 'canonical-session',
      agentPath: '/repo',
      cwd: '/repo',
    });

    await expect(context.resolvePrincipal()).rejects.toThrow(/unavailable/);
    expect(principals.revoke).toHaveBeenCalledWith('binding-1', 'setup_failed');
  });

  it('revokes cancellation that races binding creation', async () => {
    const principals = port();
    let finishOpen:
      ((value: { bindingId: string; bearer: string; expiresAt: string }) => void) | undefined;
    vi.mocked(principals.openTurn).mockImplementation(
      () =>
        new Promise((resolve) => {
          finishOpen = resolve;
        })
    );
    const context = new ClaudeConnectorTurnContext({
      tools: tooling(principals),
      canonicalSessionId: () => 'canonical-session',
      agentPath: '/repo',
      cwd: '/repo',
    });

    const resolving = context.resolvePrincipal();
    const cancellation = context.cancel();
    finishOpen?.({
      bindingId: 'binding-1',
      bearer: 'secret-1',
      expiresAt: '2099-01-01T00:00:00.000Z',
    });

    await expect(resolving).rejects.toBeDefined();
    await cancellation;
    expect(principals.revoke).toHaveBeenCalledTimes(1);
    expect(principals.revoke).toHaveBeenCalledWith('binding-1', 'turn_cancelled');
  });

  it('gives consecutive persistent-process turns distinct bindings', async () => {
    const principals = port();
    vi.mocked(principals.openTurn)
      .mockResolvedValueOnce({
        bindingId: 'binding-1',
        bearer: 'secret-1',
        expiresAt: '2099-01-01T00:00:00.000Z',
      })
      .mockResolvedValueOnce({
        bindingId: 'binding-2',
        bearer: 'secret-2',
        expiresAt: '2099-01-01T00:00:00.000Z',
      });
    const first = new ClaudeConnectorTurnContext({
      tools: tooling(principals),
      canonicalSessionId: () => 'session-1',
      agentPath: '/repo',
      cwd: '/repo',
    });
    const second = new ClaudeConnectorTurnContext({
      tools: tooling(principals),
      canonicalSessionId: () => 'session-1',
      agentPath: '/repo',
      cwd: '/repo',
    });

    await first.resolvePrincipal();
    await first.revoke('turn_terminal');
    await second.resolvePrincipal();
    await second.revoke('turn_terminal');

    expect(principals.revoke).toHaveBeenNthCalledWith(1, 'binding-1', 'turn_terminal');
    expect(principals.revoke).toHaveBeenNthCalledWith(2, 'binding-2', 'turn_terminal');
  });
});
