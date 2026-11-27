/**
 * `GET /api/events` numbers its frames and replays from `Last-Event-ID`
 * (ADR 261123-170833), over the real route and the real fan-out.
 *
 * The case that matters most is the filter: a replay must never hand a reader a
 * frame it could not have received live, so a resuming agent gets neither an
 * event addressed to the person nor the full rendering of a redacted one.
 */
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { honoGroupListener } from '../../http/__tests__/hono-group-listener.js';
import eventsRoutes from '../events.js';
import { eventFanOut } from '../../services/core/event-fan-out.js';
import { EVENT_REPLAY_LIMITS } from '../../lib/event-stream/event-replay-buffer.js';
import type { CallerPrincipal } from '../../lib/caller-principal.js';
import { initConfigManager } from '../../services/core/config-manager.js';

const AGENT = { 'x-dorkos-agent': 'tok_revoked' };
const operatorOnly = (principal: CallerPrincipal): boolean => principal.kind === 'operator';

let server: http.Server;
let baseUrl: string;
const open: http.ClientRequest[] = [];
let home: string;

// A real config in a throwaway folder: the `/api` chain reads it.
beforeAll(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'dorkos-events-replay-'));
  initConfigManager(home);
});
afterAll(() => fs.rmSync(home, { recursive: true, force: true }));

beforeEach(async () => {
  server = http.createServer(honoGroupListener({ path: '/api/events', routes: eventsRoutes }));
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const addr = server.address();
  baseUrl = `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}`;
});

afterEach(async () => {
  for (const req of open.splice(0)) req.destroy();
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

/** Open a stream; `until` is checked on every chunk. */
function stream(
  headers: Record<string, string>,
  path = '/api/events'
): (until: (text: string) => boolean) => Promise<string> {
  let text = '';
  const waiters = new Set<() => void>();
  const req = http.get(`${baseUrl}${path}`, { headers, agent: false }, (res) => {
    res.setEncoding('utf8');
    res.on('data', (chunk: string) => {
      text += chunk;
      for (const wake of waiters) wake();
    });
    res.on('error', () => undefined);
  });
  req.on('error', () => undefined);
  open.push(req);
  return (until) =>
    new Promise((resolve) => {
      const check = (): void => {
        if (!until(text)) return;
        waiters.delete(check);
        resolve(text);
      };
      waiters.add(check);
      check();
    });
}

/** Open a stream and resolve with its text once `until` holds. */
function read(
  headers: Record<string, string>,
  until: (text: string) => boolean,
  path?: string
): Promise<string> {
  return stream(headers, path)(until);
}

/** The ids and names of the numbered frames in a body, in order. */
function numbered(text: string): { id: string; event: string; data: string }[] {
  return [...text.matchAll(/id: (\S+)\nevent: (\S+)\ndata: (.*)\n\n/g)].map(
    ([, id, event, data]) => ({
      id: id!,
      event: event!,
      data: data!,
    })
  );
}

/** Broadcast a marker and return its frame id, read off a live stream. */
async function marker(): Promise<string> {
  const live = stream({});
  await live((text) => text.includes('event: connected'));
  eventFanOut.broadcast('tasks_changed', { marker: true });
  return numbered(await live((text) => text.includes('"marker":true'))).at(-1)!.id;
}

describe('GET /api/events replay', () => {
  it('numbers broadcasts and replays only what came after the cursor, filtered per reader', async () => {
    const cursor = await marker();
    expect(cursor).toMatch(/^events-\d+-g\d+-\d+$/);

    eventFanOut.broadcast('config_changed', { sections: ['spaces'] }, operatorOnly);
    eventFanOut.broadcastRedacted('session_status', { full: 1 }, { redacted: 1 }, operatorOnly);
    eventFanOut.broadcast('agents_changed', { kind: 'updated', agentId: 'a1' });

    const done = (text: string): boolean => text.includes('event: agents_changed');
    const person = await read({ 'last-event-id': cursor }, done);
    const agent = await read({ ...AGENT, 'last-event-id': cursor }, done);

    expect(person).toMatch(/^event: connected\ndata: \{"connectedAt":"[^"]+","resumed":true\}\n\n/);
    expect(numbered(person).map((f) => [f.event, f.data])).toEqual([
      ['config_changed', '{"sections":["spaces"]}'],
      ['session_status', '{"full":1}'],
      ['agents_changed', '{"kind":"updated","agentId":"a1"}'],
    ]);
    // The agent could not have received the person's frame or the full status live.
    expect(numbered(agent).map((f) => [f.event, f.data])).toEqual([
      ['session_status', '{"redacted":1}'],
      ['agents_changed', '{"kind":"updated","agentId":"a1"}'],
    ]);
    // One event, one seq, whichever rendering a reader got.
    expect(numbered(agent)[0]!.id).toBe(numbered(person)[1]!.id);
  });

  it('resumes from ?resume= too, the cursor a socket sends', async () => {
    const cursor = await marker();
    eventFanOut.broadcast('tasks_changed', { after: true });
    const text = await read(
      {},
      (t) => t.includes('"after":true'),
      `/api/events?resume=${encodeURIComponent(cursor)}`
    );
    expect(text).toContain('"resumed":true');
  });

  it('is a cold connect when the cursor is older than the window, foreign or unknown', async () => {
    const cursor = await marker();
    for (let i = 0; i <= EVENT_REPLAY_LIMITS.maxEvents; i += 1) {
      eventFanOut.broadcast('tasks_changed', { i });
    }
    const stale = cursor.replace(/-g\d+-/, '-g999999-');
    for (const lastEventId of [cursor, stale, '42', `rooms${cursor.slice('events'.length)}`]) {
      const text = await read({ 'last-event-id': lastEventId }, (t) => t.includes('\n\n'));
      expect(text, lastEventId).toMatch(/^event: connected\ndata: \{"connectedAt":"[^"]+"\}\n\n/);
    }
  });
});
