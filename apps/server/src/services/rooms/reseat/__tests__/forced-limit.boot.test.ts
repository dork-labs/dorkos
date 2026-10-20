/**
 * The forced-limit seam end to end (DOR-3143), on a real booted test server:
 * set a test account world, write to an agent in a DM, and watch its seat move
 * when the forced account runs out, at turn start and after a post and a tool
 * call. This is the loop QA's browser suite drives; it runs here first so the
 * seam is known to work before that suite does.
 *
 * @vitest-environment node
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  BOOT_HOOK_TIMEOUT_MS,
  bootComposedServer,
  type ComposedServer,
} from '../../../../http/__tests__/contract/harness.js';
import { FORCED_LIMIT_PARTIAL_ANSWER } from '../forced-limit-turn.js';

let server: ComposedServer | undefined;

async function api(method: string, url: string, body?: unknown): Promise<Record<string, unknown>> {
  const res = await fetch(new URL(url, server!.baseUrl), {
    method,
    headers: body === undefined ? {} : { 'content-type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await res.text();
  if (res.status >= 300) throw new Error(`${method} ${url} answered ${res.status}: ${text}`);
  return text ? (JSON.parse(text) as Record<string, unknown>) : {};
}

/** A DM with a freshly seeded agent. */
async function dmWithNewAgent(): Promise<string> {
  const seeded = await api('POST', '/api/test/seed-agent', {
    slot: 'permission-requester',
    instance: `reseat-${randomUUID().slice(0, 8)}`,
  });
  const room = await api('POST', '/api/rooms', {
    kind: 'dm',
    title: 'Re-seat',
    agentPaths: [seeded.agentDir as string],
  });
  return room.id as string;
}

interface Entry {
  kind: string;
  body: { text: string; notice?: string };
}

async function entries(roomId: string): Promise<Entry[]> {
  const answer = await api('GET', `/api/rooms/${roomId}/entries?limit=100`);
  return answer.entries as Entry[];
}

/** Wait until the room holds an entry that matches. */
async function waitFor(roomId: string, match: (entry: Entry) => boolean): Promise<Entry[]> {
  const deadline = Date.now() + 30_000;
  for (;;) {
    const all = await entries(roomId);
    if (all.some(match)) return all;
    if (Date.now() > deadline) {
      throw new Error(`Timed out. Entries: ${JSON.stringify(all.map((e) => e.body.text))}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
}

const reseated = (entry: Entry) => entry.body.notice === 'agent_reseated';

beforeAll(async () => {
  server = await bootComposedServer();
}, BOOT_HOOK_TIMEOUT_MS);

afterAll(async () => {
  await server?.close();
});

describe('the forced-limit seam on a booted test server', () => {
  it('moves the seat when the forced account runs out at turn start', async () => {
    const roomId = await dmWithNewAgent();
    await api('PUT', '/api/test/account-world', {
      accounts: [
        { id: 'claude4', label: 'Claude4' },
        { id: 'claude3', label: 'Claude3' },
      ],
      startAccount: 'claude4',
      force: { accountId: 'claude4', at: 'turn-start' },
    });

    await api('POST', `/api/rooms/${roomId}/entries`, { text: 'What is next?' });

    const all = await waitFor(roomId, reseated);
    expect(all.filter(reseated).map((e) => e.body.text)).toEqual([
      expect.stringMatching(/ ran out of usage on Claude4, so it's continuing on Claude3\.$/),
    ]);
  });

  it('moves the seat after a post and a tool call, without a second move', async () => {
    const roomId = await dmWithNewAgent();
    await api('PUT', '/api/test/account-world', {
      accounts: [
        { id: 'claude4', label: 'Claude4' },
        { id: 'claude3', label: 'Claude3' },
      ],
      startAccount: 'claude4',
      force: { accountId: 'claude4', at: 'after-post' },
    });

    await api('POST', `/api/rooms/${roomId}/entries`, { text: 'Please check the deploy.' });

    const all = await waitFor(roomId, reseated);
    expect(all.some((e) => e.body.text === FORCED_LIMIT_PARTIAL_ANSWER)).toBe(true);
    expect(all.filter(reseated)).toHaveLength(1);
  });

  it('clears the world on reset', async () => {
    await api('POST', '/api/test/reset');
    const roomId = await dmWithNewAgent();
    await api('POST', `/api/rooms/${roomId}/entries`, { text: 'Hello?' });
    await new Promise((resolve) => setTimeout(resolve, 2_000));
    expect((await entries(roomId)).filter(reseated)).toEqual([]);
  });
});
