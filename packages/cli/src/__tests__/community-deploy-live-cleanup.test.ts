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
    listTigrisOnApp: vi.fn().mockResolvedValue([]),
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
      alreadyGone: [],
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

  // DOR-2584: Fly answers a bucket id it no longer has with ADD_ON_MISSING. Cleanup of a run whose
  // bucket is already gone must still remove the Neon project and the app, but only once the app's
  // own bucket list proves the bucket absent, and it must not claim a delete it did not do.
  it('reports a bucket proved absent as already gone, not cleaned, and removes the rest', async () => {
    const boundary = dependencies();
    boundary.readTigris.mockRejectedValue(
      Object.assign(new Error('x'), { code: 'ADD_ON_MISSING' })
    );
    await expect(cleanupCommunityLiveGate(journal, boundary)).resolves.toEqual({
      cleaned: ['neon-1', 'fly-1'],
      alreadyGone: ['bucket-1'],
      retained: [],
    });
    expect(boundary.listTigrisOnApp).toHaveBeenCalledWith(journal.recoveryContext.appName);
    expect(boundary.deleteTigris).not.toHaveBeenCalled();
    expect(boundary.deleteNeonProject).toHaveBeenCalledWith('neon-1');
    expect(boundary.destroyFlyApp).toHaveBeenCalledWith(journal.recoveryContext.appName);
  });

  it('keeps everything when a bucket reported missing is still attached to the app', async () => {
    const boundary = dependencies();
    boundary.readTigris.mockRejectedValue(
      Object.assign(new Error('x'), { code: 'ADD_ON_MISSING' })
    );
    boundary.listTigrisOnApp.mockResolvedValue([
      { id: 'bucket-1', name: 'dorkos-gate-012345abcdef' },
    ]);
    await expect(cleanupCommunityLiveGate(journal, boundary)).rejects.toMatchObject({
      step: 'tigris-identity',
      retained: ['fly-1', 'neon-1', 'bucket-1'],
    });
    expect(boundary.deleteTigris).not.toHaveBeenCalled();
    expect(boundary.deleteNeonProject).not.toHaveBeenCalled();
    expect(boundary.destroyFlyApp).not.toHaveBeenCalled();
  });

  it('still stops, keeping everything, when the bucket read fails any other way', async () => {
    const boundary = dependencies();
    boundary.readTigris.mockRejectedValue(
      Object.assign(new Error('x'), { code: 'INVALID_RESPONSE' })
    );
    await expect(cleanupCommunityLiveGate(journal, boundary)).rejects.toMatchObject({
      step: 'provider-operation',
      retained: ['fly-1', 'neon-1', 'bucket-1'],
    });
    expect(boundary.deleteNeonProject).not.toHaveBeenCalled();
  });
});
