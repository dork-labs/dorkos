import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { CommunityConnectionDescriptor } from '@dorkos/shared/community-connections';
import { CommunityRefSchema } from '@dorkos/shared/community-adapter';
import { ConfigManager } from '../../core/config-manager.js';
import { CommunityNavigationPreferenceService } from '../community-navigation-preferences.js';

const directories: string[] = [];

async function createHarness(refs: string[]) {
  const directory = await mkdtemp(join(tmpdir(), 'community-navigation-'));
  directories.push(directory);
  const config = new ConfigManager(directory);
  const list = vi.fn(async (): Promise<CommunityConnectionDescriptor[]> =>
    refs.map((rawRef) => ({
      ref: CommunityRefSchema.parse(rawRef),
      remoteCommunityId: `remote-${rawRef}`,
      label: rawRef,
      pinnedOrigin: 'https://community.example',
      connectedHumanMemberId: 'member',
      status: 'connected',
      expiresAt: null,
    }))
  );
  const canReadRoom = vi.fn(async () => true);
  return {
    config,
    list,
    canReadRoom,
    service: new CommunityNavigationPreferenceService(config, { list } as never, canReadRoom),
  };
}

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true })));
});

describe('CommunityNavigationPreferenceService', () => {
  it('serializes concurrent relative moves against the latest saved order', async () => {
    const harness = await createHarness(['a', 'b', 'c']);
    expect((await harness.service.get('owner-a')).order).toEqual(['a', 'b', 'c']);

    await Promise.all([
      harness.service.move('owner-a', CommunityRefSchema.parse('c'), 'up'),
      harness.service.move('owner-a', CommunityRefSchema.parse('a'), 'down'),
    ]);

    expect((await harness.service.get('owner-a')).order).toEqual(['c', 'a', 'b']);
  });

  it('keeps owner namespaces separate even when room ids match', async () => {
    const harness = await createHarness(['a']);
    await harness.service.remember('owner-a', {
      ref: 'a',
      roomId: 'general',
      threadId: 'thread-a',
      scrollAnchorEntryId: null,
    });
    await harness.service.remember('owner-b', {
      ref: 'a',
      roomId: 'general',
      threadId: 'thread-b',
      scrollAnchorEntryId: null,
    });

    const ownerA = await harness.service.get('owner-a');
    const ownerB = await harness.service.get('owner-b');
    expect(ownerA.ownerKey).toBe('owner-a');
    expect(ownerA.destinations[0]?.threadId).toBe('thread-a');
    expect(ownerB.ownerKey).toBe('owner-b');
    expect(ownerB.destinations[0]?.threadId).toBe('thread-b');
  });

  it('serializes local route writes without replacing another owner destination', async () => {
    const harness = await createHarness(['a']);
    await Promise.all([
      harness.service.rememberInstallation('owner-a', {
        path: '/tasks',
        search: { view: 'board' },
      }),
      harness.service.rememberInstallation('owner-b', {
        path: '/connections',
        search: { tab: 'accounts' },
      }),
    ]);

    expect((await harness.service.get('owner-a')).installationDestination).toEqual({
      path: '/tasks',
      search: { view: 'board' },
    });
    expect((await harness.service.get('owner-b')).installationDestination).toEqual({
      path: '/connections',
      search: { tab: 'accounts' },
    });
  });

  it('reauthorizes a remembered room and erases it when access is gone', async () => {
    const harness = await createHarness(['a']);
    await harness.service.remember('owner-a', {
      ref: 'a',
      roomId: 'private-room',
      threadId: null,
      scrollAnchorEntryId: 'entry-a',
    });
    harness.canReadRoom.mockResolvedValue(false);

    await expect(
      harness.service.resolve('owner-a', CommunityRefSchema.parse('a'))
    ).resolves.toBeNull();
    expect((await harness.service.get('owner-a')).destinations).toEqual([]);
  });

  it('prunes removed refs only after the authoritative connection list changes', async () => {
    const harness = await createHarness(['a', 'b']);
    await harness.service.get('owner-a');
    harness.list.mockResolvedValue([
      {
        ref: CommunityRefSchema.parse('b'),
        remoteCommunityId: 'remote-b',
        label: 'b',
        pinnedOrigin: 'https://community.example',
        connectedHumanMemberId: 'member',
        status: 'connected',
        expiresAt: null,
      },
    ]);

    expect((await harness.service.get('owner-a')).order).toEqual(['b']);
  });
});
