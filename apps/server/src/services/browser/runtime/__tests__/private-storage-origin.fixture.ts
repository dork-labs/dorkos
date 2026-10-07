import { createServer } from 'node:http';
import type { Socket } from 'node:net';
import { z } from 'zod';
const text = z.string().max(128);
export const OriginalStorageReportSchema = z
  .object({
    subject: z.enum(['A', 'B', 'clean']),
    round: z.number().int().min(0).max(3),
    pageId: text,
    visibleMarker: z.string().max(32),
    mutation: z.number().int().min(0).max(100),
    checkpoint: z.number().int().min(0).max(4),
    cookie: text.nullable(),
    localStorage: text.nullable(),
    indexedDB: text.nullable(),
    serviceWorker: text.nullable(),
    cacheStorage: text.nullable(),
    httpCache: z.number().int().positive().max(16),
    sessionCookie: text.nullable(),
    sessionStorage: text.nullable(),
  })
  .strict();
export type OriginalStorageReport = z.infer<typeof OriginalStorageReportSchema>;
export function requireOriginalStorage(
  report: OriginalStorageReport,
  expected: Readonly<{
    subject: 'A' | 'B';
    round: number;
    pageId: string;
    httpCache: number;
    mutation: number;
  }>
) {
  const value = expected.subject === 'A' ? 'fixture-alpha' : 'fixture-beta';
  if (
    report.subject !== expected.subject ||
    report.round !== expected.round ||
    report.pageId !== expected.pageId ||
    report.mutation !== expected.mutation ||
    report.visibleMarker !== expected.subject + ': ' + expected.mutation ||
    report.httpCache !== expected.httpCache ||
    ['cookie', 'localStorage', 'indexedDB', 'serviceWorker', 'cacheStorage'].some(
      (key) => Reflect.get(report, key) !== value
    )
  )
    throw new Error('STORAGE_ORIGINAL_DURABLE_VALUES_REQUIRED');
}
export function requireOriginalClean(
  report: OriginalStorageReport,
  pageId: string,
  previousHits: readonly number[]
) {
  if (
    report.subject !== 'clean' ||
    report.pageId !== pageId ||
    report.round !== 0 ||
    report.mutation !== 0 ||
    [
      'cookie',
      'localStorage',
      'indexedDB',
      'serviceWorker',
      'cacheStorage',
      'sessionCookie',
      'sessionStorage',
    ].some((key) => Reflect.get(report, key) !== null) ||
    previousHits.includes(report.httpCache)
  )
    throw new Error('STORAGE_ORIGINAL_CLEAN_REQUIRED');
}
export function requireOriginalMutationSequence(
  reports: readonly OriginalStorageReport[],
  subject: 'A' | 'B',
  pageId: string
): readonly OriginalStorageReport[] {
  const rows = reports.filter(
    (r) =>
      r.subject === subject &&
      r.round === 3 &&
      r.pageId === pageId &&
      r.mutation > 0 &&
      r.checkpoint === 0
  );
  if (
    rows.length !== 100 ||
    rows.some(
      (r, index) => r.mutation !== index + 1 || r.visibleMarker !== subject + ': ' + r.mutation
    )
  )
    throw new Error('STORAGE_ORIGINAL_100_MUTATIONS_REQUIRED');
  return Object.freeze([...rows]);
}
const PAGE = String.raw`async function originalStoragePage(options) {
  const { subject, round, pageId, seed } = options;
  const value = subject === 'A' ? 'fixture-alpha' : subject === 'B' ? 'fixture-beta' : 'fixture-clean';
  const db = await new Promise((yes, no) => {
    const request = indexedDB.open('dork-storage-fixture', 1);
    request.onupgradeneeded = () => request.result.createObjectStore('values');
    request.onsuccess = () => yes(request.result);
    request.onerror = () => no(request.error);
  });
  const idb = (write, next) => new Promise((yes, no) => {
    const tx = db.transaction('values', write ? 'readwrite' : 'readonly');
    const request = write ? tx.objectStore('values').put(next, 'identity') : tx.objectStore('values').get('identity');
    let result;
    request.onsuccess = () => { result = request.result ?? null; };
    tx.oncomplete = () => yes(write ? next : result);
    tx.onerror = () => no(tx.error);
    tx.onabort = () => no(tx.error);
  });
  if (seed) {
    document.cookie = 'dork_fixture=' + value + '; Max-Age=86400; Path=/; SameSite=Lax';
    document.cookie = 'dork_session=' + value + '; Path=/; SameSite=Lax';
    localStorage.setItem('identity', value);
    localStorage.setItem('mutations', '0');
    sessionStorage.setItem('identity', value);
    await idb(true, value);
    const cache = await caches.open('dork-storage-fixture');
    await cache.put('/cache-proof', new Response(value));
    await navigator.serviceWorker.register('/sw.js?identity=' + value);
    await navigator.serviceWorker.ready;
    if (!navigator.serviceWorker.controller) await new Promise((yes) => navigator.serviceWorker.addEventListener('controllerchange', yes, { once: true }));
  }
  const http = await (await fetch('/http-cache')).json();
  let checkpoint = 0;
  let mutation = Number(localStorage.getItem('mutations') ?? '0');
  const read = async () => {
    const cached = await caches.match('/cache-proof');
    const registrations = await navigator.serviceWorker.getRegistrations();
    let worker = null;
    if (registrations.length) {
      const response = await fetch('/sw-proof');
      if (!response.ok) throw new Error('fixture-service-worker-not-controlling');
      worker = await response.text();
    }
    return { subject, round, pageId, mutation, checkpoint, visibleMarker: document.getElementById('marker').textContent,
      cookie: document.cookie.split('; ').find((v) => v.startsWith('dork_fixture='))?.slice(13) ?? null,
      localStorage: localStorage.getItem('identity'), indexedDB: await idb(false),
      cacheStorage: cached ? await cached.text() : null, serviceWorker: worker,
      httpCache: http.counter,
      sessionCookie: document.cookie.split('; ').find((v) => v.startsWith('dork_session='))?.slice(13) ?? null,
      sessionStorage: sessionStorage.getItem('identity') };
  };
  const report = async () => {
    document.getElementById('marker').textContent = subject + ': ' + mutation;
    const response = await fetch('/report', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(await read()) });
    if (!response.ok) throw new Error('fixture-report-refused');
  };
  await report();
  for (;;) {
    const response = await fetch('/command?subject=' + subject + '&round=' + round + '&pageId=' + pageId, { cache: 'no-store' });
    if (!response.ok) throw new Error('fixture-command-refused');
    const command = await response.json();
    if (command.kind === 'mutate' && command.revision > mutation) {
      if (command.revision !== mutation + 1 || command.subject !== subject) throw new Error('fixture-mutation-discontinuity');
      mutation = command.revision;
      localStorage.setItem('mutations', String(mutation));
      await report();
    } else if (command.kind === 'clean-mutate' && localStorage.getItem('identity') !== value) {
      document.cookie = 'dork_fixture=' + value + '; Max-Age=86400; Path=/; SameSite=Lax';
      localStorage.setItem('identity', value); await idb(true, value);
      const cache = await caches.open('dork-storage-fixture'); await cache.put('/cache-proof', new Response(value));
      await report();
    } else if (command.kind === 'checkpoint' && command.revision > checkpoint) { checkpoint = command.revision; await report(); }
    await new Promise((yes) => setTimeout(yes, 20));
  }
}
`;
/** Fictitious original loopback origin. Commands run in the actual native Page, not a test frontend. */
export async function createOriginalStorageOrigin(signal: AbortSignal) {
  const reports: OriginalStorageReport[] = [],
    commands = new Map<string, { kind: string; subject: string; revision: number }>();
  const waiters = new Set<() => void>(),
    sockets = new Map<Socket, Promise<void>>(),
    jobs = new Set<Promise<void>>();
  let first: { value: unknown } | undefined,
    closed = false,
    httpHits = 0;
  const key = (subject: string, round: number, pageId: string) =>
    JSON.stringify([subject, round, pageId]);
  const guard = () => {
    if (first) throw first.value;
    if (closed) throw new Error('STORAGE_ORIGIN_CLOSED');
    signal.throwIfAborted();
  };
  const server = createServer((req, res) => {
    const original = Promise.resolve().then(async () => {
      guard();
      const url = new URL(req.url ?? '/', 'http://127.0.0.1');
      if (url.pathname === '/page') {
        const options = {
          subject: z.enum(['A', 'B', 'clean']).parse(url.searchParams.get('subject')),
          round: z.coerce.number().int().min(0).max(3).parse(url.searchParams.get('round')),
          pageId: text.parse(url.searchParams.get('pageId')),
          seed: url.searchParams.get('seed') === '1',
        };
        res.setHeader('Content-Type', 'text/html');
        res.setHeader('Cache-Control', 'no-store');
        res.end(
          '<!doctype html><title>Fictitious storage fixture</title><h1 id="marker"></h1><script>' +
            PAGE +
            'originalStoragePage(' +
            JSON.stringify(options) +
            ').catch(error=>fetch("/error",{method:"POST",body:String(error)}));</script>'
        );
        return;
      }
      if (url.pathname === '/sw.js') {
        const value = z
          .enum(['fixture-alpha', 'fixture-beta'])
          .parse(url.searchParams.get('identity'));
        res.setHeader('Content-Type', 'application/javascript');
        res.setHeader('Cache-Control', 'no-store');
        res.end(
          'self.addEventListener("install",()=>self.skipWaiting());self.addEventListener("activate",event=>event.waitUntil(self.clients.claim()));self.addEventListener("fetch",event=>{if(new URL(event.request.url).pathname==="/sw-proof")event.respondWith(Promise.resolve(new Response(' +
            JSON.stringify(value) +
            ')));});'
        );
        return;
      }
      if (url.pathname === '/http-cache') {
        res.setHeader('Cache-Control', 'public, max-age=86400, immutable');
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ counter: ++httpHits }));
        return;
      }
      if (url.pathname === '/command') {
        const id = key(
          url.searchParams.get('subject') ?? '',
          Number(url.searchParams.get('round')),
          url.searchParams.get('pageId') ?? ''
        );
        res.setHeader('Cache-Control', 'no-store');
        res.end(JSON.stringify(commands.get(id) ?? { kind: 'idle' }));
        return;
      }
      if (req.method === 'POST' && ['/report', '/error'].includes(url.pathname)) {
        const chunks: Buffer[] = [];
        let size = 0;
        for await (const chunk of req) {
          size += Buffer.byteLength(chunk);
          if (size > 4096) throw new Error('STORAGE_ORIGIN_BODY_BOUND');
          chunks.push(Buffer.from(chunk));
        }
        guard();
        const body = Buffer.concat(chunks).toString('utf8');
        if (url.pathname === '/error')
          throw new Error('STORAGE_ORIGINAL_PAGE_FAILED:' + body.slice(0, 128));
        const report = OriginalStorageReportSchema.parse(JSON.parse(body));
        if (reports.length >= 512) throw new Error('STORAGE_REPORT_BOUND');
        reports.push(Object.freeze(report));
        for (const wake of waiters) wake();
        res.end('{}');
        return;
      }
      res.statusCode = 404;
      res.end();
    });
    jobs.add(original);
    void original.then(
      () => jobs.delete(original),
      (value) => {
        first ??= { value };
        jobs.delete(original);
        for (const wake of waiters) wake();
        if (!res.headersSent) res.statusCode = 503;
        res.end();
      }
    );
  });
  server.on('connection', (socket) => {
    sockets.set(
      socket,
      new Promise<void>((resolve) =>
        socket.once('close', () => {
          sockets.delete(socket);
          resolve();
        })
      )
    );
  });
  const retain = (value: unknown) => {
    first ??= { value };
    for (const wake of waiters) wake();
  };
  const errors = (value: unknown) => retain(value);
  server.on('error', errors);
  const closeOriginal = async () => {
    closed = true;
    for (const wake of waiters) wake();
    const socketReturns = [...sockets.values()];
    const returned = new Promise<void>((yes, no) =>
      server.close((error) => {
        if (error && (!('code' in error) || error.code !== 'ERR_SERVER_NOT_RUNNING')) no(error);
        else yes();
      })
    );
    for (const socket of sockets.keys())
      try {
        socket.destroy();
      } catch (value) {
        retain(value);
      }
    for (const result of await Promise.allSettled([...jobs, ...socketReturns, returned]))
      if (result.status === 'rejected') retain(result.reason);
    server.removeListener('error', errors);
    if (first) throw first.value;
  };
  let address;
  try {
    guard();
    await new Promise<void>((yes, no) => {
      const failed = (value: unknown) => {
        server.removeListener('listening', ready);
        no(value);
      };
      const ready = () => {
        server.removeListener('error', failed);
        yes();
      };
      server.once('error', failed);
      server.once('listening', ready);
      server.listen(0, '127.0.0.1');
    });
    guard();
    address = server.address();
    if (!address || typeof address === 'string')
      throw new Error('STORAGE_ORIGINAL_ORIGIN_REQUIRED');
  } catch (value) {
    retain(value);
    await closeOriginal();
    throw value;
  }
  const wait = (
    predicate: (report: OriginalStorageReport) => boolean,
    admission: AbortSignal = signal
  ): Promise<OriginalStorageReport> => {
    const originalSignal = AbortSignal.any([signal, admission]);
    return new Promise((yes, no) => {
      const done = () => {
        try {
          guard();
          originalSignal.throwIfAborted();
          const value = [...reports].reverse().find(predicate);
          if (!value) return;
          finish();
          yes(value);
        } catch (value) {
          finish();
          no(value);
        }
      };
      const abort = () => {
        finish();
        no(originalSignal.reason);
      };
      const finish = () => {
        waiters.delete(done);
        originalSignal.removeEventListener('abort', abort);
      };
      waiters.add(done);
      originalSignal.addEventListener('abort', abort, { once: true });
      done();
    });
  };
  const checkpoint = async (
    subject: string,
    round: number,
    pageId: string,
    revision: number,
    admission: AbortSignal = signal
  ) => {
    guard();
    admission.throwIfAborted();
    commands.set(key(subject, round, pageId), { kind: 'checkpoint', subject, revision });
    return wait(
      (r) =>
        r.subject === subject &&
        r.round === round &&
        r.pageId === pageId &&
        r.checkpoint === revision,
      admission
    );
  };
  return Object.freeze({
    origin: 'http://127.0.0.1:' + address.port,
    reports,
    ready: (subject: string, round: number, pageId: string, admission: AbortSignal = signal) =>
      wait((r) => r.subject === subject && r.round === round && r.pageId === pageId, admission),
    checkpoint,
    async mutate100(subject: 'A' | 'B', pageId: string, admission: AbortSignal = signal) {
      for (let revision = 1; revision <= 100; revision++) {
        guard();
        admission.throwIfAborted();
        commands.set(key(subject, 3, pageId), { kind: 'mutate', subject, revision });
        await wait(
          (r) =>
            r.subject === subject &&
            r.round === 3 &&
            r.pageId === pageId &&
            r.mutation === revision,
          admission
        );
      }
      return checkpoint(subject, 3, pageId, 1, admission);
    },
    async mutateClean(pageId: string, admission: AbortSignal = signal) {
      guard();
      admission.throwIfAborted();
      commands.set(key('clean', 0, pageId), {
        kind: 'clean-mutate',
        subject: 'clean',
        revision: 1,
      });
      return wait(
        (r) => r.subject === 'clean' && r.pageId === pageId && r.localStorage === 'fixture-clean',
        admission
      );
    },
    httpHits: () => httpHits,
    assertCurrent: guard,
    close: closeOriginal,
  });
}
