import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { RelayBridge, subjectForAgent, resetGuardedNamespaceWarnings } from '../relay-bridge.js';
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

/**
 * A RelayCore fake that actually holds its rules and removes the FIRST match
 * per call, exactly as the real access-control store does — the semantics
 * namespace-rule cleanup has to survive when two specs share a pattern pair.
 */
function makeStatefulRelayCore() {
  const rules: { from: string; to: string; action: string; priority: number }[] = [];
  return {
    registerEndpoint: vi.fn().mockResolvedValue(undefined),
    unregisterEndpoint: vi.fn().mockResolvedValue(true),
    addAccessRule: vi.fn((rule: (typeof rules)[number]) => {
      rules.push(rule);
    }),
    removeAccessRule: vi.fn((from: string, to: string) => {
      const index = rules.findIndex((r) => r.from === from && r.to === to);
      if (index !== -1) rules.splice(index, 1);
    }),
    listAccessRules: vi.fn(() => [...rules]),
  };
}

function makeManifest(overrides: Partial<AgentManifest> = {}): AgentManifest {
  return {
    workspace: { mode: 'home' },
    id: '01JKABC00001',
    name: 'test-agent',
    description: '',
    runtime: 'claude-code',
    capabilities: [],
    behavior: { responseMode: 'always' },
    mcpServers: [],
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
});

// ---------------------------------------------------------------------------
// unregisterAgent
// ---------------------------------------------------------------------------

describe('unregisterAgent', () => {});

// ---------------------------------------------------------------------------
// cleanupNamespaceRules
// ---------------------------------------------------------------------------

describe('cleanupNamespaceRules', () => {
  it('removes every default rule the namespace could have been given', () => {
    const relay = makeMockRelayCore();
    const bridge = new RelayBridge(relay as never);

    bridge.cleanupNamespaceRules('test-ns');

    // One call per default spec, system-agent rules included: the catch-all
    // deny and the system allow share a pattern pair and Relay removes one
    // rule per call, so both need their own. A namespace that never held a
    // system agent simply has two calls match nothing.
    expect(relay.removeAccessRule.mock.calls).toEqual([
      ['relay.agent.test-ns.*', 'relay.agent.test-ns.*'],
      ['relay.agent.test-ns.*', 'relay.agent.>'],
      ['relay.agent.test-ns.*', 'relay.agent.>'],
      ['relay.agent.>', 'relay.agent.test-ns.*'],
    ]);
  });

  it('leaves nothing behind for a namespace that held a system agent', async () => {
    const relay = makeStatefulRelayCore();
    const bridge = new RelayBridge(relay as never);
    await bridge.registerAgent(
      makeManifest({ id: '01JKSYSTEM0001', name: 'dorkbot', isSystem: true }),
      '/agents/dorkbot',
      'dorkbot'
    );
    expect(relay.listAccessRules()).not.toEqual([]);

    bridge.cleanupNamespaceRules('dorkbot');

    expect(relay.listAccessRules()).toEqual([]);
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

// ---------------------------------------------------------------------------
// subjectForAgent
// ---------------------------------------------------------------------------

describe('subjectForAgent', () => {
  it('uses the namespace when set', () => {
    expect(
      subjectForAgent({ id: '01JKABC00001', namespace: 'my-ns', projectPath: '/projects/my-agent' })
    ).toBe('relay.agent.my-ns.01JKABC00001');
  });

  describe('runtime-type collision guard (upgrade edge)', () => {
    let warnSpy: ReturnType<typeof vi.spyOn>;

    beforeEach(() => {
      resetGuardedNamespaceWarnings();
      warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    });

    afterEach(() => {
      warnSpy.mockRestore();
    });

    it('warns once, naming old and new subject, when a stored namespace is guard-rewritten', () => {
      // A pre-guard entry persisted with namespace 'claude-code' is re-identified
      // on upgrade: the guard suffixes the namespace, shifting the subject.
      const subject = subjectForAgent({
        id: '01JOLD',
        namespace: 'claude-code',
        projectPath: '/projects/claude-code/agent',
      });

      expect(subject).toBe('relay.agent.claude-code-ns.01JOLD');
      expect(warnSpy).toHaveBeenCalledTimes(1);
      const message = String(warnSpy.mock.calls[0]![0]);
      expect(message).toContain('relay.agent.claude-code.01JOLD');
      expect(message).toContain('relay.agent.claude-code-ns.01JOLD');

      // Warn-once: a second agent in the same colliding namespace stays quiet.
      subjectForAgent({
        id: '01JOTHER',
        namespace: 'claude-code',
        projectPath: '/projects/claude-code/other',
      });
      expect(warnSpy).toHaveBeenCalledTimes(1);
    });
  });
});
