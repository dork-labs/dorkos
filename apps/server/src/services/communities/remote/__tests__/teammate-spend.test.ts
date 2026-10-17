/**
 * The card limit (DOR-2956): a monthly limit per space on what teammates' turns may cost the
 * owner, none by default, counted from each turn's reported cost (or a fixed estimate), kept
 * across a restart, reset each month, and told to the owner once a month when reached.
 *
 * @vitest-environment node
 */
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CommunityRef } from '@dorkos/shared/community-adapter';
import { CommunityTeammateSpendLimitRequestSchema } from '@dorkos/shared/community-teammates';
import type { CredentialStore } from '../../../core/credential-provider.js';
import { RemoteConnectionNotFoundError, RemoteConnectionStore } from '../connection-store.js';
import {
  TEAMMATE_SPEND_FILE,
  TEAMMATE_TURN_ESTIMATE_USD,
  TeammateSpend,
} from '../wake/teammate-spend.js';
import { RemoteWakePolicy } from '../wake/wake-policy.js';

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
let connections: RemoteConnectionStore;
const clock = { now: Date.parse('2026-10-17T12:00:00.000Z') };
const reached = vi.fn();

function spend() {
  return new TeammateSpend(directory, connections, reached, () => clock.now);
}

beforeEach(async () => {
  clock.now = Date.parse('2026-10-17T12:00:00.000Z');
  reached.mockReset();
  directory = await mkdtemp(join(tmpdir(), 'teammate-spend-'));
  connections = new RemoteConnectionStore(directory, memoryCredentials());
  await connections.addPending(
    {
      ref: REF,
      ownerKey: OWNER,
      remoteCommunityId: 'community-1',
      label: 'DorkOS',
      pinnedOrigin: 'https://community.example',
      pairingId: 'pairing-1',
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    },
    'verifier'
  );
  await connections.complete(REF, OWNER, 'remote-owner', 'token', ACCESS);
});

afterEach(async () => {
  await rm(directory, { recursive: true, force: true });
});

describe('the monthly limit', () => {
  it('is none by default: every teammate turn may wake, and nothing is told', async () => {
    const counter = spend();
    await counter.load();
    for (let i = 0; i < 50; i += 1) await counter.record(REF, OWNER, 3);
    expect(counter.allows(REF, OWNER)).toBe(true);
    expect(await counter.summary(REF, OWNER)).toEqual({
      monthlyLimitUsd: null,
      spentUsd: 150,
      approximate: false,
      month: '2026-10',
    });
    expect(reached).not.toHaveBeenCalled();
  });

  it('stops teammates waking agents once the month’s turns cost the limit', async () => {
    const counter = spend();
    await counter.load();
    await counter.setLimit(REF, OWNER, 1);
    await counter.record(REF, OWNER, 0.6);
    expect(counter.allows(REF, OWNER)).toBe(true);
    await counter.record(REF, OWNER, 0.4);
    expect(counter.allows(REF, OWNER)).toBe(false);
  });

  it('tells the owner once a month, and again for a new limit or a new month', async () => {
    const counter = spend();
    await counter.load();
    await counter.setLimit(REF, OWNER, 1);
    await counter.record(REF, OWNER, 1);
    await counter.record(REF, OWNER, 1);
    expect(reached).toHaveBeenCalledTimes(1);
    expect(reached).toHaveBeenCalledWith({
      ref: REF,
      ownerKey: OWNER,
      limitUsd: 1,
      month: '2026-10',
    });
    await counter.setLimit(REF, OWNER, 2);
    await counter.record(REF, OWNER, 0.5);
    expect(reached).toHaveBeenCalledTimes(2);
    clock.now = Date.parse('2026-11-01T00:00:01.000Z');
    expect(counter.allows(REF, OWNER)).toBe(true);
    await counter.record(REF, OWNER, 2);
    expect(reached).toHaveBeenCalledTimes(3);
  });

  it('counts a turn that reported no cost at the estimate, and says the total is approximate', async () => {
    const counter = spend();
    await counter.load();
    await counter.record(REF, OWNER, undefined);
    expect(await counter.summary(REF, OWNER)).toMatchObject({
      spentUsd: TEAMMATE_TURN_ESTIMATE_USD,
      approximate: true,
    });
  });

  it('keeps the limit and the month across a restart', async () => {
    const first = spend();
    await first.load();
    await first.setLimit(REF, OWNER, 1);
    await first.record(REF, OWNER, 1.5);
    const restarted = spend();
    expect(restarted.allows(REF, OWNER)).toBe(false); // not read yet: fails closed
    await restarted.load();
    expect(restarted.allows(REF, OWNER)).toBe(false);
    expect(await restarted.summary(REF, OWNER)).toMatchObject({
      monthlyLimitUsd: 1,
      spentUsd: 1.5,
    });
    expect(
      JSON.parse(
        await readFile(join(directory, 'communities', 'remote', TEAMMATE_SPEND_FILE), 'utf8')
      )
    ).toHaveProperty('limits');
  });

  it('belongs to its owner: another owner can neither read nor change it', async () => {
    const counter = spend();
    await counter.load();
    await expect(counter.summary(REF, 'someone-else')).rejects.toBeInstanceOf(
      RemoteConnectionNotFoundError
    );
    await expect(counter.setLimit(REF, 'someone-else', 5)).rejects.toBeInstanceOf(
      RemoteConnectionNotFoundError
    );
  });

  it('is forgotten with its connection', async () => {
    const counter = spend();
    await counter.load();
    await counter.setLimit(REF, OWNER, 1);
    await counter.record(REF, OWNER, 2);
    await connections.disconnect(REF, OWNER);
    await vi.waitFor(async () => {
      const file = JSON.parse(
        await readFile(join(directory, 'communities', 'remote', TEAMMATE_SPEND_FILE), 'utf8')
      );
      expect(file).toEqual({ limits: {}, months: {} });
    });
  });

  it('takes dollars to the cent, above zero, or none', () => {
    const parse = (monthlyLimitUsd: unknown) =>
      CommunityTeammateSpendLimitRequestSchema.safeParse({ monthlyLimitUsd });
    expect(parse(12.345).data).toEqual({ monthlyLimitUsd: 12.35 });
    expect(parse(null).data).toEqual({ monthlyLimitUsd: null });
    expect(parse(0).success).toBe(false);
    expect(parse(-5).success).toBe(false);
    expect(parse('5').success).toBe(false);
  });
});

describe('the wake gate', () => {
  it('answers from the counter, and with none configured, always', async () => {
    const counter = spend();
    await counter.load();
    await counter.setLimit(REF, OWNER, 1);
    await counter.record(REF, OWNER, 1);
    expect(
      new RemoteWakePolicy(connections, [], undefined, undefined, counter).withinTeammateSpend(
        REF,
        OWNER
      )
    ).toBe(false);
    expect(new RemoteWakePolicy(connections, []).withinTeammateSpend(REF, OWNER)).toBe(true);
  });
});
