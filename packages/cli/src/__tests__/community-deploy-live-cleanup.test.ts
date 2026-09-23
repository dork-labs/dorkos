import { describe, expect, it, vi } from 'vitest';
import { cleanupCommunityLiveGate } from '../../scripts/community-deploy-live-cleanup.js';

const journal = {
  recoveryContext: {
    flyOrganization: 'gate-org',
    neonOrganization: 'neon-org',
    appName: 'dorkos-gate-012345abcdef',
    bucketName: 'dorkos-gate-012345abcdef',
  },
  resources: { flyAppId: 'fly-1', neonProjectId: 'neon-1', tigrisBucketId: 'bucket-1' },
};

function dependencies() {
  return {
    readFlyApps: vi
      .fn()
      .mockResolvedValue([
        { id: 'fly-1', name: journal.recoveryContext.appName, organization: 'gate-org' },
      ]),
    readNeonProjects: vi
      .fn()
      .mockResolvedValue([{ id: 'neon-1', name: 'ignored-label', organization: 'neon-org' }]),
    readTigris: vi.fn().mockResolvedValue({
      id: 'bucket-1',
      name: journal.recoveryContext.bucketName,
      organization: 'gate-org',
      appId: 'fly-1',
      appName: journal.recoveryContext.appName,
    }),
    deleteTigris: vi.fn().mockResolvedValue(undefined),
    deleteNeonProject: vi.fn().mockResolvedValue(undefined),
    destroyFlyApp: vi.fn().mockResolvedValue(undefined),
  };
}

describe('Community live gate cleanup', () => {
  it('deletes only the exact journal identities in dependency order', async () => {
    const boundary = dependencies();
    await expect(cleanupCommunityLiveGate(journal, boundary)).resolves.toEqual({
      cleaned: ['bucket-1', 'neon-1', 'fly-1'],
      retained: [],
    });
    expect(boundary.deleteTigris).toHaveBeenCalledWith(journal.recoveryContext.bucketName);
    expect(boundary.deleteNeonProject).toHaveBeenCalledWith('neon-1');
    expect(boundary.destroyFlyApp).toHaveBeenCalledWith(journal.recoveryContext.appName);
  });

  it('does not delete a same-name Fly app with a different provider identity', async () => {
    const boundary = dependencies();
    boundary.readFlyApps.mockResolvedValue([
      { id: 'foreign', name: journal.recoveryContext.appName, organization: 'gate-org' },
    ]);
    await expect(cleanupCommunityLiveGate(journal, boundary)).rejects.toMatchObject({
      step: 'fly-identity',
      retained: ['fly-1', 'neon-1', 'bucket-1'],
    });
    expect(boundary.deleteTigris).not.toHaveBeenCalled();
    expect(boundary.deleteNeonProject).not.toHaveBeenCalled();
    expect(boundary.destroyFlyApp).not.toHaveBeenCalled();
  });

  it('reports still-retained exact identities after a partial cleanup failure', async () => {
    const boundary = dependencies();
    boundary.deleteNeonProject.mockRejectedValue(new Error('raw provider error'));
    await expect(cleanupCommunityLiveGate(journal, boundary)).rejects.toMatchObject({
      step: 'provider-operation',
      retained: ['fly-1', 'neon-1'],
    });
    expect(boundary.destroyFlyApp).not.toHaveBeenCalled();
  });
});
