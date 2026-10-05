import { createServer } from 'node:http';
import type { Socket } from 'node:net';
import { randomBytes } from 'node:crypto';
import { fixtureWait } from './fixture-manager-custody.js';

export type StoresReport = {
  page: string;
  role: string;
  cookie: string;
  sessionCookie: boolean;
  expiredCookie: boolean;
  local: string | null;
  indexed: string | null;
  revision: number;
  localRevision: number;
  worker: string | null;
  cache: string | null;
  http: string;
  error: string | null;
};
const keys = [
  'page',
  'role',
  'cookie',
  'sessionCookie',
  'expiredCookie',
  'local',
  'indexed',
  'revision',
  'localRevision',
  'worker',
  'cache',
  'http',
  'error',
];
export function parseStoresReport(value: unknown): StoresReport {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw Error('REPORT_SCHEMA');
  const row = value as Record<string, unknown>;
  if (Object.keys(row).length !== keys.length || keys.some((key) => !Object.hasOwn(row, key)))
    throw Error('REPORT_SCHEMA');
  for (const key of ['page', 'role', 'cookie', 'http'])
    if (typeof row[key] !== 'string' || (row[key] as string).length > 256)
      throw Error('REPORT_SCHEMA');
  for (const key of ['local', 'indexed', 'worker', 'cache', 'error'])
    if (row[key] !== null && (typeof row[key] !== 'string' || (row[key] as string).length > 256))
      throw Error('REPORT_SCHEMA');
  if (
    !Number.isSafeInteger(row.localRevision) ||
    (row.localRevision as number) < 0 ||
    (row.localRevision as number) > 100
  )
    throw Error('REPORT_SCHEMA');
  if (
    typeof row.sessionCookie !== 'boolean' ||
    typeof row.expiredCookie !== 'boolean' ||
    !Number.isSafeInteger(row.revision) ||
    (row.revision as number) < 0 ||
    (row.revision as number) > 100
  )
    throw Error('REPORT_SCHEMA');
  return row as StoresReport;
}
export function assertRetainedStores(row: StoresReport, role: string, revision: number) {
  if (
    row.error ||
    row.cookie !== role ||
    row.local !== role ||
    row.indexed !== role ||
    row.worker !== role ||
    row.cache !== role ||
    row.http !== role
  )
    throw Error('RETAINED_STORE_MISSING');
  if (row.role !== role) throw Error('PROFILE_STATE_SHARED');
  if (row.revision !== revision || row.localRevision !== revision) throw Error('MUTATION_REVISION');
  if (row.expiredCookie) throw Error('EXPIRED_COOKIE_PRESENT');
}
export function assertCleanStores(row: StoresReport) {
  if (
    row.error ||
    row.cookie ||
    row.local !== null ||
    row.indexed !== null ||
    row.worker !== null ||
    row.cache !== null ||
    row.revision !== 0 ||
    row.localRevision !== 0 ||
    row.sessionCookie ||
    row.expiredCookie
  )
    throw Error('CLEAN_CONTEXT_SEEDED');
}
export function assertIsolatedStores(a: StoresReport, b: StoresReport) {
  if (a.role === b.role || a.local === b.local || a.indexed === b.indexed || a.cookie === b.cookie)
    throw Error('PROFILE_STATE_SHARED');
  assertRetainedStores(a, 'A', 100);
  assertRetainedStores(b, 'B', 100);
}

/** Fixture-only origin. Every delivered original socket is retained before callbacks, with bounded reports. */
export function createStoresFixture() {
  const sockets = new Set<Socket>();
  const reports: StoresReport[] = [];
  let role = 'A',
    page = '',
    reset = false,
    seedClean = false,
    httpRequests = 0,
    failed = false;
  const server = createServer((request, response) => {
    const url = new URL(request.url ?? '/', 'http://fixture');
    response.setHeader('Cache-Control', 'no-store');
    if (url.pathname === '/http-cache') {
      httpRequests++;
      response.setHeader('Cache-Control', 'public, max-age=86400, immutable');
      response.end(role);
    } else if (url.pathname === '/sw.js') {
      response.setHeader('Content-Type', 'application/javascript');
      response.end(
        `self.addEventListener('install',e=>e.waitUntil(self.skipWaiting()));self.addEventListener('activate',e=>e.waitUntil(self.clients.claim()));self.addEventListener('message',e=>e.ports[0].postMessage(${JSON.stringify(url.searchParams.get('role'))}));`
      );
    } else if (url.pathname === '/report' && request.method === 'POST') {
      const chunks: Buffer[] = [];
      let bytes = 0;
      request.on('data', (chunk) => {
        bytes += chunk.length;
        if (bytes <= 4096) chunks.push(Buffer.from(chunk));
        else {
          failed = true;
          response.writeHead(413);
          response.end();
        }
      });
      request.on('error', () => {
        failed = true;
      });
      request.on('end', () => {
        if (bytes > 4096) return;
        try {
          if (reports.length >= 512) throw Error('REPORT_CAPACITY');
          reports.push(parseStoresReport(JSON.parse(Buffer.concat(chunks).toString('utf8'))));
          response.end('ok');
        } catch {
          failed = true;
          response.writeHead(400);
          response.end();
        }
      });
    } else if (url.pathname === '/') {
      response.setHeader('Content-Type', 'text/html');
      response.end(`<!doctype html><style>button{width:140px;height:60px}body{margin:0;font:24px sans-serif}</style><div id="marker">${role}</div><button id="seed">Seed</button><button id="mutate">Mutate</button><button id="report">Report</button><script>
      const ROLE=${JSON.stringify(role)},PAGE=${JSON.stringify(page)},RESET=${reset},SEED_CLEAN=${seedClean};
      let db,tail=Promise.resolve();
      const request=r=>new Promise((ok,bad)=>{r.onsuccess=()=>ok(r.result);r.onerror=()=>bad(r.error)});
      const transaction=(mode,write)=>new Promise((ok,bad)=>{const t=db.transaction('state',mode),s=t.objectStore('state');write(s);t.oncomplete=ok;t.onerror=()=>bad(t.error);t.onabort=()=>bad(t.error)});
      const get=()=>request(db.transaction('state','readonly').objectStore('state').get('value'));
      async function seed(){document.cookie='retained='+ROLE+';Max-Age=3600;Path=/';document.cookie='session=present;Path=/';document.cookie='expired=gone;Max-Age=1;Path=/';if(!document.cookie.includes('expired='))throw Error('expiry-seed');localStorage.setItem('role',ROLE);localStorage.setItem('revision','0');await transaction('readwrite',s=>s.put({role:ROLE,revision:0},'value'));await navigator.serviceWorker.register('/sw.js?role='+ROLE);await navigator.serviceWorker.ready;await(await caches.open('fixture')).put('/retained',new Response(ROLE));await fetch('/http-cache');await new Promise(resolve=>setTimeout(resolve,1200));}
      async function report(error=null){const value=await get(),registration=await navigator.serviceWorker.getRegistration();let worker=null;if(registration?.active){const channel=new MessageChannel();worker=await new Promise((ok,bad)=>{const timer=setTimeout(()=>bad(Error('worker-timeout')),2000);channel.port1.onmessage=e=>{clearTimeout(timer);channel.port1.close();ok(e.data)};registration.active.postMessage('read',[channel.port2])})}const cache=await caches.match('/retained');const cookie=document.cookie.split('; ').find(x=>x.startsWith('retained='));await fetch('/report',{method:'POST',body:JSON.stringify({page:PAGE,role:ROLE,cookie:cookie?.slice(9)||'',sessionCookie:document.cookie.includes('session='),expiredCookie:document.cookie.includes('expired='),local:localStorage.getItem('role'),indexed:value?.role??null,revision:value?.revision??0,localRevision:Number(localStorage.getItem('revision')||0),worker,cache:cache?await cache.text():null,http:await(await fetch('/http-cache')).text(),error})});}
      function enqueue(fn){tail=tail.then(fn).catch(async e=>{await report(String(e.message).slice(0,256))})}
      document.getElementById('seed').onclick=()=>enqueue(async()=>{await seed();await report()});
      document.getElementById('mutate').onclick=()=>enqueue(async()=>{const value=await get();if(!value||value.revision>=100)throw Error('mutation-state');value.revision++;await transaction('readwrite',s=>s.put(value,'value'));localStorage.setItem('revision',String(value.revision));await report()});
      document.getElementById('report').onclick=()=>enqueue(()=>report());
      tail=(async()=>{const open=indexedDB.open('retained',1);open.onupgradeneeded=()=>open.result.createObjectStore('state');db=await request(open);if(RESET){localStorage.clear();await transaction('readwrite',s=>s.clear());document.cookie='retained=;Max-Age=0;Path=/';await caches.delete('fixture');for(const r of await navigator.serviceWorker.getRegistrations())await r.unregister()}if(SEED_CLEAN)await seed();await report()})();
      </script>`);
    } else {
      response.writeHead(404);
      response.end();
    }
  });
  server.on('connection', (socket) => {
    sockets.add(socket);
    socket.once('close', () => sockets.delete(socket));
    socket.on('error', () => {
      failed = true;
    });
    if (sockets.size > 64) {
      failed = true;
      server.close();
      socket.destroy();
    }
  });
  let closing: Promise<void> | undefined;
  return Object.freeze({
    configure(next: { role: 'A' | 'B' | 'C'; reset?: boolean; seedClean?: boolean }) {
      role = next.role;
      reset = next.reset ?? false;
      seedClean = next.seedClean ?? false;
      page = randomBytes(8).toString('hex');
      return page;
    },
    async listen() {
      await fixtureWait(
        new Promise<void>((resolve, reject) => {
          server.once('error', reject);
          server.listen(0, '127.0.0.1', resolve);
        }),
        2000,
        'ORIGIN_LISTEN_TIMEOUT'
      );
      const address = server.address();
      if (!address || typeof address === 'string') throw Error('ORIGIN_UNAVAILABLE');
      return 'http://127.0.0.1:' + address.port;
    },
    reports,
    get httpRequests() {
      return httpRequests;
    },
    get failed() {
      return failed;
    },
    close() {
      closing ??= new Promise<void>((resolve, reject) => {
        server.close((error) => {
          if (error) reject(error);
          else if (sockets.size) reject(Error('ORIGIN_ORIGINAL_SOCKETS_PENDING'));
          else if (failed) reject(Error('ORIGIN_CUSTODY_FAILED'));
          else resolve();
        });
      });
      return closing;
    },
  });
}

/** Reusable slots are released only by actual original settlement, never the finite classifier. */
const retainedCalls = new Set<object>();
export function ownStoresCalls() {
  const originals = new Set<Promise<unknown>>();
  const owner = { originals };
  retainedCalls.add(owner);
  let stopping = false,
    failed = false,
    issued = 0;
  const call = <T>(label: string, invoke: () => Promise<T>, milliseconds = 5000): Promise<T> => {
    if (stopping || failed || originals.size >= 16 || issued >= 512)
      return Promise.reject(Error('STORES_ORIGINAL_ADMISSION_REFUSED'));
    issued++;
    const original = Promise.resolve().then(invoke);
    originals.add(original);
    void original.then(
      () => originals.delete(original),
      () => {
        originals.delete(original);
        failed = true;
      }
    );
    return fixtureWait(original, milliseconds, label + ':EXPIRED').catch((error) => {
      failed = true;
      throw error;
    });
  };
  let closing: Promise<void> | undefined;
  return Object.freeze({
    call,
    close() {
      closing ??= (async () => {
        stopping = true;
        await fixtureWait(
          Promise.allSettled([...originals]),
          5000,
          'STORES_ORIGINAL_RETURN_EXPIRED'
        );
        if (originals.size || failed) throw Error('STORES_ORIGINAL_CUSTODY_UNOBSERVED');
        retainedCalls.delete(owner);
      })();
      return closing;
    },
    snapshot: () => ({ pending: originals.size, failed, issued }),
  });
}
