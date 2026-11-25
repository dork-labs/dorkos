/**
 * A teammate's turn whose chain names no room DorkOS can prove came from
 * (`UNPROVEN_TEAMMATE_ORIGIN`): it runs only while every space with a limit allows it, and is
 * counted against each of them, so it can't run free of the space it really came from.
 *
 * @vitest-environment node
 */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CommunityRef } from '@dorkos/shared/community-adapter';
import { UNPROVEN_TEAMMATE_ORIGIN } from '@dorkos/shared/permission-semantics';
import type { CredentialStore } from '../../../core/credential-provider.js';
import { RemoteConnectionStore } from '../connection-store.js';
import { TeammateSpend } from '../wake/teammate-spend.js';
import { teammateSpaceGate, teammateSpendSink } from '../wake/teammate-spend-wiring.js';

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
const LIMITED = 'space_limited' as CommunityRef;
const ALSO_LIMITED = 'space_also_limited' as CommunityRef;
const OPEN = 'space_open' as CommunityRef;
const ACCESS = {
  state: 'verified' as const,
  effective: { read: true, post: true, enrollAgent: true, stream: true },
  lastKnown: {
    lifecycle: 'active' as const,
    capabilities: { read: true, post: true, enrollAgent: true, stream: true },
    verifiedAt: '2026-10-06T00:00:00.000Z',
  },
};
const NOW = Date.parse('2026-10-17T12:00:00.000Z');

let directory: string;
let counter: TeammateSpend;

/** Which space each local room copies: one room per space. */
const mirrors = {
  connectionOf: (roomId: string) =>
    [LIMITED, ALSO_LIMITED, OPEN].includes(roomId as CommunityRef)
      ? { communityRef: roomId as CommunityRef, ownerAuthorId: OWNER }
      : undefined,
} as Parameters<typeof teammateSpaceGate>[0];

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'teammate-spend-unproven-'));
  const connections = new RemoteConnectionStore(directory, memoryCredentials());
  for (const ref of [LIMITED, ALSO_LIMITED, OPEN]) {
    await connections.addPending(
      {
        ref,
        ownerKey: OWNER,
        remoteCommunityId: `community-${ref}`,
        label: 'Made-up space',
        pinnedOrigin: 'https://community.example',
        pairingId: `pairing-${ref}`,
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
      },
      'verifier'
    );
    await connections.complete(ref, OWNER, 'remote-owner', 'token', ACCESS);
  }
  counter = new TeammateSpend(
    directory,
    connections,
    { reached: vi.fn(async () => {}) },
    () => NOW
  );
  await counter.setLimit(LIMITED, OWNER, 1);
  await counter.setLimit(ALSO_LIMITED, OWNER, 5);
});

afterEach(async () => {
  await rm(directory, { recursive: true, force: true });
});

describe('a teammate chain DorkOS can’t prove the rooms of', () => {
  it('is counted against every space with a limit, and no other', async () => {
    const sink = teammateSpendSink(mirrors, () => counter);
    sink({ roomId: UNPROVEN_TEAMMATE_ORIGIN.roomId, costUsd: 0.5 });
    await vi.waitFor(async () =>
      expect((await counter.summary(ALSO_LIMITED, OWNER)).spentUsd).toBe(0.5)
    );
    expect((await counter.summary(LIMITED, OWNER)).spentUsd).toBe(0.5);
    expect((await counter.summary(OPEN, OWNER)).spentUsd).toBe(0);
  });

  it('stops running once any space with a limit reaches it', async () => {
    const gate = teammateSpaceGate(mirrors, () => counter);
    expect(gate(UNPROVEN_TEAMMATE_ORIGIN.roomId)).toBe(true);
    await counter.record(LIMITED, OWNER, 1);
    expect(gate(UNPROVEN_TEAMMATE_ORIGIN.roomId)).toBe(false);
    // A proven room is still read by its own space alone.
    expect(gate(ALSO_LIMITED)).toBe(true);
    expect(gate(OPEN)).toBe(true);
  });

  it('reads each space’s month as approximate, since the turn may not be its teammates’', async () => {
    await counter.recordEvery(0.5);
    expect(await counter.summary(LIMITED, OWNER)).toMatchObject({
      spentUsd: 0.5,
      approximate: true,
    });
    // A turn proven to be a space's own, with a reported cost, stays exact.
    await counter.record(OPEN, OWNER, 0.5);
    expect((await counter.summary(OPEN, OWNER)).approximate).toBe(false);
  });

  it('still counts the other spaces when one space’s count can’t be written', async () => {
    const record = counter.record.bind(counter);
    vi.spyOn(counter, 'record').mockImplementation((ref, ...rest) =>
      ref === LIMITED ? Promise.reject(new Error('disk full')) : record(ref, ...rest)
    );
    await expect(counter.recordEvery(0.5)).resolves.toBeUndefined();
    expect(counter.record).toHaveBeenCalledWith(LIMITED, OWNER, 0.5, true);
    expect((await counter.summary(ALSO_LIMITED, OWNER)).spentUsd).toBe(0.5);
  });

  it('leaves a proven room counted against its own space alone', async () => {
    const sink = teammateSpendSink(mirrors, () => counter);
    sink({ roomId: ALSO_LIMITED, costUsd: 0.25 });
    await vi.waitFor(async () =>
      expect((await counter.summary(ALSO_LIMITED, OWNER)).spentUsd).toBe(0.25)
    );
    expect((await counter.summary(LIMITED, OWNER)).spentUsd).toBe(0);
  });
});
