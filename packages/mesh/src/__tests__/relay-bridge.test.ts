import { describe, it, expect, vi } from 'vitest';
import { RelayBridge, subjectForAgent } from '../relay-bridge.js';
import type { AgentManifest } from '@dorkos/shared/mesh-schemas';
import type { SignalEmitter } from '@dorkos/relay';

// ---------------------------------------------------------------------------
// Mock RelayCore
// ---------------------------------------------------------------------------

function makeMockSignalEmitter(): SignalEmitter {
  return { emit: vi.fn() } as unknown as SignalEmitter;
}

function makeMockRelayCore() {
  return {
    registerEndpoint: vi.fn().mockResolvedValue({ hash: 'abc', subject: 'relay.agent.proj.01A' }),
    unregisterEndpoint: vi.fn().mockResolvedValue(true),
    addAccessRule: vi.fn(),
    removeAccessRule: vi.fn(),
    listAccessRules: vi.fn().mockReturnValue([]),
  };
}

function makeManifest(overrides: Partial<AgentManifest> = {}): AgentManifest {
  return {
    id: '01JKABC00001',
    name: 'test-agent',
    description: '',
    runtime: 'claude-code',
    capabilities: [],
    behavior: { responseMode: 'always' },
    budget: { maxHopsPerMessage: 5, maxCallsPerHour: 100 },
    registeredAt: '2026-02-24T00:00:00.000Z',
    registeredBy: 'test',
    personaEnabled: true,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// registerAgent
// ---------------------------------------------------------------------------

describe('registerAgent', () => {
  it('with namespace creates endpoint at relay.agent.{ns}.{id}', async () => {
    const relay = makeMockRelayCore();
    const bridge = new RelayBridge(relay as never);
    const manifest = makeManifest({ id: '01JKABC00001' });

    const subject = await bridge.registerAgent(manifest, '/projects/my-agent', 'my-ns');

    expect(relay.registerEndpoint).toHaveBeenCalledWith('relay.agent.my-ns.01JKABC00001');
    expect(subject).toBe('relay.agent.my-ns.01JKABC00001');
  });

  it('without namespace falls back to path.basename(projectPath)', async () => {
    const relay = makeMockRelayCore();
    const bridge = new RelayBridge(relay as never);
    const manifest = makeManifest({ id: 'MYID' });

    const subject = await bridge.registerAgent(manifest, '/home/user/projects/my-project');

    expect(subject).toBe('relay.agent.my-project.MYID');
    expect(relay.registerEndpoint).toHaveBeenCalledWith('relay.agent.my-project.MYID');
  });

  it('calls addAccessRule twice: same-ns allow + cross-ns deny', async () => {
    const relay = makeMockRelayCore();
    const bridge = new RelayBridge(relay as never);
    const manifest = makeManifest({ id: '01A' });

    await bridge.registerAgent(manifest, '/projects/proj', 'test-ns');

    expect(relay.addAccessRule).toHaveBeenCalledTimes(2);
  });

  it('system agents get bidirectional cross-namespace allow rules above the deny', async () => {
    // DorkBot (namespace "system") runs background tasks and onboarding for
    // every project agent. With cross-namespace deny enforced, it needs a
    // higher-priority allow in both directions or the system agent is bricked.
    const relay = makeMockRelayCore();
    const bridge = new RelayBridge(relay as never);
    const manifest = makeManifest({ id: 'DORKBOT01', isSystem: true, namespace: 'system' });

    await bridge.registerAgent(manifest, '/home/user/.dork/agents/dorkbot', 'system');

    const rules = relay.addAccessRule.mock.calls.map(([r]) => r);
    expect(rules).toContainEqual({
      from: 'relay.agent.system.*',
      to: 'relay.agent.>',
      action: 'allow',
      priority: 200,
    });
    expect(rules).toContainEqual({
      from: 'relay.agent.>',
      to: 'relay.agent.system.*',
      action: 'allow',
      priority: 200,
    });
    // The system allow must outrank both default rules (allow 100, deny 10).
    const denyRule = rules.find((r) => r.action === 'deny');
    expect(denyRule!.priority).toBeLessThan(200);
  });

  it('non-system agents get no system allow rules', async () => {
    const relay = makeMockRelayCore();
    const bridge = new RelayBridge(relay as never);

    await bridge.registerAgent(makeManifest({ id: '01A' }), '/projects/proj', 'test-ns');

    const rules = relay.addAccessRule.mock.calls.map(([r]) => r);
    expect(rules.filter((r) => r.priority === 200)).toHaveLength(0);
  });

  it('re-asserts access rules even when the endpoint is already registered', async () => {
    // Upgrades can introduce new default rules (e.g. the system-agent allow);
    // the old early-return on "already registered" skipped rule assertion and
    // left existing installs without them.
    const relay = makeMockRelayCore();
    relay.registerEndpoint = vi.fn().mockRejectedValue(new Error('Endpoint already registered'));
    const bridge = new RelayBridge(relay as never);
    const manifest = makeManifest({ id: 'DORKBOT01', isSystem: true, namespace: 'system' });

    const subject = await bridge.registerAgent(
      manifest,
      '/home/user/.dork/agents/dorkbot',
      'system'
    );

    expect(subject).toBe('relay.agent.system.DORKBOT01');
    // 2 default rules + 2 system allow rules, despite the existing endpoint.
    expect(relay.addAccessRule).toHaveBeenCalledTimes(4);
  });

  it('same-namespace allow rule has priority 100', async () => {
    const relay = makeMockRelayCore();
    const bridge = new RelayBridge(relay as never);
    const manifest = makeManifest({ id: '01A' });

    await bridge.registerAgent(manifest, '/projects/proj', 'test-ns');

    expect(relay.addAccessRule).toHaveBeenCalledWith({
      from: 'relay.agent.test-ns.*',
      to: 'relay.agent.test-ns.*',
      action: 'allow',
      priority: 100,
    });
  });

  it('cross-namespace deny rule has priority 10', async () => {
    const relay = makeMockRelayCore();
    const bridge = new RelayBridge(relay as never);
    const manifest = makeManifest({ id: '01A' });

    await bridge.registerAgent(manifest, '/projects/proj', 'test-ns');

    expect(relay.addAccessRule).toHaveBeenCalledWith({
      from: 'relay.agent.test-ns.*',
      to: 'relay.agent.>',
      action: 'deny',
      priority: 10,
    });
  });

  it('returns the registered subject string', async () => {
    const relay = makeMockRelayCore();
    const bridge = new RelayBridge(relay as never);
    const manifest = makeManifest({ id: '01A' });

    const result = await bridge.registerAgent(manifest, '/projects/proj');

    expect(result).toBe('relay.agent.proj.01A');
  });

  it('returns null when RelayCore is not provided', async () => {
    const bridge = new RelayBridge();
    const manifest = makeManifest();

    const result = await bridge.registerAgent(manifest, '/projects/proj');

    expect(result).toBeNull();
  });

  it('does not throw when RelayCore is undefined (no-op)', async () => {
    const bridge = new RelayBridge(undefined);

    await expect(bridge.registerAgent(makeManifest(), '/projects/proj')).resolves.toBeNull();
  });

  it('does not call addAccessRule when RelayCore is undefined', async () => {
    const bridge = new RelayBridge(undefined);

    await bridge.registerAgent(makeManifest(), '/projects/proj');

    // No relay to call — just verifying no error thrown
  });
});

// ---------------------------------------------------------------------------
// unregisterAgent
// ---------------------------------------------------------------------------

describe('unregisterAgent', () => {
  it('calls unregisterEndpoint with the provided subject', async () => {
    const relay = makeMockRelayCore();
    const bridge = new RelayBridge(relay as never);

    await bridge.unregisterAgent('relay.agent.proj.01A');

    expect(relay.unregisterEndpoint).toHaveBeenCalledWith('relay.agent.proj.01A');
  });

  it('is a no-op when RelayCore is not provided', async () => {
    const bridge = new RelayBridge();

    // Should not throw
    await expect(bridge.unregisterAgent('relay.agent.proj.01A')).resolves.toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// cleanupNamespaceRules
// ---------------------------------------------------------------------------

describe('cleanupNamespaceRules', () => {
  it('calls removeAccessRule twice for the namespace', () => {
    const relay = makeMockRelayCore();
    const bridge = new RelayBridge(relay as never);

    bridge.cleanupNamespaceRules('test-ns');

    expect(relay.removeAccessRule).toHaveBeenCalledTimes(2);
  });

  it('removes the same-namespace allow rule', () => {
    const relay = makeMockRelayCore();
    const bridge = new RelayBridge(relay as never);

    bridge.cleanupNamespaceRules('test-ns');

    expect(relay.removeAccessRule).toHaveBeenCalledWith(
      'relay.agent.test-ns.*',
      'relay.agent.test-ns.*'
    );
  });

  it('removes the cross-namespace deny rule', () => {
    const relay = makeMockRelayCore();
    const bridge = new RelayBridge(relay as never);

    bridge.cleanupNamespaceRules('test-ns');

    expect(relay.removeAccessRule).toHaveBeenCalledWith('relay.agent.test-ns.*', 'relay.agent.>');
  });

  it('is a no-op when RelayCore is not provided', () => {
    const bridge = new RelayBridge();

    // Should not throw
    bridge.cleanupNamespaceRules('test-ns');
  });
});

// ---------------------------------------------------------------------------
// SignalEmitter lifecycle signals
// ---------------------------------------------------------------------------

describe('lifecycle signals — registerAgent', () => {
  it('emits mesh.agent.lifecycle.registered after successful registration', async () => {
    const relay = makeMockRelayCore();
    const emitter = makeMockSignalEmitter();
    const bridge = new RelayBridge(relay as never, emitter);
    const manifest = makeManifest({ id: '01JKABC00001', name: 'test-agent' });

    await bridge.registerAgent(manifest, '/projects/my-agent', 'my-ns');

    expect(emitter.emit).toHaveBeenCalledOnce();
    expect(emitter.emit).toHaveBeenCalledWith(
      'mesh.agent.lifecycle.registered',
      expect.objectContaining({
        type: 'progress',
        state: 'registered',
        endpointSubject: 'mesh.agent.lifecycle.registered',
        data: expect.objectContaining({
          agentId: '01JKABC00001',
          agentName: 'test-agent',
          event: 'registered',
        }),
      })
    );
  });
});

describe('lifecycle signals — unregisterAgent', () => {
  it('emits mesh.agent.lifecycle.unregistered after successful unregistration', async () => {
    const relay = makeMockRelayCore();
    const emitter = makeMockSignalEmitter();
    const bridge = new RelayBridge(relay as never, emitter);

    await bridge.unregisterAgent('relay.agent.my-ns.01JKABC00001', '01JKABC00001', 'test-agent');

    expect(emitter.emit).toHaveBeenCalledOnce();
    expect(emitter.emit).toHaveBeenCalledWith(
      'mesh.agent.lifecycle.unregistered',
      expect.objectContaining({
        type: 'progress',
        state: 'unregistered',
        endpointSubject: 'mesh.agent.lifecycle.unregistered',
        data: expect.objectContaining({
          agentId: '01JKABC00001',
          agentName: 'test-agent',
          event: 'unregistered',
        }),
      })
    );
  });
});

describe('lifecycle signals — no signalEmitter', () => {
  it('does not emit any signal when signalEmitter is undefined', async () => {
    const relay = makeMockRelayCore();
    // No signalEmitter passed — bridge must work silently as a no-op
    const bridge = new RelayBridge(relay as never);
    const manifest = makeManifest({ id: '01JKABC00001' });

    // Both operations must complete without throwing
    await expect(bridge.registerAgent(manifest, '/projects/my-agent', 'my-ns')).resolves.toBe(
      'relay.agent.my-ns.01JKABC00001'
    );
    await expect(bridge.unregisterAgent('relay.agent.my-ns.01JKABC00001')).resolves.toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// subjectForAgent
// ---------------------------------------------------------------------------

describe('subjectForAgent', () => {
  it('uses the namespace when set', () => {
    expect(
      subjectForAgent({ id: '01JKABC00001', namespace: 'my-ns', projectPath: '/projects/my-agent' })
    ).toBe('relay.agent.my-ns.01JKABC00001');
  });

  it('falls back to the project basename when namespace is empty', () => {
    expect(
      subjectForAgent({ id: 'MYID', namespace: '', projectPath: '/projects/my-project' })
    ).toBe('relay.agent.my-project.MYID');
    expect(subjectForAgent({ id: 'MYID', projectPath: '/projects/my-project' })).toBe(
      'relay.agent.my-project.MYID'
    );
  });
});
