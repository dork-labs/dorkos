import { describe, it, expect, vi } from 'vitest';
import { RelayBridge } from '../relay-bridge.js';
import type { AgentManifest } from '@dorkos/shared/mesh-schemas';

// ---------------------------------------------------------------------------
// Mock RelayCore
// ---------------------------------------------------------------------------

function makeMockRelayCore() {
  return {
    registerEndpoint: vi.fn().mockResolvedValue({ hash: 'abc', subject: 'relay.agent.proj.01A' }),
    unregisterEndpoint: vi.fn().mockResolvedValue(true),
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
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// registerAgent
// ---------------------------------------------------------------------------

describe('registerAgent', () => {
  it('calls registerEndpoint with correct subject format', async () => {
    const relay = makeMockRelayCore();
    const bridge = new RelayBridge(relay as never);
    const manifest = makeManifest({ id: '01JKABC00001' });

    await bridge.registerAgent(manifest, '/projects/my-agent');

    expect(relay.registerEndpoint).toHaveBeenCalledWith('relay.agent.my-agent.01JKABC00001');
  });

  it('subject format is relay.agent.{basename(projectPath)}.{agentId}', async () => {
    const relay = makeMockRelayCore();
    const bridge = new RelayBridge(relay as never);
    const manifest = makeManifest({ id: 'MYID' });

    const subject = await bridge.registerAgent(manifest, '/home/user/projects/my-project');

    expect(subject).toBe('relay.agent.my-project.MYID');
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
