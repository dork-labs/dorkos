import { describe, expect, it, vi } from 'vitest';
import type { ServerPrincipalProof } from '../../../connectors/principal/server-principal.js';
import type { ConnectorRuntimePrincipalPort } from '../../../connectors/runtime-principal-port.js';
import type { ConnectorRuntimeTools } from '../../connector-tools.js';
import { createRuntimeTurnRenewalConformanceFixture } from '../../connectors/__tests__/turn-renewal-conformance-fixture.js';
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
    isConnectorCapabilityId: (id) => ids.has(id),
  };
}

function port(): ConnectorRuntimePrincipalPort {
  return {
    openTurn: vi.fn().mockResolvedValue({
      bindingId: 'binding-1',
      bearer: 'secret-1',
      expiresAt: '2099-01-01T00:00:00.000Z',
      renewalPermit: {} as never,
    }),
    renew: vi.fn(),
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
    expect(principals.openTurn).toHaveBeenCalledWith(
      {
        runtime: 'claude-code',
        canonicalSessionId: 'canonical-session',
        agentPath: '/repo',
        canonicalCwd: '/repo',
        signal: expect.any(AbortSignal),
      },
      { isCurrent: expect.any(Function) }
    );
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
      | ((value: {
          bindingId: string;
          bearer: string;
          expiresAt: string;
          renewalPermit: never;
        }) => void)
      | undefined;
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
      renewalPermit: {} as never,
    });

    await expect(resolving).rejects.toBeDefined();
    await cancellation;
    expect(principals.revoke).toHaveBeenCalledTimes(1);
    expect(principals.revoke).toHaveBeenCalledWith('binding-1', 'turn_cancelled');
  });

  it('gives consecutive persistent-process turns distinct bindings', async () => {
    const principals = port();
    const firstPermit = {} as never;
    const secondPermit = {} as never;
    const createLeaseSupervisor = vi.fn(() => ({
      state: 'active' as const,
      stop: vi.fn(),
      assertUsable: vi.fn(),
    }));
    vi.mocked(principals.openTurn)
      .mockResolvedValueOnce({
        bindingId: 'binding-1',
        bearer: 'secret-1',
        expiresAt: '2099-01-01T00:00:00.000Z',
        renewalPermit: firstPermit,
      })
      .mockResolvedValueOnce({
        bindingId: 'binding-2',
        bearer: 'secret-2',
        expiresAt: '2099-01-01T00:00:00.000Z',
        renewalPermit: secondPermit,
      });
    const tools = { ...tooling(principals), createLeaseSupervisor };
    const first = new ClaudeConnectorTurnContext({
      tools,
      canonicalSessionId: () => 'session-1',
      agentPath: '/repo',
      cwd: '/repo',
    });
    const second = new ClaudeConnectorTurnContext({
      tools,
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
    expect(createLeaseSupervisor).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ bindingId: 'binding-1', permit: firstPermit })
    );
    expect(createLeaseSupervisor).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ bindingId: 'binding-2', permit: secondPermit })
    );
  });

  it('registers exact turn ownership and stops supervision before revoke', async () => {
    const principals = port();
    const stop = vi.fn();
    const createLeaseSupervisor = vi.fn(() => ({
      state: 'active' as const,
      stop,
      assertUsable: vi.fn(),
    }));
    const context = new ClaudeConnectorTurnContext({
      tools: { ...tooling(principals), createLeaseSupervisor },
      canonicalSessionId: () => 'canonical-session',
      agentPath: '/repo',
      cwd: '/repo',
    });

    await context.resolvePrincipal();
    const ownership = vi.mocked(principals.openTurn).mock.calls[0]?.[1];
    expect(ownership?.isCurrent()).toBe(true);
    expect(createLeaseSupervisor).toHaveBeenCalledWith(
      expect.objectContaining({
        bindingId: 'binding-1',
        runtime: 'claude-code',
        permit: expect.any(Object),
      })
    );

    await context.revoke('turn_terminal');
    expect(ownership?.isCurrent()).toBe(false);
    expect(stop).toHaveBeenCalledBefore(vi.mocked(principals.revoke));
  });

  it('surfaces one terminal lease loss on the next in-process Connections call', async () => {
    const principals = port();
    let leaseLost = false;
    const assertUsable = vi.fn(() => {
      if (leaseLost) throw new Error('Connections access expired. Start a new turn to continue.');
    });
    const context = new ClaudeConnectorTurnContext({
      tools: {
        ...tooling(principals),
        createLeaseSupervisor: () => ({ state: 'active', stop: vi.fn(), assertUsable }),
      },
      canonicalSessionId: () => 'canonical-session',
      agentPath: '/repo',
      cwd: '/repo',
    });
    await context.resolvePrincipal();

    leaseLost = true;
    await expect(context.resolvePrincipal()).rejects.toThrow('Start a new turn');
    expect(principals.openTurn).toHaveBeenCalledOnce();
    expect(principals.resolve).toHaveBeenCalledOnce();
  });

  it('keeps the real turn principal renewable for 72 hours and closes it at terminal', async () => {
    const fixture = await createRuntimeTurnRenewalConformanceFixture('claude-code');
    const context = new ClaudeConnectorTurnContext({
      tools: {
        ...tooling(fixture.principals),
        createLeaseSupervisor: fixture.createLeaseSupervisor,
      },
      canonicalSessionId: () => 'claude-renewal-session',
      agentPath: '/repo',
      cwd: '/repo',
    });

    try {
      await context.resolvePrincipal();
      await fixture.advanceHours(72);
      await context.revoke('turn_terminal');
      await fixture.expectTerminalDenial();
    } finally {
      await context.revoke('turn_cancelled').catch(() => undefined);
      fixture.close();
    }
  });
});
