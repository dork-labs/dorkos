import { describe, expect, it, vi } from 'vitest';
import type { AgentIdentity } from '../../../core/agent-identity/index.js';
import type { ConnectorRuntimePrincipalPort } from '../../../connectors/runtime-principal-port.js';
import { createServerPrincipal } from '../../../connectors/principal/server-principal.js';
import { AgentIdentitySnapshotPrincipalPort } from '../agent-identity-snapshots.js';

const expiresAt = '2026-09-08T12:00:00.000Z';

function backing(): ConnectorRuntimePrincipalPort {
  let sequence = 0;
  return {
    openTurn: vi.fn(async () => ({
      bindingId: `binding-${++sequence}`,
      bearer: `bearer-${sequence}`,
      expiresAt,
    })),
    resolve: vi.fn(),
    revoke: vi.fn(),
  };
}

function principal(bindingId: string, sessionId: string) {
  return createServerPrincipal({
    kind: 'runtime',
    owner: { kind: 'local_install', installationId: 'install-a' },
    bindingId,
    runtime: 'opencode',
    canonicalSessionId: sessionId,
    agentId: 'agent-a',
    agentPath: '/agents/a',
    canonicalCwd: '/agents/a',
  });
}

function openInput(sessionId: string) {
  return {
    runtime: 'opencode' as const,
    canonicalSessionId: sessionId,
    agentPath: '/agents/a',
    canonicalCwd: '/agents/a',
    signal: new AbortController().signal,
  };
}

describe('AgentIdentitySnapshotPrincipalPort', () => {
  it('keeps each concurrent turn on the exact identity captured before its launch', async () => {
    let currentTier: AgentIdentity['tierCeiling'] = 'observe';
    const principals = backing();
    const snapshots = new AgentIdentitySnapshotPrincipalPort({
      principals,
      snapshotIdentity: async (agentPath) => ({
        agentPath,
        displayName: 'Agent A',
        tierCeiling: currentTier,
        createdAt: '2026-09-08T00:00:00.000Z',
      }),
      identityWasRevoked: async () => false,
      now: () => new Date('2026-09-08T10:00:00.000Z'),
    });

    const first = await snapshots.openTurn(openInput('session-1'));
    currentTier = 'destructive';
    const second = await snapshots.openTurn(openInput('session-2'));

    await expect(
      snapshots.identityFor(principal(first.bindingId, 'session-1'))
    ).resolves.toMatchObject({ tierCeiling: 'observe' });
    await expect(
      snapshots.identityFor(principal(second.bindingId, 'session-2'))
    ).resolves.toMatchObject({ tierCeiling: 'destructive' });
  });

  it('refuses a later revocation without replacing the captured ceiling', async () => {
    let revoked = false;
    const snapshots = new AgentIdentitySnapshotPrincipalPort({
      principals: backing(),
      snapshotIdentity: async (agentPath) => ({
        agentPath,
        displayName: 'Agent A',
        tierCeiling: 'act',
        createdAt: '2026-09-08T00:00:00.000Z',
      }),
      identityWasRevoked: async () => revoked,
      now: () => new Date('2026-09-08T10:00:00.000Z'),
    });
    const opened = await snapshots.openTurn(openInput('session-1'));
    revoked = true;

    await expect(
      snapshots.identityFor(principal(opened.bindingId, 'session-1'))
    ).resolves.toBeUndefined();
  });

  it('deletes the snapshot before a backing revocation can fail', async () => {
    const principals = backing();
    vi.mocked(principals.revoke).mockRejectedValue(new Error('disk full'));
    const snapshots = new AgentIdentitySnapshotPrincipalPort({
      principals,
      snapshotIdentity: async (agentPath) => ({
        agentPath,
        displayName: 'Agent A',
        tierCeiling: 'observe',
        createdAt: '2026-09-08T00:00:00.000Z',
      }),
      identityWasRevoked: async () => false,
      now: () => new Date('2026-09-08T10:00:00.000Z'),
    });
    const opened = await snapshots.openTurn(openInput('session-1'));

    await expect(snapshots.revoke(opened.bindingId, 'runtime_failed')).rejects.toThrow('disk full');
    await expect(
      snapshots.identityFor(principal(opened.bindingId, 'session-1'))
    ).resolves.toBeUndefined();
  });

  it('prunes an abandoned snapshot at the backing binding expiry', async () => {
    let now = new Date('2026-09-08T10:00:00.000Z');
    const snapshots = new AgentIdentitySnapshotPrincipalPort({
      principals: backing(),
      snapshotIdentity: async (agentPath) => ({
        agentPath,
        displayName: 'Agent A',
        tierCeiling: 'observe',
        createdAt: '2026-09-08T00:00:00.000Z',
      }),
      identityWasRevoked: async () => false,
      now: () => now,
    });
    const opened = await snapshots.openTurn(openInput('session-1'));
    now = new Date(expiresAt);

    await expect(
      snapshots.identityFor(principal(opened.bindingId, 'session-1'))
    ).resolves.toBeUndefined();
  });
});
