import { describe, expect, it, vi } from 'vitest';
import type { AgentIdentity } from '../../../core/agent-identity/index.js';
import type { ConnectorRuntimePrincipalPort } from '../../../connectors/runtime-principal-port.js';
import { createServerPrincipal } from '../../../connectors/principal/server-principal.js';
import { AgentIdentitySnapshotPrincipalPort } from '../agent-identity-snapshots.js';

const expiresAt = '2026-09-08T12:00:00.000Z';
const renewedExpiresAt = '2026-09-08T16:00:00.000Z';
const ownership = { isCurrent: () => true };

function backing(): ConnectorRuntimePrincipalPort {
  let sequence = 0;
  return {
    openTurn: vi.fn(async () => ({
      bindingId: `binding-${++sequence}`,
      bearer: `bearer-${sequence}`,
      expiresAt,
      renewalPermit: Object.freeze({}) as never,
    })),
    renew: vi.fn(async () => ({ status: 'renewed' as const, expiresAt: renewedExpiresAt })),
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

    const first = await snapshots.openTurn(openInput('session-1'), ownership);
    currentTier = 'destructive';
    const second = await snapshots.openTurn(openInput('session-2'), ownership);

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
    const opened = await snapshots.openTurn(openInput('session-1'), ownership);
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
    const opened = await snapshots.openTurn(openInput('session-1'), ownership);

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
    const opened = await snapshots.openTurn(openInput('session-1'), ownership);
    now = new Date(expiresAt);

    await expect(
      snapshots.identityFor(principal(opened.bindingId, 'session-1'))
    ).resolves.toBeUndefined();
  });

  it('forwards exact turn ownership and renews expiry without refreshing the frozen identity', async () => {
    let currentTier: AgentIdentity['tierCeiling'] = 'observe';
    let now = new Date('2026-09-08T10:00:00.000Z');
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
      now: () => now,
    });
    const input = openInput('session-1');
    const opened = await snapshots.openTurn(input, ownership);
    const permit = opened.renewalPermit;

    const openCall = vi.mocked(principals.openTurn).mock.calls[0];
    expect(openCall?.[0]).toBe(input);
    expect(openCall?.[1]).toBe(ownership);
    const backingOpenResult = await vi.mocked(principals.openTurn).mock.results[0]?.value;
    expect(opened).toBe(backingOpenResult);
    expect(opened.renewalPermit).toBe(backingOpenResult?.renewalPermit);
    currentTier = 'destructive';
    const renewal = { bindingId: opened.bindingId, permit };
    await expect(snapshots.renew(renewal)).resolves.toEqual({
      status: 'renewed',
      expiresAt: renewedExpiresAt,
    });
    const forwardedRenewal = vi.mocked(principals.renew).mock.calls[0]?.[0];
    expect(forwardedRenewal?.bindingId).toBe(opened.bindingId);
    expect(forwardedRenewal?.permit).toBe(permit);
    now = new Date('2026-09-08T13:00:00.000Z');
    await expect(
      snapshots.identityFor(principal(opened.bindingId, 'session-1'))
    ).resolves.toMatchObject({ tierCeiling: 'observe' });
  });

  it('does not extend a snapshot when the backing lease refuses renewal', async () => {
    let now = new Date('2026-09-08T10:00:00.000Z');
    const principals = backing();
    vi.mocked(principals.renew).mockResolvedValueOnce({
      status: 'refused',
      reason: 'authority_changed',
    });
    const snapshots = new AgentIdentitySnapshotPrincipalPort({
      principals,
      snapshotIdentity: async (agentPath) => ({
        agentPath,
        displayName: 'Agent A',
        tierCeiling: 'observe',
        createdAt: '2026-09-08T00:00:00.000Z',
      }),
      identityWasRevoked: async () => false,
      now: () => now,
    });
    const opened = await snapshots.openTurn(openInput('session-1'), ownership);

    await snapshots.renew({ bindingId: opened.bindingId, permit: opened.renewalPermit });
    now = new Date(expiresAt);
    await expect(
      snapshots.identityFor(principal(opened.bindingId, 'session-1'))
    ).resolves.toBeUndefined();
  });

  it('keeps a failed renewal only until the original expiry', async () => {
    let now = new Date('2026-09-08T10:00:00.000Z');
    const principals = backing();
    vi.mocked(principals.renew).mockRejectedValueOnce(new Error('temporary storage failure'));
    const snapshots = new AgentIdentitySnapshotPrincipalPort({
      principals,
      snapshotIdentity: async (agentPath) => ({
        agentPath,
        displayName: 'Agent A',
        tierCeiling: 'observe',
        createdAt: '2026-09-08T00:00:00.000Z',
      }),
      identityWasRevoked: async () => false,
      now: () => now,
    });
    const opened = await snapshots.openTurn(openInput('session-1'), ownership);

    await expect(
      snapshots.renew({ bindingId: opened.bindingId, permit: opened.renewalPermit })
    ).rejects.toThrow('temporary storage failure');
    await expect(
      snapshots.identityFor(principal(opened.bindingId, 'session-1'))
    ).resolves.toMatchObject({ tierCeiling: 'observe' });

    now = new Date(expiresAt);
    await expect(
      snapshots.identityFor(principal(opened.bindingId, 'session-1'))
    ).resolves.toBeUndefined();
  });

  it('does not revive a snapshot when renewal finishes after the original expiry', async () => {
    let now = new Date('2026-09-08T10:00:00.000Z');
    let finishRenewal: ((result: { status: 'renewed'; expiresAt: string }) => void) | undefined;
    const principals = backing();
    vi.mocked(principals.renew).mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finishRenewal = resolve;
        })
    );
    const snapshots = new AgentIdentitySnapshotPrincipalPort({
      principals,
      snapshotIdentity: async (agentPath) => ({
        agentPath,
        displayName: 'Agent A',
        tierCeiling: 'observe',
        createdAt: '2026-09-08T00:00:00.000Z',
      }),
      identityWasRevoked: async () => false,
      now: () => now,
    });
    const opened = await snapshots.openTurn(openInput('session-1'), ownership);
    const renewing = snapshots.renew({
      bindingId: opened.bindingId,
      permit: opened.renewalPermit,
    });
    await vi.waitFor(() => expect(finishRenewal).toBeTypeOf('function'));
    now = new Date(expiresAt);
    finishRenewal?.({ status: 'renewed', expiresAt: renewedExpiresAt });
    await renewing;

    await expect(
      snapshots.identityFor(principal(opened.bindingId, 'session-1'))
    ).resolves.toBeUndefined();
  });

  it('never recreates a snapshot revoked while backing renewal is pending', async () => {
    let finishRenewal: ((result: { status: 'renewed'; expiresAt: string }) => void) | undefined;
    const principals = backing();
    vi.mocked(principals.renew).mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finishRenewal = resolve;
        })
    );
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
    const opened = await snapshots.openTurn(openInput('session-1'), ownership);
    const renewing = snapshots.renew({
      bindingId: opened.bindingId,
      permit: opened.renewalPermit,
    });
    await vi.waitFor(() => expect(finishRenewal).toBeTypeOf('function'));
    await snapshots.revoke(opened.bindingId, 'turn_cancelled');
    finishRenewal?.({ status: 'renewed', expiresAt: renewedExpiresAt });
    await renewing;

    await expect(
      snapshots.identityFor(principal(opened.bindingId, 'session-1'))
    ).resolves.toBeUndefined();
  });
});
