import { z } from 'zod';

const Result = z
  .object({
    nonce: z.string().uuid(),
    gate: z.enum(['fulfilled', 'rejected']),
    afterRelease: z.enum(['fulfilled', 'rejected']),
  })
  .strict();
/** Ordinary worker event holds a genuine HTTP body, then awaits an original MessagePort release. */
export function originalBackgroundRevocationScript(nonce: string, allowedOrigin: string) {
  z.string().uuid().parse(nonce);
  const origin = new URL(allowedOrigin);
  if (
    origin.protocol !== 'https:' ||
    origin.origin !== allowedOrigin ||
    origin.username ||
    origin.password
  )
    throw new Error('BACKGROUND_REVOCATION_OWNED_ORIGIN_REQUIRED');
  const urls = Object.freeze({
    script: allowedOrigin + '/background-revocation/' + nonce + '.js',
    gate: allowedOrigin + '/background-gate/' + nonce,
    after: allowedOrigin + '/after-revocation/' + nonce + '/background',
  });
  const source = `
self.addEventListener('install',e=>e.waitUntil(self.skipWaiting()));
self.addEventListener('activate',e=>e.waitUntil(self.clients.claim()));
let entered=false;
self.addEventListener('message',event=>{
 if(entered || event.data?.nonce!==${JSON.stringify(nonce)} || event.data?.kind!=='begin' || event.ports.length!==1)return;
 entered=true;
 const port=event.ports[0];
 let released=false,release;
 const originalRelease=new Promise(resolve=>{release=resolve;});
 port.onmessage=e=>{if(!released && e.data?.kind==='release' && e.data?.nonce===${JSON.stringify(nonce)}){released=true;release();}};
 port.start();
 event.waitUntil((async()=>{
  try{
   const response=await fetch(${JSON.stringify(urls.gate)},{cache:'no-store'});
   if(response.status!==200)throw new Error('BACKGROUND_REVOCATION_GATE_STATUS');
   const body=response.arrayBuffer();void body.catch(()=>{});
   port.postMessage({nonce:${JSON.stringify(nonce)},phase:'held',status:200});
   let gate='fulfilled';try{await body;}catch{gate='rejected';}
   port.postMessage({nonce:${JSON.stringify(nonce)},phase:'gate-returned',outcome:gate});
   await originalRelease;
   let afterRelease='fulfilled';
   try{const next=await fetch(${JSON.stringify(urls.after)},{mode:'no-cors',cache:'no-store'});await next.arrayBuffer();}catch{afterRelease='rejected';}
   port.postMessage({nonce:${JSON.stringify(nonce)},phase:'result',gate,afterRelease});
  }catch{port.postMessage({nonce:${JSON.stringify(nonce)},phase:'producer-refused'});}
  finally{port.close();}
 })());
});`;
  return Object.freeze({ urls, source });
}

/** Decode actual worker settlement; native circuit and upstream observations remain independent required proof. */
export function readOriginalBackgroundRevocation(value: unknown, nonce: string) {
  const result = Result.parse(value);
  if (result.nonce !== nonce || result.gate !== 'rejected' || result.afterRelease !== 'rejected')
    throw new Error('BACKGROUND_REVOCATION_NOT_OBSERVED');
  return Object.freeze(result);
}

type BrowserPort = {
  nonce: string;
  registration: ServiceWorkerRegistration;
  port: MessagePort;
  gateReturned: Promise<string>;
  result: Promise<unknown>;
  requireHeld(): true;
  release(): Promise<unknown>;
  stop(): Promise<void>;
};
declare global {
  interface Window {
    __dorkOriginalBackgroundRevocation?: BrowserPort;
  }
}

/** Install ordinary owned worker and retain its actual port/body jobs; no worker protocol evaluation. */
export async function beginOriginalBackgroundRevocation(options: {
  script: string;
  nonce: string;
}) {
  if (window.__dorkOriginalBackgroundRevocation)
    throw new Error('BACKGROUND_REVOCATION_ALREADY_OWNED');
  const channel = new MessageChannel();
  let registration: ServiceWorkerRegistration | undefined;
  let first: { value: unknown } | undefined;
  let published = false;
  try {
    registration = await navigator.serviceWorker.register(options.script, {
      updateViaCache: 'none',
    });
    const worker = registration.active ?? registration.installing ?? registration.waiting;
    if (!worker) throw new Error('BACKGROUND_REVOCATION_WORKER_REQUIRED');
    if (worker.state !== 'activated')
      await new Promise<void>((resolve, reject) => {
        const observe = () => {
          if (worker.state === 'activated' || worker.state === 'redundant') {
            worker.removeEventListener('statechange', observe);
            if (worker.state === 'activated') resolve();
            else reject(new Error('BACKGROUND_REVOCATION_WORKER_REDUNDANT'));
          }
        };
        worker.addEventListener('statechange', observe);
        observe();
      });
    let heldDone!: () => void,
      heldRefuse!: (value: unknown) => void,
      gateDone!: (value: string) => void,
      gateRefuse!: (value: unknown) => void,
      resultDone!: (value: unknown) => void,
      resultRefuse!: (value: unknown) => void;
    const held = new Promise<void>((yes, no) => {
      heldDone = yes;
      heldRefuse = no;
    });
    const gateReturned = new Promise<string>((yes, no) => {
      gateDone = yes;
      gateRefuse = no;
    });
    const result = new Promise<unknown>((yes, no) => {
      resultDone = yes;
      resultRefuse = no;
    });
    for (const job of [held, gateReturned, result]) void job.catch(() => {});
    let stage: 'waiting' | 'held' | 'returned' | 'released' | 'done' = 'waiting';
    const refuse = (value: unknown) => {
      first ??= { value };
      heldRefuse(first.value);
      gateRefuse(first.value);
      resultRefuse(first.value);
    };
    channel.port1.onmessage = (event) => {
      const value: unknown = event.data;
      if (
        !value ||
        typeof value !== 'object' ||
        Array.isArray(value) ||
        !('nonce' in value) ||
        value.nonce !== options.nonce
      )
        return;
      if (!('phase' in value)) {
        refuse(new Error('BACKGROUND_REVOCATION_ORIGINAL_PHASE_REFUSED'));
        return;
      }
      if (
        stage === 'waiting' &&
        value.phase === 'held' &&
        'status' in value &&
        value.status === 200
      ) {
        stage = 'held';
        heldDone();
      } else if (
        stage === 'held' &&
        value.phase === 'gate-returned' &&
        'outcome' in value &&
        (value.outcome === 'fulfilled' || value.outcome === 'rejected')
      ) {
        stage = 'returned';
        gateDone(value.outcome);
      } else if (
        stage === 'released' &&
        value.phase === 'result' &&
        'gate' in value &&
        'afterRelease' in value
      ) {
        stage = 'done';
        resultDone({ nonce: value.nonce, gate: value.gate, afterRelease: value.afterRelease });
      } else refuse(new Error('BACKGROUND_REVOCATION_ORIGINAL_PHASE_REFUSED'));
    };
    channel.port1.onmessageerror = () => refuse(new Error('BACKGROUND_REVOCATION_PORT_REFUSED'));
    channel.port1.start();
    const originalRegistration = registration;
    let stopping: Promise<void> | undefined;
    const owner: BrowserPort = {
      nonce: options.nonce,
      registration: originalRegistration,
      port: channel.port1,
      gateReturned,
      result,
      requireHeld() {
        if (first) throw first.value;
        if (stage !== 'held') throw new Error('BACKGROUND_REVOCATION_BODY_NOT_HELD');
        return true;
      },
      release() {
        if (first) throw first.value;
        if (stage !== 'returned') throw new Error('BACKGROUND_REVOCATION_RELEASE_ORDER');
        stage = 'released';
        channel.port1.postMessage({ nonce: options.nonce, kind: 'release' });
        return result;
      },
      stop() {
        if (stopping) return stopping;
        let done!: () => void, fail!: (value: unknown) => void;
        stopping = new Promise<void>((yes, no) => {
          done = yes;
          fail = no;
        });
        refuse(new Error('BACKGROUND_REVOCATION_PORT_CLOSED'));
        void (async () => {
          let cleanup: { value: unknown } | undefined;
          try {
            await originalRegistration.unregister();
          } catch (value) {
            cleanup = { value };
          }
          for (const port of [channel.port1, channel.port2]) {
            try {
              port.onmessage = null;
              port.onmessageerror = null;
              port.close();
            } catch (value) {
              cleanup ??= { value };
            }
          }
          await Promise.allSettled([held, gateReturned, result]);
          if (window.__dorkOriginalBackgroundRevocation === owner)
            delete window.__dorkOriginalBackgroundRevocation;
          if (cleanup) fail(cleanup.value);
          else done();
        })();
        return stopping;
      },
    };
    window.__dorkOriginalBackgroundRevocation = owner;
    published = true;
    worker.postMessage({ nonce: options.nonce, kind: 'begin' }, [channel.port2]);
    await held;
    return Object.freeze({ nonce: options.nonce, status: 200 });
  } catch (value) {
    const originalFailure = first ?? { value };
    first = originalFailure;
    if (!published) {
      try {
        await registration?.unregister();
      } catch (value) {
        first ??= { value };
      }
      for (const port of [channel.port1, channel.port2])
        try {
          port.close();
        } catch (value) {
          first ??= { value };
        }
    }
    throw originalFailure.value;
  }
}

/** Await the actual held worker body return without granting further network permission. */
export function awaitOriginalBackgroundRevocationBody(nonce: string) {
  const owner = window.__dorkOriginalBackgroundRevocation;
  if (!owner || owner.nonce !== nonce)
    throw new Error('BACKGROUND_REVOCATION_ORIGINAL_PORT_REQUIRED');
  return owner.gateReturned;
}
/** Release original MessagePort work after genuine revocation; worker issues its own ordinary fetch. */
export function releaseOriginalBackgroundRevocation(nonce: string) {
  const owner = window.__dorkOriginalBackgroundRevocation;
  if (!owner || owner.nonce !== nonce)
    throw new Error('BACKGROUND_REVOCATION_ORIGINAL_PORT_REQUIRED');
  return owner.release();
}
/** Independently unregister the exact original worker and join/close its original browser port duties. */
export function closeOriginalBackgroundRevocation(nonce: string) {
  const owner = window.__dorkOriginalBackgroundRevocation;
  if (!owner || owner.nonce !== nonce) return;
  return owner.stop();
}

/** Observe the original port phase immediately before revocation; a previously returned body refuses. */
export function requireOriginalBackgroundRevocationHeld(nonce: string) {
  const owner = window.__dorkOriginalBackgroundRevocation;
  if (!owner || owner.nonce !== nonce)
    throw new Error('BACKGROUND_REVOCATION_ORIGINAL_PORT_REQUIRED');
  return owner.requireHeld();
}
