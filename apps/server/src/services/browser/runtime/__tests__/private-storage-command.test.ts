import { expect, it, onTestFinished, vi } from 'vitest';
import {
  createOriginalStorageOrigin,
  requireOriginalMutationSequence,
  type OriginalStorageReport,
} from './private-storage-origin.fixture.js';

const observations = vi.hoisted(() => ({
  entering: [] as Array<(response: import('node:http').ServerResponse) => void>,
}));
vi.mock('node:http', async (original) => {
  const http = await original<typeof import('node:http')>();
  return {
    ...http,
    createServer: new Proxy(http.createServer, {
      apply(target, receiver, args) {
        const server: ReturnType<typeof http.createServer> = Reflect.apply(target, receiver, args);
        // Observation only: the original receiver runs first and owns all HTTP replies.
        server.on('request', (request, response) => {
          if (new URL(request.url ?? '/', 'http://127.0.0.1').pathname === '/command')
            queueMicrotask(() => observations.entering.shift()?.(response));
        });
        return server;
      },
    }),
  };
});

const report = (subject: 'A' | 'B', mutation: number, checkpoint = 0): OriginalStorageReport => ({
  subject,
  round: 3,
  pageId: 'page-' + subject,
  mutation,
  checkpoint,
  visibleMarker: subject + ': ' + mutation,
  cookie: subject === 'A' ? 'fixture-alpha' : 'fixture-beta',
  localStorage: subject === 'A' ? 'fixture-alpha' : 'fixture-beta',
  indexedDB: subject === 'A' ? 'fixture-alpha' : 'fixture-beta',
  serviceWorker: subject === 'A' ? 'fixture-alpha' : 'fixture-beta',
  cacheStorage: subject === 'A' ? 'fixture-alpha' : 'fixture-beta',
  httpCache: subject === 'A' ? 1 : 2,
  sessionCookie: null,
  sessionStorage: null,
});

async function fixture() {
  const lifetime = new AbortController();
  const origin = await createOriginalStorageOrigin(lifetime.signal);
  const clients: AbortController[] = [],
    jobs: Promise<unknown>[] = [];
  const own = <T>(job: Promise<T>) => {
    jobs.push(job);
    void job.catch(() => {});
    return job;
  };
  onTestFinished(async () => {
    for (const client of clients) client.abort();
    try {
      await origin.close();
    } finally {
      await Promise.allSettled(jobs);
      observations.entering.length = 0;
    }
  });
  const command = (subject: 'A' | 'B', cursor = '') => {
    const client = new AbortController();
    clients.push(client);
    let entered!: (response: import('node:http').ServerResponse) => void;
    const entry = new Promise<import('node:http').ServerResponse>((resolve) => {
      entered = resolve;
    });
    observations.entering.push(entered);
    const response = own(
      fetch(
        origin.origin +
          '/command?subject=' +
          subject +
          '&round=3&pageId=page-' +
          subject +
          '&cursor=' +
          encodeURIComponent(cursor),
        { signal: client.signal }
      ).then(async (reply) => {
        expect(reply.status).toBe(200);
        return reply.json() as Promise<{
          kind: string;
          subject: string;
          revision: number;
          cursor: string;
        }>;
      })
    );
    return { response, entry, client };
  };
  const sendReport = (value: OriginalStorageReport) =>
    own(
      (async () => {
        const sent = await fetch(origin.origin + '/report', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(value),
        });
        expect(sent.status).toBe(200);
        await sent.arrayBuffer();
      })()
    );
  return { origin, lifetime, own, command, sendReport };
}

it('holds a genuine idle HTTP command and wakes only the next distinct version', async () => {
  const f = await fixture();
  const initial = f.command('A');
  const original = await initial.entry;
  expect(original.writableEnded).toBe(false);
  const first = f.own(f.origin.checkpoint('A', 3, 'page-A', 1));
  const command = await initial.response;
  expect(command).toMatchObject({ kind: 'checkpoint', subject: 'A', revision: 1 });
  await f.sendReport(report('A', 0, 1));
  await first;
  const next = f.command('A', command.cursor);
  expect((await next.entry).writableEnded).toBe(false);
  const second = f.own(f.origin.checkpoint('A', 3, 'page-A', 2));
  expect(await next.response).toMatchObject({ kind: 'checkpoint', subject: 'A', revision: 2 });
  await f.sendReport(report('A', 0, 2));
  await second;
});

it('unregisters an actually disconnected idle response and preserves the next original command', async () => {
  const f = await fixture();
  const waiting = f.command('A');
  const original = await waiting.entry;
  const disconnected = original
    .rawListeners('close')
    .find(
      (listener) =>
        listener.name === 'disconnected' ||
        ('listener' in listener &&
          typeof listener.listener === 'function' &&
          listener.listener.name === 'disconnected')
    );
  expect(disconnected).toBeDefined();
  const closed = new Promise<void>((resolve) => original.once('close', resolve));
  waiting.client.abort();
  await Promise.allSettled([waiting.response]);
  await closed;
  expect(original.rawListeners('close')).not.toContain(disconnected);
  f.origin.assertCurrent();
  const next = f.command('A');
  expect((await next.entry).writableEnded).toBe(false);
  const checkpoint = f.own(f.origin.checkpoint('A', 3, 'page-A', 1));
  expect(await next.response).toMatchObject({ kind: 'checkpoint', revision: 1 });
  await f.sendReport(report('A', 0, 1));
  await checkpoint;
});

it.each(['parent-abort', 'origin-close'] as const)(
  'joins both actually held HTTP commands on %s without a polling timer',
  async (stop) => {
    const f = await fixture();
    const waiting = [f.command('A'), f.command('B')];
    const responses = await Promise.all(waiting.map((request) => request.entry));
    for (const response of responses) expect(response.writableEnded).toBe(false);
    const closed = responses.map(
      (response) => new Promise<void>((resolve) => response.once('close', resolve))
    );
    if (stop === 'parent-abort') f.lifetime.abort(new Error('original-parent-stop'));
    await f.origin.close();
    await Promise.all(closed);
    expect(
      (await Promise.allSettled(waiting.map((request) => request.response))).every(
        (row) => row.status === 'rejected'
      )
    ).toBe(true);
  }
);

it('retains all100 real HTTP command/report ACKs and distinguishes mutation100 from checkpoint1', async () => {
  const f = await fixture();
  const mutations = f.own(f.origin.mutate100('A', 'page-A'));
  let cursor = '';
  for (let revision = 1; revision <= 100; revision++) {
    const waiting = f.command('A', cursor);
    await waiting.entry;
    const command = await waiting.response;
    expect(command).toMatchObject({ kind: 'mutate', subject: 'A', revision });
    cursor = command.cursor;
    await f.sendReport(report('A', revision));
  }
  const checkpoint = f.command('A', cursor);
  await checkpoint.entry;
  expect(await checkpoint.response).toMatchObject({
    kind: 'checkpoint',
    subject: 'A',
    revision: 1,
  });
  await f.sendReport(report('A', 100, 1));
  await mutations;
  expect(requireOriginalMutationSequence(f.origin.reports, 'A', 'page-A')).toHaveLength(100);
});
