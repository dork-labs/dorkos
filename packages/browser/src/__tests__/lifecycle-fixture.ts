import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { performance } from 'node:perf_hooks';
import type { EngineConfiguration, ProcessIdentity, ProcessObserver } from '../configuration.js';

const require = createRequire(import.meta.url);
const libraryRoot = dirname(require.resolve('playwright-core/package.json'));

export const requestId = 'request_0123456789abcdef0123456789ab';
export const profileId = 'profile_0123456789abcdef0123456789ab';

function table(): (ProcessIdentity & { ppid: number })[] {
  const text = execFileSync('ps', ['-axo', 'pid=,ppid=,lstart=,stat='], {
    encoding: 'utf8',
    timeout: 2000,
  });
  return text
    .trim()
    .split('\n')
    .flatMap((line) => {
      const match = /^\s*(\d+)\s+(\d+)\s+(.+?)\s+(\S+)\s*$/.exec(line);
      if (!match) throw Error('TEST_OBSERVER_UNAVAILABLE');
      return match[4]!.startsWith('Z')
        ? []
        : [{ pid: Number(match[1]), ppid: Number(match[2]), birth: match[3]! }];
    });
}

export const processes: ProcessObserver = {
  async observe(identity, signal) {
    if (signal.aborted) return { status: 'unknown' };
    return {
      status: table().some((row) => row.pid === identity.pid && row.birth === identity.birth)
        ? 'alive'
        : 'dead',
    };
  },
  async descendants(identity, signal) {
    if (signal.aborted) return { status: 'unknown', identities: [] };
    const rows = table();
    const root = rows.find((row) => row.pid === identity.pid && row.birth === identity.birth);
    if (!root) return { status: 'unknown', identities: [] };
    const owned = [root];
    for (let i = 0; i < owned.length; i++) {
      for (const row of rows)
        if (row.ppid === owned[i]!.pid && !owned.some((id) => id.pid === row.pid)) owned.push(row);
    }
    return { status: 'complete', identities: owned.map(({ pid, birth }) => ({ pid, birth })) };
  },
};

export async function configuration(
  dataDir: string,
  origin: string,
  nativeFixture = false
): Promise<EngineConfiguration> {
  // Standalone explicit fixture configuration must never depend on an app env module.
  // eslint-disable-next-line no-restricted-syntax
  const fixtureEnvironment = process.env;
  const path = nativeFixture
    ? fixtureEnvironment.DORKOS_BROWSER_FIXTURE_EXECUTABLE
    : '/tmp/browser-fixture-not-a-browser';
  if (!path || !path.startsWith('/')) throw Error('FIXTURE_EXECUTABLE_REQUIRED');
  return {
    dataDir,
    runtime: {
      library: {
        package: 'playwright-core',
        version: '1.63.0',
        rootDir: libraryRoot,
        assets: { manifest: 'browsers.json', cli: 'cli.js' },
      },
      executable: {
        path,
        sha256: nativeFixture
          ? createHash('sha256')
              .update(await readFile(path))
              .digest('hex')
          : '0'.repeat(64),
        revision: '1243',
        version: '153.0.8010.12',
        platform: process.platform as 'darwin',
        arch: process.arch as 'arm64',
      },
      identity: { mode: 'native', policyRevision: 0 },
    },
    network: { kind: 'fixture', origin },
    clock: { monotonicNow: () => performance.now(), wallNow: () => Date.now() },
    processes: { ...processes },
    policy: { authorizeAction: async () => 'allowed', verifyBrokerLease: async () => 'unknown' },
  };
}

export async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'browser-engine-fixture-'));
  let seed = false;
  let popup = false;
  let foreign = '';
  let navigation = '';
  let redirect = false;
  let counter = 0;
  let redirects = 0;
  let workerDone = false;
  let imageSource = '';
  const pixels: number[][] = [];
  const reports: { seed: string | null; cookie: string; path: string }[] = [];
  const server = createServer((request, response) => {
    const path = new URL(request.url!, 'http://fixture').pathname;
    if (path === '/frame-source') {
      response.end(imageSource);
      return;
    }
    if (path === '/pixel') {
      let body = '';
      request.on('data', (bytes) => {
        body += bytes;
      });
      request.on('end', () => {
        pixels.push(JSON.parse(body));
        response.end();
      });
      return;
    }
    if (path === '/tick') {
      counter++;
      response.end();
      return;
    }
    if (path === '/worker-done') {
      workerDone = true;
      response.end();
      return;
    }
    if (path === '/command') {
      response.end(navigation);
      return;
    }
    if (path === '/report') {
      let body = '';
      request.on('data', (bytes) => {
        body += bytes;
      });
      request.on('end', () => {
        reports.push(JSON.parse(body));
        response.end();
      });
      return;
    }
    if (path === '/redirect' || (path === '/' && redirect)) {
      redirects++;
      response.writeHead(302, { location: foreign });
      response.end();
      return;
    }
    if (path === '/worker.js') {
      response.setHeader('Content-Type', 'application/javascript');
      response.end(
        `oninstall=()=>self.skipWaiting();onactivate=e=>e.waitUntil(clients.claim());onmessage=async e=>{try{await fetch(${JSON.stringify(foreign)});}catch{}e.ports[0].postMessage('done')}`
      );
      return;
    }
    response.setHeader('Content-Type', 'text/html');
    const main = path !== '/popup';
    response.end(`<!doctype html><style>body{margin:0;background:${main ? '#d02020' : '#2030d0'};color:white;font:32px sans-serif}</style>${main ? 'CANONICAL-A' : 'POPUP-B'}<script>
      (async()=>{
        const source=await(await fetch('/frame-source')).text();if(source){const image=new Image();image.src=source;await image.decode();const canvas=document.createElement('canvas');canvas.width=image.width;canvas.height=image.height;const ctx=canvas.getContext('2d');ctx.drawImage(image,0,0);await fetch('/pixel',{method:'POST',body:JSON.stringify(Array.from(ctx.getImageData(100,100,1,1).data))});}
        ${seed && path === '/' ? "localStorage.setItem('seed','retained-A');document.cookie='seed=retained-A;Max-Age=3600;Path=/'" : ''}
        await fetch('/report',{method:'POST',body:JSON.stringify({seed:localStorage.getItem('seed'),cookie:document.cookie,path:location.pathname})});
        ${popup && path === '/' ? "window.open('/popup')" : ''}
        ${foreign && path === '/' ? `fetch(${JSON.stringify(foreign)}).catch(()=>{});window.open(${JSON.stringify(foreign)});const frame=document.createElement('iframe');frame.src='/redirect';document.body.append(frame); const r=await navigator.serviceWorker.register('/worker.js');await navigator.serviceWorker.ready;const c=new MessageChannel();const done=new Promise(resolve=>c.port1.onmessage=resolve);r.active.postMessage('probe',[c.port2]);await done;await fetch('/worker-done');` : ''}
        ${path === '/' ? "setInterval(async()=>{await fetch('/tick');const target=await(await fetch('/command')).text();if(target)location.href=target},50)" : ''}
      })();</script>`);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw Error('NO_FIXTURE_ADDRESS');
  return {
    root,
    pixels,
    origin: `http://127.0.0.1:${address.port}`,
    reports,
    get redirects() {
      return redirects;
    },
    get counter() {
      return counter;
    },
    get workerDone() {
      return workerDone;
    },
    configure(value: {
      seed?: boolean;
      popup?: boolean;
      foreign?: string;
      navigation?: string;
      redirect?: boolean;
      imageSource?: string;
    }) {
      if (value.imageSource !== undefined) imageSource = value.imageSource;
      if (value.seed !== undefined) seed = value.seed;
      if (value.popup !== undefined) popup = value.popup;
      if (value.foreign !== undefined) foreign = value.foreign;
      if (value.navigation !== undefined) navigation = value.navigation;
      if (value.redirect !== undefined) redirect = value.redirect;
    },
    async close(removeRoot = true) {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      if (removeRoot) await rm(root, { recursive: true });
    },
  };
}
