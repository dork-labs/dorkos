import { mkdtemp, realpath, lstat, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import type { Socket } from 'node:net';
import { WebSocketServer } from 'ws';
import { BrokerError } from '../errors.js';
import { writeSync } from 'node:fs';

/** Match the private closed failure class/data code, never arbitrary message or getters. */
export function isTargetAuthorityRefusal(error: unknown): boolean {
  try {
    if (!(error instanceof BrokerError)) return false;
    const code = Object.getOwnPropertyDescriptor(error, 'code');
    return code !== undefined && 'value' in code && code.value === 'AUTHORITY_REFUSED';
  } catch {
    return false;
  }
}

/** A synchronous bounded receipt has no unsettled output promise to lose on success. */
export function writeTargetReceipt(raw: string, descriptor = 1): void {
  const line = Buffer.from('TARGET_EGRESS_RECEIPT ' + raw + '\n');
  if (line.byteLength > 4096) throw Error('TARGET_RECEIPT_CAP');
  if (writeSync(descriptor, line) !== line.byteLength) throw Error('TARGET_RECEIPT_PARTIAL');
}

/** Attempt the bounded scalar receipt without replacing an earlier cleanup failure. */
export function finishTargetReceipt(
  primary: { present: boolean; value: unknown },
  receipt?: () => object,
  emit: (raw: string) => void = writeTargetReceipt
): void {
  let failed = primary.present;
  let first = primary.value;
  try {
    if (receipt) {
      const raw = JSON.stringify(receipt());
      if (Buffer.byteLength(raw) > 4096) throw Error('TARGET_RECEIPT_CAP');
      emit(raw);
    }
  } catch (error) {
    if (!failed) first = error;
    failed = true;
  }
  if (failed) throw first;
}

const retained = new Set<object>();
/** Waiting classifiers never replace or release an unsettled original operation. */
export function ownTargetOperations() {
  const originals = new Set<Promise<unknown>>();
  const owner = { originals };
  retained.add(owner);
  let failed = false,
    stopping = false,
    attempts = 0;
  return {
    async run<T>(invoke: () => Promise<T>, milliseconds = 5000): Promise<T> {
      if (stopping || originals.size >= 8 || attempts++ >= 256) throw Error('TARGET_DUTY_CAPACITY');
      const original = Promise.resolve().then(invoke);
      originals.add(original); // Before invoking the original SDK/socket operation.
      void original.then(
        () => originals.delete(original),
        () => {
          originals.delete(original);
          failed = true;
        }
      );
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        return await Promise.race([
          original,
          new Promise<never>((_, reject) => {
            timer = setTimeout(() => {
              failed = true;
              reject(Error('TARGET_DUTY_EXPIRED'));
            }, milliseconds);
          }),
        ]);
      } finally {
        if (timer) clearTimeout(timer);
      }
    },
    snapshot() {
      return { observed: !failed && originals.size === 0, pending: originals.size, failed };
    },
    finish() {
      stopping = true;
      const observed = !failed && originals.size === 0;
      if (observed) retained.delete(owner);
      return { observed, pending: originals.size, failed };
    },
  };
}
/** Directory ownership exists before its producer enters; caller timeout does not lose its path. */
export function ownTargetHome(
  prefix: string,
  canonical: (path: string) => Promise<string> = realpath
) {
  const owner: {
    named?: string;
    canonical?: string;
    identity?: { dev: bigint; ino: bigint };
    acquisition?: Promise<string>;
    creation?: Promise<string>;
    canonicalization?: Promise<string>;
    removeOriginal?: Promise<void>;
    removal?: Promise<void>;
    failed: boolean;
    settled: boolean;
  } = { failed: false, settled: false };
  retained.add(owner);
  const acquire = () =>
    (owner.acquisition ??= Promise.resolve().then(async () => {
      try {
        owner.creation = mkdtemp(prefix);
        owner.named = await owner.creation; // Preserve actual named directory before any later call.
        const stat = await lstat(owner.named, { bigint: true });
        if (!stat.isDirectory() || stat.isSymbolicLink()) throw Error('TARGET_HOME_UNKNOWN');
        owner.identity = { dev: stat.dev, ino: stat.ino };
        owner.canonicalization = canonical(owner.named);
        owner.canonical = await owner.canonicalization;
        owner.settled = true;
        return owner.canonical;
      } catch (error) {
        owner.failed = true;
        owner.settled = true;
        throw error;
      }
    }));
  return {
    acquire,
    snapshot: () => ({
      named: owner.named,
      canonical: owner.canonical,
      settled: owner.settled,
      failed: owner.failed,
    }),
    removeIfObserved(observed: boolean) {
      if (!observed || owner.failed || !owner.settled || !owner.named || !owner.identity)
        return Promise.resolve(false);
      const named = owner.named,
        identity = owner.identity;
      owner.removal ??= Promise.resolve().then(async () => {
        const current = await lstat(named, { bigint: true });
        if (!current.isDirectory() || current.dev !== identity.dev || current.ino !== identity.ino)
          throw Error('TARGET_HOME_REPLACED');
        owner.removeOriginal = rm(named, { recursive: true, force: false });
        await owner.removeOriginal;
        retained.delete(owner);
      });
      return owner.removal.then(() => true);
    },
  };
}
export type TargetReport = {
  dedicated: boolean;
  shared: boolean;
  service: boolean;
  cache: boolean;
  websocket: boolean;
};
export function assertTargetReport(value: unknown): asserts value is TargetReport {
  if (
    !value ||
    typeof value !== 'object' ||
    Object.keys(value).length !== 5 ||
    !['dedicated', 'shared', 'service', 'cache', 'websocket'].every(
      (key) => Reflect.get(value, key) === true
    )
  )
    throw Error('TARGET_MATRIX_INCOMPLETE');
}

/** Wait on the exact WebSocket; opening/echo failure settles instead of silently hanging. */
export function waitTargetSocketEvent(
  original: {
    addEventListener(
      type: 'open' | 'message' | 'error' | 'close',
      listener: (event: unknown) => void,
      options?: { once?: boolean }
    ): void;
    removeEventListener(
      type: 'open' | 'message' | 'error' | 'close',
      listener: (event: unknown) => void
    ): void;
  },
  type: 'open' | 'message'
): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const cleanup = () => {
      original.removeEventListener(type, success);
      original.removeEventListener('error', failure);
      original.removeEventListener('close', failure);
    };
    const success = (event: unknown) => {
      cleanup();
      resolve(event);
    };
    const failure = () => {
      cleanup();
      reject(Error('TARGET_WEBSOCKET_FAILED'));
    };
    original.addEventListener(type, success, { once: true });
    original.addEventListener('error', failure, { once: true });
    original.addEventListener('close', failure, { once: true });
  });
}

/** Original listener/socket owners, capped counters and scalar reports only. */
export function createTargetOrigin(forbidden: string) {
  const sockets = new Set<Socket>(); // Aggregate acquired originals, including refused native deliveries.
  const slots: Array<Socket | null> = Array.from({ length: 64 }, () => null);
  let listenerStop: Promise<void> | undefined;
  const stopIntake = () =>
    (listenerStop ??= new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve()))
    ));
  const refuseAll = () => {
    overflow = true;
    void stopIntake().catch(() => {});
    for (const original of sockets) {
      try {
        original.destroy();
      } catch {
        /* Retain original; close is still required. */
      }
    }
  };
  let connections = 0,
    leaks = 0,
    messages = 0,
    cacheRequests = 0,
    upgrades = 0,
    websocketConnections = 0,
    overflow = false;
  const counts = new Map<string, number>();
  let reportPhase: string | null = null;
  let reportResolve!: (value: unknown) => void;
  const report = new Promise<unknown>((resolve) => {
    reportResolve = resolve;
  });
  let probeResolve!: () => void;
  const probe = new Promise<void>((resolve) => {
    probeResolve = resolve;
  });
  const server = createServer((request, response) => {
    if (overflow) {
      request.destroy();
      return;
    }
    const path = (request.url ?? '').split('?')[0]!;
    if (counts.size >= 32 && !counts.has(path)) {
      refuseAll();
      request.destroy();
      return;
    }
    counts.set(path, (counts.get(path) ?? 0) + 1);
    if (request.headers.authorization || request.headers['proxy-authorization']) leaks++;
    response.setHeader('cache-control', 'no-store');
    if (path === '/report') {
      const fields = new URL(request.url!, 'http://127.0.0.1').searchParams;
      const phase = fields.get('phase');
      if (
        [
          'workers',
          'cache-first',
          'cache-second',
          'ws-open',
          'ws-echo',
          'shared-background',
          'report',
        ].includes(phase ?? '')
      )
        reportPhase = phase;
      reportResolve(
        Object.fromEntries(
          ['dedicated', 'shared', 'service', 'cache', 'websocket'].map((key) => [
            key,
            fields.get(key) === 'true',
          ])
        )
      );
      response.end('reported');
      return;
    }
    if (path === '/after') probeResolve();
    if (path === '/cache') {
      cacheRequests++;
      response.setHeader('cache-control', 'public,max-age=3600');
      response.end('CACHE');
      return;
    }
    if (path === '/worker.js') {
      response.setHeader('content-type', 'text/javascript');
      response.end("fetch('/dedicated').then(()=>postMessage(true))");
      return;
    }
    if (path === '/shared.js') {
      response.setHeader('content-type', 'text/javascript');
      response.end(
        "onconnect=e=>{const p=e.ports[0];fetch('/shared').then(()=>p.postMessage(true));p.onmessage=()=>fetch('/shared-background').then(()=>p.postMessage(true))}"
      );
      return;
    }
    if (path === '/sw.js') {
      response.setHeader('content-type', 'text/javascript');
      response.end(
        "self.addEventListener('install',e=>e.waitUntil(fetch('/sw-install').then(()=>self.skipWaiting())));self.addEventListener('activate',e=>e.waitUntil(self.clients.claim()));self.addEventListener('message',e=>e.waitUntil(fetch('/sw-background').then(()=>e.ports[0].postMessage(true))))"
      );
      return;
    }
    if (path === '/script.js') {
      response.setHeader('content-type', 'text/javascript');
      response.end('window.fixtureScript=true');
      return;
    }
    if (path === '/pixel') {
      response.setHeader('content-type', 'image/svg+xml');
      response.end('<svg xmlns="http://www.w3.org/2000/svg" width="1" height="1"/>');
      return;
    }
    if (path === '/frame') {
      response.end('<title>Child frame</title>');
      return;
    }
    if (path !== '/') {
      response.end('OK');
      return;
    }
    response.setHeader('content-type', 'text/html');
    response.end(`<link rel="icon" href="data:,"><script src="/script.js"></script><img src="/pixel"><iframe src="/frame"></iframe><button style="position:fixed;left:40px;top:40px;width:200px;height:80px" onclick="setInterval(()=>fetch('/after',{cache:'no-store'}).catch(()=>{}),80)">Probe</button><script>
let phase='workers';const waitSocket=${waitTargetSocketEvent.toString()};
(async()=>{const once=(o,k)=>new Promise(r=>o.addEventListener(k,r,{once:true}));
const w=new Worker('/worker.js');await once(w,'message');w.terminate();
const shared=new SharedWorker('/shared.js');shared.port.start();await once(shared.port,'message');
await navigator.serviceWorker.register('/sw.js');await navigator.serviceWorker.ready;
if(!navigator.serviceWorker.controller) await once(navigator.serviceWorker,'controllerchange');
const channel=new MessageChannel();const serviceReply=once(channel.port1,'message');channel.port1.start();navigator.serviceWorker.controller.postMessage('background',[channel.port2]);await serviceReply;channel.port1.close();
phase='cache-first';const a=await fetch('/cache').then(r=>r.text());phase='cache-second';const b=await fetch('/cache').then(r=>r.text());
phase='ws-open';const ws=new WebSocket(location.origin.replace('http:','ws:')+'/socket');await waitSocket(ws,'open');phase='ws-echo';const echo=waitSocket(ws,'message');ws.send('BOUND');if((await echo).data!=='BOUND')throw Error('WS_ECHO_INVALID');
setInterval(()=>{if(ws.readyState===1)ws.send('BOUND')},80);
await fetch(${JSON.stringify(forbidden)}).catch(()=>{});
phase='shared-background';const background=once(shared.port,'message');shared.port.postMessage('background');await background;shared.port.close();
phase='report';await fetch('/report?phase=report&dedicated=true&shared=true&service=true&cache='+(a==='CACHE'&&b==='CACHE')+'&websocket=true');
})().catch(()=>fetch('/report?failed=true&phase='+phase));</script>`);
  });
  const listenerOwner = { server, sockets };
  retained.add(listenerOwner);
  server.on('connection', (socket) => {
    sockets.add(socket); // Capture every actual delivered original before fallible callbacks.
    connections++;
    const slot = slots.indexOf(null);
    socket.once('close', () => {
      sockets.delete(socket);
      if (slot >= 0 && slots[slot] === socket) slots[slot] = null;
    });
    socket.on('error', refuseAll);
    if (overflow || slot < 0) {
      refuseAll();
      return;
    }
    slots[slot] = socket;
  });
  server.on('error', refuseAll);
  const websocket = new WebSocketServer({ noServer: true, maxPayload: 1024 });
  server.on('upgrade', (request, socket, head) => {
    upgrades++;
    if (overflow || !slots.includes(socket as Socket)) {
      socket.destroy();
      return;
    }
    try {
      websocket.handleUpgrade(request, socket, head, (original) =>
        websocket.emit('connection', original, request)
      );
    } catch {
      refuseAll();
    }
  });
  websocket.on('connection', (socket, request) => {
    websocketConnections++;
    socket.on('error', refuseAll);
    if (overflow) {
      socket.close();
      return;
    }
    if (request.headers.authorization || request.headers['proxy-authorization']) leaks++;
    socket.on('message', (bytes) => {
      if (overflow || bytes.toString() !== 'BOUND') {
        refuseAll();
        socket.close();
        return;
      }
      messages++;
      socket.send('BOUND'); // Exact validated text must remain a text frame for the browser oracle.
    });
  });
  let originalClose: Promise<void> | undefined;
  return {
    server,
    report,
    probe,
    transportBarrier: async () => {
      for (let pass = 0; pass < 64 && sockets.size; pass++) {
        const originals = [...sockets];
        await Promise.all(
          originals.map(
            (original) => new Promise<void>((resolve) => original.once('close', resolve))
          )
        );
      }
      if (sockets.size) throw Error('TARGET_ORIGINALS_NOT_RETURNED');
    },
    snapshot: () => ({
      connections,
      leaks,
      messages,
      cacheRequests,
      upgrades,
      websocketConnections,
      reportPhase,
      overflow,
      admitted: slots.filter(Boolean).length,
      counts: Object.fromEntries(counts),
    }),
    close: () =>
      (originalClose ??= Promise.resolve().then(async () => {
        const socketCloses = [...sockets].map(
          (socket) => new Promise<void>((resolve) => socket.once('close', resolve))
        );
        const wsClose = new Promise<void>((resolve, reject) =>
          websocket.close((error) => (error ? reject(error) : resolve()))
        );
        const listenerClose = stopIntake();
        let failed = false;
        let first: unknown;
        for (const socket of sockets) {
          try {
            socket.destroy();
          } catch (error) {
            if (!failed) first = error;
            failed = true;
          }
        }
        const closures = await Promise.allSettled([wsClose, listenerClose, ...socketCloses]);
        for (const result of closures) {
          if (result.status === 'rejected') {
            if (!failed) first = result.reason;
            failed = true;
          }
        }
        if (failed) throw first;
        if (sockets.size) throw Error('TARGET_SOCKETS_HELD');
        if (overflow) throw Error('TARGET_ORIGIN_REFUSED');
        retained.delete(listenerOwner);
      })),
  };
}
