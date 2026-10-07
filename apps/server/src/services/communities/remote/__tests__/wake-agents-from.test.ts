/**
 * Who in a space may wake this install's agents (spec `official-community-space` D9): stored
 * per connection beside connections.json, owner-scoped, defaulting to today's behaviour, and
 * answered synchronously by the gate the live stream bridge asks.
 *
 * @vitest-environment node
 */
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CommunityRef } from '@dorkos/shared/community-adapter';
import type { CredentialStore } from '../../../core/credential-provider.js';
import { RemoteConnectionNotFoundError, RemoteConnectionStore } from '../connection-store.js';
import { RemoteWakePolicy } from '../wake-policy.js';

function memoryCredentials(): CredentialStore {
  const secrets = new Map<string, string>();
  return {
    put: async (name, secret) => {
      secrets.set(name, secret);
      return `file:${name}`;
    },
    get: async (name) => secrets.get(name) ?? null,
    delete: async (name) => {
      secrets.delete(name);
    },
  };
}

const OWNER = 'owner-author';
const OWNER_MEMBER = 'remote-owner-member';
const REF = 'remote_space' as CommunityRef;
const ACCESS = {
  state: 'verified' as const,
  effective: { read: true, post: true, enrollAgent: true, stream: true },
  lastKnown: {
    lifecycle: 'active' as const,
    capabilities: { read: true, post: true, enrollAgent: true, stream: true },
    verifiedAt: '2026-10-06T00:00:00.000Z',
  },
};

let directory: string;
let store: RemoteConnectionStore;

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'wake-agents-from-'));
  store = new RemoteConnectionStore(directory, memoryCredentials());
  await store.addPending(
    {
      ref: REF,
      ownerKey: OWNER,
      remoteCommunityId: 'community-1',
      label: 'Makers',
      pinnedOrigin: 'https://community.example',
      pairingId: 'pairing-1',
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    },
    'verifier'
  );
  await store.complete(REF, OWNER, OWNER_MEMBER, 'token', ACCESS);
});

afterEach(async () => {
  await rm(directory, { recursive: true, force: true });
});

describe('the stored setting', () => {
  it('is "members" until the owner chooses, and remembers the choice', async () => {
    expect(await store.wakeAgentsFrom(REF, OWNER)).toBe('members');
    await store.setWakeAgentsFrom(REF, OWNER, 'me');
    expect(
      await new RemoteConnectionStore(directory, memoryCredentials()).wakeAgentsFrom(REF, OWNER)
    ).toBe('me');
  });

  it('belongs to its owner: another owner can neither read nor change it', async () => {
    await expect(store.wakeAgentsFrom(REF, 'someone-else')).rejects.toBeInstanceOf(
      RemoteConnectionNotFoundError
    );
    await expect(store.setWakeAgentsFrom(REF, 'someone-else', 'members')).rejects.toBeInstanceOf(
      RemoteConnectionNotFoundError
    );
  });

  it('stays out of connections.json, which an older DorkOS reads strictly', async () => {
    await store.setWakeAgentsFrom(REF, OWNER, 'me');
    const records = await readFile(
      join(directory, 'communities', 'remote', 'connections.json'),
      'utf8'
    );
    expect(records).not.toContain('wake');
  });

  it('is forgotten when the connection is', async () => {
    await store.setWakeAgentsFrom(REF, OWNER, 'me');
    await store.disconnect(REF, OWNER);
    const wake = await readFile(
      join(directory, 'communities', 'remote', 'wake-agents-from.json'),
      'utf8'
    );
    expect(JSON.parse(wake)).toEqual({});
  });
});

describe('the gate the live stream asks', () => {
  it('wakes nobody before it has loaded', () => {
    const policy = new RemoteWakePolicy(store);
    expect(policy.wakes(REF, OWNER, OWNER_MEMBER)).toBe(false);
  });

  it('with "members", wakes for anyone in the space', async () => {
    const policy = new RemoteWakePolicy(store);
    await policy.reload();
    expect(policy.wakes(REF, OWNER, 'remote-stranger')).toBe(true);
  });

  it('with "me", wakes only for the owner’s own account, from the moment it is set', async () => {
    const policy = new RemoteWakePolicy(store);
    await policy.reload();

    await policy.set(REF, OWNER, 'me');

    expect(policy.wakes(REF, OWNER, 'remote-stranger')).toBe(false);
    expect(policy.wakes(REF, OWNER, OWNER_MEMBER)).toBe(true);
  });

  it('wakes nobody for a connection it does not know', async () => {
    const policy = new RemoteWakePolicy(store);
    await policy.reload();
    expect(policy.wakes('remote_other' as CommunityRef, OWNER, OWNER_MEMBER)).toBe(false);
    expect(policy.wakes(REF, 'someone-else', OWNER_MEMBER)).toBe(false);
  });
});

describe('the gate when a read fails', () => {
  it('tries again a bounded number of times while it has no answer yet', async () => {
    const real = store.wakeSettings.bind(store);
    const read = vi
      .spyOn(store, 'wakeSettings')
      .mockRejectedValueOnce(new Error('disk busy'))
      .mockImplementation(real);
    const policy = new RemoteWakePolicy(store, [0, 0]);

    await policy.reload();

    expect(read).toHaveBeenCalledTimes(2);
    expect(policy.wakes(REF, OWNER, 'remote-stranger')).toBe(true);
  });

  it('gives up after the last retry and keeps waking nobody', async () => {
    const read = vi.spyOn(store, 'wakeSettings').mockRejectedValue(new Error('gone'));
    const policy = new RemoteWakePolicy(store, [0, 0]);

    await policy.reload();

    expect(read).toHaveBeenCalledTimes(3);
    expect(policy.wakes(REF, OWNER, OWNER_MEMBER)).toBe(false);
  });

  it('keeps a good answer when a newer read fails, even if the good one finishes last', async () => {
    const real = store.wakeSettings.bind(store);
    await store.setWakeAgentsFrom(REF, OWNER, 'me');
    let finishOlder!: () => void;
    vi.spyOn(store, 'wakeSettings')
      .mockImplementationOnce(async () => {
        const settings = await real();
        await new Promise<void>((resolve) => (finishOlder = resolve));
        return settings;
      })
      .mockRejectedValueOnce(new Error('disk busy'));
    const policy = new RemoteWakePolicy(store, []);

    const older = policy.reload();
    await vi.waitFor(() => expect(finishOlder).toBeDefined());
    await policy.reload();
    finishOlder();
    await older;

    expect(policy.wakes(REF, OWNER, 'remote-stranger')).toBe(false);
    expect(policy.wakes(REF, OWNER, OWNER_MEMBER)).toBe(true);
  });

  it('applies a tightening at once even when the read after it fails', async () => {
    const policy = new RemoteWakePolicy(store, []);
    await policy.reload();
    vi.spyOn(store, 'wakeSettings').mockRejectedValue(new Error('disk busy'));

    await policy.set(REF, OWNER, 'me');

    expect(policy.wakes(REF, OWNER, 'remote-stranger')).toBe(false);
    expect(policy.wakes(REF, OWNER, OWNER_MEMBER)).toBe(true);
  });
});
