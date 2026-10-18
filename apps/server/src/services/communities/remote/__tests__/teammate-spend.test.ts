/**
 * The card limit (DOR-2956): a monthly limit per space on what teammates' turns may cost the
 * owner, none by default, counted from each turn's reported cost (or a fixed estimate), kept
 * across a restart, reset each month, and told to the owner once a month when reached.
 *
 * @vitest-environment node
 */
import {
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  realpath,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
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
  SharedFolderRefusedError,
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
const reached = vi.fn(async (_reached: unknown) => undefined);
const reset = vi.fn();

function spend() {
  return new TeammateSpend(directory, connections, { reached, reset }, () => clock.now);
}

const spendFile = () => join(directory, 'communities', 'remote', TEAMMATE_SPEND_FILE);

beforeEach(async () => {
  clock.now = Date.parse('2026-10-17T12:00:00.000Z');
  reached.mockReset();
  reached.mockImplementation(async () => undefined);
  reset.mockReset();
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
    for (let i = 0; i < 50; i += 1) await counter.record(REF, OWNER, 3);
    expect(counter.allows(REF, OWNER)).toBe(true);
    expect(await counter.summary(REF, OWNER)).toEqual({
      monthlyLimitUsd: null,
      spentUsd: 150,
      approximate: false,
      month: '2026-10',
      sharedFolder: null,
    });
    expect(reached).not.toHaveBeenCalled();
  });

  it('stops teammates waking agents once the month’s turns cost the limit', async () => {
    const counter = spend();
    await counter.setLimit(REF, OWNER, 1);
    await counter.record(REF, OWNER, 0.6);
    expect(counter.allows(REF, OWNER)).toBe(true);
    await counter.record(REF, OWNER, 0.4);
    expect(counter.allows(REF, OWNER)).toBe(false);
  });

  it('tells the owner once a month, and again for a new limit or a new month', async () => {
    const counter = spend();
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
    // Read when it is made: the gate never answers before the file is read.
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
    await expect(counter.summary(REF, 'someone-else')).rejects.toBeInstanceOf(
      RemoteConnectionNotFoundError
    );
    await expect(counter.setLimit(REF, 'someone-else', 5)).rejects.toBeInstanceOf(
      RemoteConnectionNotFoundError
    );
  });

  it('is forgotten with its connection', async () => {
    const counter = spend();
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
    expect(parse(0.005).data).toEqual({ monthlyLimitUsd: 0.01 });
    // Review B1: checked after rounding, so a tenth of a cent is refused, never saved as $0.
    expect(parse(0.004).success).toBe(false);
    expect(parse(0.001).success).toBe(false);
    expect(parse(0).success).toBe(false);
    expect(parse(-5).success).toBe(false);
    expect(parse('5').success).toBe(false);
  });
});

describe('a file that can’t be read (review S1)', () => {
  it('is set aside, starts empty, blocks no space, tells the owner once, and takes a new limit', async () => {
    await mkdir(join(directory, 'communities', 'remote'), { recursive: true });
    await writeFile(spendFile(), '{"limits":{"x":0},"months":{}}'); // a $0 limit: unreadable
    const counter = spend();
    expect(reset).toHaveBeenCalledTimes(1);
    expect(counter.allows(REF, OWNER)).toBe(true);
    const files = await readdir(join(directory, 'communities', 'remote'));
    expect(files.some((name) => name.startsWith(`${TEAMMATE_SPEND_FILE}.corrupt-`))).toBe(true);
    await counter.setLimit(REF, OWNER, 2);
    expect((await counter.summary(REF, OWNER)).monthlyLimitUsd).toBe(2);
    expect(reset).toHaveBeenCalledTimes(1);
  });

  it('reads a file a newer DorkOS wrote with fields this one doesn’t know', async () => {
    await mkdir(join(directory, 'communities', 'remote'), { recursive: true });
    const key = `${OWNER}\0${REF}`;
    await writeFile(
      spendFile(),
      JSON.stringify({
        limits: { [key]: 1 },
        months: { [key]: { month: '2026-10', usd: 3, estimated: 0, told: true, extra: 1 } },
        future: true,
      })
    );
    const counter = spend();
    expect(reset).not.toHaveBeenCalled();
    expect(counter.allows(REF, OWNER)).toBe(false);
  });
});

describe('what a turn counts as', () => {
  it('counts a cost that is not a real amount at the estimate, marked approximate (review S2)', async () => {
    const counter = spend();
    for (const cost of [Number.NaN, Number.POSITIVE_INFINITY, -1])
      await counter.record(REF, OWNER, cost);
    expect(await counter.summary(REF, OWNER)).toMatchObject({
      spentUsd: 3 * TEAMMATE_TURN_ESTIMATE_USD,
      approximate: true,
    });
    // And the file still reads.
    expect(spend().allows(REF, OWNER)).toBe(true);
    expect(reset).not.toHaveBeenCalled();
  });
});

describe('telling the owner (review S4)', () => {
  it('records it as told only once the owner was told, and tries again next turn', async () => {
    const counter = spend();
    await counter.setLimit(REF, OWNER, 1);
    reached.mockRejectedValueOnce(new Error('notifications down'));
    await counter.record(REF, OWNER, 1);
    await counter.record(REF, OWNER, 0.1);
    await counter.record(REF, OWNER, 0.1);
    expect(reached).toHaveBeenCalledTimes(2);
  });
});

describe('the shared folder (DOR-2956)', () => {
  it('is none by default, kept by its realpath, remembered, and cleared', async () => {
    const counter = spend();
    expect(counter.sharedFolder(REF, OWNER)).toBeNull();
    const folder = join(directory, 'acme');
    await mkdir(folder);
    await counter.setSharedFolder(REF, OWNER, `${folder}/./`);
    const real = await realpath(folder);
    expect(counter.sharedFolder(REF, OWNER)).toBe(real);
    expect(spend().sharedFolder(REF, OWNER)).toBe(real);
    expect((await counter.summary(REF, OWNER)).sharedFolder).toBe(real);
    await counter.setSharedFolder(REF, OWNER, null);
    expect(counter.sharedFolder(REF, OWNER)).toBeNull();
  });

  it('refuses what is not a folder, the whole disk, and another owner', async () => {
    const counter = spend();
    await writeFile(join(directory, 'file.txt'), 'x');
    for (const bad of [
      'relative/path',
      join(directory, 'missing'),
      join(directory, 'file.txt'),
      '/',
    ]) {
      await expect(counter.setSharedFolder(REF, OWNER, bad)).rejects.toBeInstanceOf(
        SharedFolderRefusedError
      );
    }
    await expect(counter.setSharedFolder(REF, 'someone-else', directory)).rejects.toBeInstanceOf(
      RemoteConnectionNotFoundError
    );
    expect(counter.sharedFolder(REF, OWNER)).toBeNull();
  });

  it('refuses DorkOS’s, Claude’s and agents’ folders, the home folder, and anything around them (review 1a)', async () => {
    // Named as the server names them, not by realpath: the guard resolves both sides.
    const home = join(directory, 'home');
    const dorkData = join(directory, 'dork-data');
    const claude = join(directory, 'claude-config');
    const agent = join(home, 'agents', 'bot');
    const project = join(home, 'code', 'acme');
    for (const dir of [dorkData, claude, join(agent, 'src'), project]) {
      await mkdir(join(dir, 'deep'), { recursive: true });
    }
    await symlink(agent, join(home, 'code', 'bot-link'));
    const counter = spend();
    counter.useProtectedFolders(() => ({ inside: [dorkData, claude, agent], around: [home] }));
    for (const bad of [
      dorkData,
      join(dorkData, 'deep'),
      claude,
      agent,
      join(agent, 'src'),
      join(home, 'agents'), // holds an agent
      join(home, 'code', 'bot-link'), // an agent, by a link
      home,
      directory, // holds the home folder
    ]) {
      await expect(counter.setSharedFolder(REF, OWNER, bad), bad).rejects.toThrow(
        'That folder holds DorkOS, Claude or agent files. Choose another.'
      );
    }
    expect(counter.sharedFolder(REF, OWNER)).toBeNull();
    // A project inside the home folder is what sharing is for.
    await counter.setSharedFolder(REF, OWNER, project);
    expect(counter.sharedFolder(REF, OWNER)).toBe(await realpath(project));
    // The home folder on its own: never it nor around it, whatever else is guarded.
    counter.useProtectedFolders(() => ({ inside: [], around: [home] }));
    for (const bad of [home, directory]) {
      await expect(counter.setSharedFolder(REF, OWNER, bad), bad).rejects.toBeInstanceOf(
        SharedFolderRefusedError
      );
    }
  });

  it('refuses a folder with a never-shared name anywhere in its path, by its realpath (review 1a)', async () => {
    const counter = spend();
    const project = join(directory, 'acme');
    for (const dir of ['.git/hooks', '.SSH', 'notes.d/.Claude/x']) {
      await mkdir(join(project, dir), { recursive: true });
    }
    await symlink(join(project, '.git'), join(directory, 'innocent'));
    for (const bad of [
      join(project, '.git', 'hooks'),
      join(project, '.SSH'),
      join(project, 'notes.d', '.Claude', 'x'),
      join(directory, 'innocent'),
    ]) {
      await expect(counter.setSharedFolder(REF, OWNER, bad), bad).rejects.toThrow(
        'That folder is never shared. Choose another.'
      );
    }
    expect(counter.sharedFolder(REF, OWNER)).toBeNull();
  });
});

describe('the wake gate', () => {
  it('answers from the counter, and with none configured, always', async () => {
    const counter = spend();
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
