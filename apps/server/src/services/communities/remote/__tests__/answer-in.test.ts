/**
 * Where any person's post in a space wakes this install's agents without a mention (spec
 * `official-community-space` D11): the list is stored per connection beside connections.json,
 * owner-scoped and empty by default, answered synchronously for the live stream, and every wake
 * it allows is held to a budget per author and per channel.
 *
 * @vitest-environment node
 */
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { CommunityRef } from '@dorkos/shared/community-adapter';
import { CommunityAnswerInSchema } from '@dorkos/shared/community-connections';
import type { CredentialStore } from '../../../core/credential-provider.js';
import { RemoteConnectionNotFoundError, RemoteConnectionStore } from '../connection-store.js';
import { AnswerInBudget, RemoteAnswerIn } from '../wake/answer-in.js';
import { AnswerInStore } from '../wake/answer-in-store.js';
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
let store: AnswerInStore;

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'answer-in-'));
  connections = new RemoteConnectionStore(directory, memoryCredentials());
  store = new AnswerInStore(directory, connections);
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

const sideFile = () => join(directory, 'communities', 'remote', 'answer-in.json');

describe('the list a person sends', () => {
  it('drops a leading #, surrounding space and case, and repeats', () => {
    expect(CommunityAnswerInSchema.parse({ answerIn: [' #Help', 'welcome', 'help'] })).toEqual({
      answerIn: ['help', 'welcome'],
    });
  });

  it('refuses a name with spaces in it, an empty one, and too many', () => {
    expect(CommunityAnswerInSchema.safeParse({ answerIn: ['two words'] }).success).toBe(false);
    expect(CommunityAnswerInSchema.safeParse({ answerIn: ['#'] }).success).toBe(false);
    const many = Array.from({ length: 21 }, (_, index) => `c${index}`);
    expect(CommunityAnswerInSchema.safeParse({ answerIn: many }).success).toBe(false);
  });
});

describe('the stored list', () => {
  it('is empty until the owner sets it, and remembers it', async () => {
    expect(await store.get(REF, OWNER)).toEqual([]);
    await store.set(REF, OWNER, ['welcome', 'help']);
    const reopened = new AnswerInStore(directory, connections);
    expect(await reopened.get(REF, OWNER)).toEqual(['welcome', 'help']);
  });

  it('belongs to its owner: another owner can neither read nor change it', async () => {
    await expect(store.get(REF, 'someone-else')).rejects.toBeInstanceOf(
      RemoteConnectionNotFoundError
    );
    await expect(store.set(REF, 'someone-else', ['help'])).rejects.toBeInstanceOf(
      RemoteConnectionNotFoundError
    );
    expect(await store.all()).toEqual([]);
  });

  it('stays out of connections.json, which an older DorkOS reads strictly', async () => {
    await store.set(REF, OWNER, ['help']);
    const records = await readFile(
      join(directory, 'communities', 'remote', 'connections.json'),
      'utf8'
    );
    expect(records).not.toContain('help');
  });

  it('is forgotten when the connection is, and ignored at once before that', async () => {
    await store.set(REF, OWNER, ['help']);
    await connections.disconnect(REF, OWNER);
    expect(await store.all()).toEqual([]);
    await expect.poll(async () => JSON.parse(await readFile(sideFile(), 'utf8'))).toEqual({});
  });

  it('refuses to write over a damaged file rather than starting from nothing', async () => {
    await writeFile(sideFile(), '{not json');
    await expect(store.set(REF, OWNER, ['help'])).rejects.toThrow();
    expect(await readFile(sideFile(), 'utf8')).toBe('{not json');
  });
});

describe('the answer the live stream asks', () => {
  it('answers nowhere before it has loaded', async () => {
    await store.set(REF, OWNER, ['help']);
    const answerIn = new RemoteAnswerIn(store, connections);
    expect(answerIn.covers(REF, OWNER, 'help')).toBe(false);
    await answerIn.reload();
    expect(answerIn.covers(REF, OWNER, 'help')).toBe(true);
  });

  it('applies a change at once, and matches the channel name however it is written', async () => {
    const answerIn = new RemoteAnswerIn(store, connections);
    await answerIn.reload();
    await answerIn.set(REF, OWNER, ['help']);
    expect(answerIn.covers(REF, OWNER, '#Help')).toBe(true);
    expect(answerIn.covers(REF, OWNER, 'general')).toBe(false);
    await answerIn.set(REF, OWNER, []);
    expect(answerIn.covers(REF, OWNER, 'help')).toBe(false);
  });

  it('answers only for its own connection and owner', async () => {
    const answerIn = new RemoteAnswerIn(store, connections);
    await answerIn.set(REF, OWNER, ['help']);
    expect(answerIn.covers('remote_other' as CommunityRef, OWNER, 'help')).toBe(false);
    expect(answerIn.covers(REF, 'someone-else', 'help')).toBe(false);
  });

  it('keeps its last answer when a later read finds the file damaged', async () => {
    const answerIn = new RemoteAnswerIn(store, connections);
    await answerIn.set(REF, OWNER, ['help']);
    await writeFile(sideFile(), '{not json');
    await answerIn.reload();
    expect(answerIn.covers(REF, OWNER, 'help')).toBe(true);
  });

  it('is what the wake policy answers with, and a policy without one answers nowhere', async () => {
    const answerIn = new RemoteAnswerIn(store, connections);
    const policy = new RemoteWakePolicy(connections, [], undefined, answerIn);
    await policy.setAnswerIn(REF, OWNER, ['help']);
    expect(await policy.getAnswerIn(REF, OWNER)).toEqual(['help']);
    expect(policy.answersIn(REF, OWNER, 'help')).toBe(true);
    expect(policy.takeAnswerInWake(REF, OWNER, 'help', 'remote-stranger')).toBe(true);

    const bare = new RemoteWakePolicy(connections, []);
    expect(bare.answersIn(REF, OWNER, 'help')).toBe(false);
    expect(bare.takeAnswerInWake(REF, OWNER, 'help', 'remote-stranger')).toBe(false);
  });
});

describe('the budget every answer-in wake is held to', () => {
  const LIMITS = { windowMs: 1_000, perAuthor: 2, perChannel: 3 };

  it('gives one author only their share, in any channel', () => {
    const budget = new AnswerInBudget(LIMITS, () => 0);
    expect(budget.take('space', 'help', 'ana')).toBe(true);
    expect(budget.take('space', 'welcome', 'ana')).toBe(true);
    expect(budget.take('space', 'help', 'ana')).toBe(false);
    // Somebody else still gets an answer.
    expect(budget.take('space', 'help', 'bo')).toBe(true);
  });

  it('gives one channel only its share, however many people post', () => {
    const budget = new AnswerInBudget(LIMITS, () => 0);
    expect(['a', 'b', 'c', 'd', 'e'].map((author) => budget.take('space', 'help', author))).toEqual(
      [true, true, true, false, false]
    );
    expect(budget.take('space', 'welcome', 'd')).toBe(true);
  });

  it('spends nothing on a refused post, and refills once the window passes', () => {
    let now = 0;
    const budget = new AnswerInBudget(LIMITS, () => now);
    budget.take('space', 'help', 'ana');
    budget.take('space', 'help', 'ana');
    for (let index = 0; index < 50; index += 1) budget.take('space', 'help', 'ana');
    // Fifty refused posts did not use up the channel's share.
    expect(budget.take('space', 'help', 'bo')).toBe(true);
    now = 1_000;
    expect(budget.take('space', 'help', 'ana')).toBe(true);
  });

  it('keeps separate budgets for separate connections', () => {
    const budget = new AnswerInBudget({ ...LIMITS, perAuthor: 1 }, () => 0);
    expect(budget.take('space-a', 'help', 'ana')).toBe(true);
    expect(budget.take('space-b', 'help', 'ana')).toBe(true);
  });
});
