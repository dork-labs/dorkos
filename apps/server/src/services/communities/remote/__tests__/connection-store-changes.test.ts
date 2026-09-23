/**
 * Every committed change to a Community connection list is announced, once,
 * after it is on disk — and nothing else is.
 *
 * The announcement is what `community_connections_changed` rides on
 * (`services/core/streams/live-change-broadcasts.ts`), so a transition that
 * stops announcing is a window that keeps showing a Community the person has
 * left until its 30-second poll. Each case here is a mutation probe for one
 * `announce` call in `connection-store.ts`.
 *
 * @vitest-environment node
 */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { CommunityRef } from '@dorkos/shared/community-adapter';
import type { CredentialStore } from '../../../core/credential-provider.js';
import { RemoteConnectionStore, type RemoteConnectionChange } from '../connection-store.js';

/** An in-memory stand-in for the encrypted credential store. */
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

const OWNER = 'owner-author-a';
const ACCESS = {
  state: 'verified' as const,
  effective: { read: true, post: true, enrollAgent: true, stream: true },
  lastKnown: {
    lifecycle: 'active' as const,
    capabilities: { read: true, post: true, enrollAgent: true, stream: true },
    verifiedAt: '2026-09-23T00:00:00.000Z',
  },
};

let directory: string;
let store: RemoteConnectionStore;
let changes: RemoteConnectionChange[];

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'community-connection-changes-'));
  store = new RemoteConnectionStore(directory, memoryCredentials());
  changes = [];
  store.onChange((change) => changes.push(change));
});

afterEach(async () => {
  await rm(directory, { recursive: true, force: true });
});

/** Add a pending row for `owner`, expiring at `expiresAt`. */
async function pending(
  ref: string,
  owner = OWNER,
  expiresAt = new Date(Date.now() + 60_000).toISOString()
) {
  await store.addPending(
    {
      ref: ref as CommunityRef,
      ownerKey: owner,
      remoteCommunityId: 'community-1',
      label: 'Makers',
      pinnedOrigin: 'https://community.example',
      pairingId: 'pairing-1',
      expiresAt,
    },
    'verifier'
  );
  return ref as CommunityRef;
}

/** Add a row and complete it, so it is connected. */
async function connected(ref: string, owner = OWNER) {
  const connectedRef = await pending(ref, owner);
  await store.complete(connectedRef, owner, 'member-1', 'personal-token', ACCESS);
  return connectedRef;
}

describe('RemoteConnectionStore change announcements', () => {
  it('announces a pairing that starts and then connects', async () => {
    await connected('remote_a');

    expect(changes).toEqual([
      { ownerKey: OWNER, ref: 'remote_a', status: 'pending' },
      { ownerKey: OWNER, ref: 'remote_a', status: 'connected' },
    ]);
  });

  it('announces a connection the Community stopped accepting — once', async () => {
    const ref = await connected('remote_a');
    changes.length = 0;

    await store.requireReconnect(ref, OWNER);
    // A second refusal (another route, a stream, a list) changes nothing.
    await store.requireReconnect(ref, OWNER);

    expect(changes).toEqual([{ ownerKey: OWNER, ref, status: 'reconnect-required' }]);
  });

  it('announces a disconnect as a removed row', async () => {
    const ref = await connected('remote_a');
    changes.length = 0;

    await store.disconnect(ref, OWNER);

    expect(changes).toEqual([{ ownerKey: OWNER, ref, status: 'removed' }]);
  });

  it('announces expired pending rows swept from the list', async () => {
    const ref = await pending('remote_a', OWNER, new Date(Date.now() - 1_000).toISOString());
    changes.length = 0;

    await store.sweepExpired(OWNER);
    // Nothing left to sweep: nothing to announce.
    await store.sweepExpired(OWNER);

    expect(changes).toEqual([{ ownerKey: OWNER, ref, status: 'removed' }]);
  });

  it('does not announce an access re-verification, which every list read performs', async () => {
    // Announcing it would make each window's re-read trigger every window to
    // re-read again, forever.
    const ref = await connected('remote_a');
    changes.length = 0;

    await store.updateAccess(ref, OWNER, {
      ...ACCESS,
      state: 'unverified',
      effective: { read: false, post: false, enrollAgent: false, stream: false },
    });

    expect(changes).toEqual([]);
  });

  it('announces only after the change is readable', async () => {
    const ref = await connected('remote_a');
    const seen: string[] = [];
    store.onChange(() => {
      void store.list(OWNER).then((rows) => seen.push(rows[0]?.status ?? 'none'));
    });

    await store.requireReconnect(ref, OWNER);
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(seen).toEqual(['reconnect-required']);
  });

  it('names the owner the change belongs to, so nothing downstream guesses', async () => {
    await connected('remote_a', 'owner-author-a');
    await connected('remote_b', 'owner-author-b');

    expect(changes.filter((change) => change.status === 'connected')).toEqual([
      { ownerKey: 'owner-author-a', ref: 'remote_a', status: 'connected' },
      { ownerKey: 'owner-author-b', ref: 'remote_b', status: 'connected' },
    ]);
  });

  it('never fails the write when a listener throws', async () => {
    store.onChange(() => {
      throw new Error('listener exploded');
    });
    const ref = await connected('remote_a');

    await expect(store.disconnect(ref, OWNER)).resolves.toBeUndefined();
    expect(await store.list(OWNER)).toEqual([]);
    expect(changes.at(-1)).toEqual({ ownerKey: OWNER, ref, status: 'removed' });
  });

  it('stops announcing to a listener that unsubscribed', async () => {
    const late: RemoteConnectionChange[] = [];
    const off = store.onChange((change) => late.push(change));
    off();

    await connected('remote_a');

    expect(late).toEqual([]);
    expect(changes).toHaveLength(2);
  });
});
