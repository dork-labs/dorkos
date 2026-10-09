import https from 'node:https';
import type { MatrixRequest } from './fixture-original-matrix.js';
const retained = new Set<object>();
const hints =
  'Sec-CH-UA, Sec-CH-UA-Mobile, Sec-CH-UA-Platform, Sec-CH-UA-Full-Version-List, Sec-CH-UA-Arch, Sec-CH-UA-Bitness, Sec-CH-UA-Model, Sec-CH-UA-Platform-Version, Sec-CH-UA-WoW64, Sec-CH-UA-Form-Factors';
const fixedSubjects = new Set([
  'page',
  'reload',
  'popup',
  'oopif',
  'dedicated',
  'shared',
  'service',
]);
const nativeReader = `async function readOriginalIdentity(){const data=navigator.userAgentData;
return {userAgent:navigator.userAgent,appVersion:navigator.appVersion,platform:navigator.platform,secureContext:self.isSecureContext,
metadata:data?{...data.toJSON(),...await data.getHighEntropyValues(['architecture','bitness','fullVersionList','model','platformVersion','uaFullVersion','wow64','formFactors'])}:null};}`;
const observe = `${nativeReader}
async function observeOriginal(subject){const initial=await readOriginalIdentity();
const first=await fetch('/identity/request?subject='+subject+'&stage=initial');if(!first.ok)throw new Error('MATRIX_INITIAL_REQUEST_REFUSED');await first.arrayBuffer();
const next=await fetch('/identity/request?subject='+subject+'&stage=negotiated');if(!next.ok)throw new Error('MATRIX_NEGOTIATED_REQUEST_REFUSED');await next.arrayBuffer();
return [{subject,stage:'initial',identity:initial},{subject,stage:'negotiated',identity:await readOriginalIdentity()}];}`;
function document(subject: 'page' | 'popup' | 'oopif', alpha: string, beta: string) {
  const own =
    subject === 'page'
      ? `(performance.getEntriesByType('navigation')[0]?.type==='reload'?'reload':'page')`
      : JSON.stringify(subject);
  return `<!doctype html><meta charset="utf-8"><script>${observe}
globalThis.matrixOwnResult=observeOriginal(${own});globalThis.matrixOwnResult.catch(()=>{});
${subject === 'oopif' ? `globalThis.matrixOwnResult.then(values=>parent.postMessage({kind:'matrix-iframe',values},${JSON.stringify(alpha)}),()=>parent.postMessage({kind:'matrix-iframe',error:true},${JSON.stringify(alpha)}));` : ''}
${
  subject !== 'page'
    ? ''
    : `
globalThis.matrixOpenPopup=()=>{if(!window.open(${JSON.stringify(alpha + '/identity/popup')}))throw new Error('MATRIX_POPUP_REFUSED');};
globalThis.matrixRunWorkers=async()=>{
let dedicated,shared,registration,frame;let failure,values;
try{
const iframe=new Promise((resolve,reject)=>{frame=document.createElement('iframe');frame.src=${JSON.stringify(beta + '/identity/oopif')};
const receive=event=>{if(event.origin!==${JSON.stringify(beta)}||event.source!==frame.contentWindow||event.data?.kind!=='matrix-iframe')return;
window.removeEventListener('message',receive);event.data.error?reject(new Error('MATRIX_IFRAME_REFUSED')):resolve(event.data.values);};window.addEventListener('message',receive);document.body.append(frame);});
dedicated=new Worker('/identity/dedicated.js');const dedicatedResult=new Promise((resolve,reject)=>{dedicated.onmessage=e=>e.data.error?reject(new Error('MATRIX_DEDICATED_REFUSED')):resolve(e.data.values);dedicated.onerror=()=>reject(new Error('MATRIX_DEDICATED_REFUSED'));});
shared=new SharedWorker('/identity/shared.js',{name:'original-chrome-matrix'});const sharedResult=new Promise((resolve,reject)=>{shared.port.onmessage=e=>e.data.error?reject(new Error('MATRIX_SHARED_REFUSED')):resolve(e.data.values);shared.onerror=()=>reject(new Error('MATRIX_SHARED_REFUSED'));shared.port.start();shared.port.postMessage('observe');});
const service=(async()=>{registration=await navigator.serviceWorker.register('/identity/service.js',{scope:'/identity/service-scope/'});
const worker=registration.installing||registration.waiting||registration.active;if(!worker)throw new Error('MATRIX_SERVICE_REFUSED');
if(worker.state!=='activated')await new Promise((resolve,reject)=>{const state=()=>{if(worker.state==='activated'){worker.removeEventListener('statechange',state);resolve();}else if(worker.state==='redundant'){worker.removeEventListener('statechange',state);reject(new Error('MATRIX_SERVICE_REFUSED'));}};worker.addEventListener('statechange',state);state();});
const channel=new MessageChannel();try{return await new Promise((resolve,reject)=>{channel.port1.onmessage=e=>e.data.error?reject(new Error('MATRIX_SERVICE_REFUSED')):resolve(e.data.values);channel.port1.start();worker.postMessage('observe',[channel.port2]);});}finally{channel.port1.close();channel.port2.close();}})();
const results=await Promise.allSettled([iframe,dedicatedResult,sharedResult,service]);for(const result of results)if(result.status==='rejected'&&!failure)failure={value:result.reason};
if(failure)throw failure.value;values=results.flatMap(result=>result.value);
}catch(value){failure??={value};}
for(const close of [()=>dedicated?.terminate(),()=>shared?.port.close(),()=>frame?.remove(),()=>registration?.unregister()])try{await close();}catch(value){failure??={value};}
if(failure)throw failure.value;return values;};`
}
</script><body>Original Chrome identity fixture</body>`;
}
function worker(kind: 'dedicated' | 'shared' | 'service') {
  const start = `${observe}\nconst original=observeOriginal('${kind}');original.catch(()=>{});`;
  if (kind === 'dedicated')
    return `${start}\noriginal.then(values=>postMessage({values}),()=>postMessage({error:true}));`;
  if (kind === 'shared')
    return `${start}\nself.onconnect=e=>{const port=e.ports[0];port.onmessage=()=>{original.then(values=>port.postMessage({values}),()=>port.postMessage({error:true}));};port.start();};`;
  return `${start}\nself.addEventListener('install',e=>e.waitUntil(original.then(()=>self.skipWaiting())));
self.addEventListener('activate',e=>e.waitUntil(self.clients.claim()));self.addEventListener('message',e=>{const port=e.ports[0];e.waitUntil(original.then(values=>port.postMessage({values}),()=>port.postMessage({error:true})));});`;
}

/** Genuine original Node TLS endpoint. No transport callback can stand in for HTTPS observations.
 * Records fixed UA/hint headers only; serves immutable scripts that read original APIs at entry.
 * No JS/response-header identity rewriting; Accept-CH is the actual negotiation mechanism.
 */
export function createFixtureOriginalMatrixServer(key: Buffer, cert: Buffer) {
  let closed = false,
    first: Readonly<{ value: unknown }> | undefined,
    port = 0,
    pageRequests = 0;
  let starting: Promise<number> | undefined,
    closing: Promise<void> | undefined,
    listenEntered = false;
  const replies = new Set<Promise<void>>(),
    requests: MatrixRequest[] = [];
  const failure = (value: unknown) => {
    first ??= { value };
  };
  const localClosed = new Error('CHROME_MATRIX_SERVER_CLOSED');
  const server = https.createServer({ key, cert }, (req, res) => {
    let resolve!: () => void, reject!: (value: unknown) => void;
    const original = new Promise<void>((yes, no) => {
      resolve = yes;
      reject = no;
    });
    replies.add(original);
    void original.then(
      () => replies.delete(original),
      (value) => {
        failure(value);
        replies.delete(original);
      }
    );
    res.once('error', reject);
    res.once('close', () => {
      if (!res.writableFinished) reject(new Error('CHROME_MATRIX_ORIGINAL_RESPONSE_UNRETURNED'));
    });
    const end = res.end.bind(res);
    try {
      if (closed) throw localClosed;
      const host = req.headers.host?.split(':')[0],
        path = new URL(req.url ?? '', 'https://identity-alpha.test');
      if (
        !['identity-alpha.test', 'identity-beta.test'].includes(host ?? '') ||
        requests.length >= 128
      )
        throw new Error('CHROME_MATRIX_REQUEST_REFUSED');
      const alpha = `https://identity-alpha.test:${port}`,
        beta = `https://identity-beta.test:${port}`;
      const headers = Object.fromEntries(
        Object.entries(req.headers).filter(
          ([name, value]) =>
            typeof value === 'string' && (name === 'user-agent' || name.startsWith('sec-ch-ua'))
        )
      ) as Record<string, string>;
      let subject: MatrixRequest['subject'] | undefined,
        stage: MatrixRequest['stage'] = 'first',
        body = '',
        type = 'text/html';
      if (path.pathname === '/baseline')
        body = '<!doctype html><meta charset="utf-8"><body>Original native baseline</body>';
      else if (path.pathname === '/identity/page') {
        subject = pageRequests++ === 0 ? 'page' : 'reload';
        body = document('page', alpha, beta);
      } else if (path.pathname === '/identity/popup') {
        subject = 'popup';
        body = document('popup', alpha, beta);
      } else if (path.pathname === '/identity/oopif') {
        subject = 'oopif';
        body = document('oopif', alpha, beta);
      } else if (/^\/identity\/(dedicated|shared|service)\.js$/u.test(path.pathname)) {
        subject = path.pathname.split('/').at(-1)!.slice(0, -3) as
          'dedicated' | 'shared' | 'service';
        body = worker(subject);
        type = 'text/javascript';
      } else if (path.pathname === '/identity/request') {
        const parsedSubject = path.searchParams.get('subject'),
          parsedStage = path.searchParams.get('stage');
        if (
          !fixedSubjects.has(parsedSubject ?? '') ||
          !['initial', 'negotiated'].includes(parsedStage ?? '')
        )
          throw new Error('CHROME_MATRIX_REQUEST_REFUSED');
        subject = parsedSubject as MatrixRequest['subject'];
        stage = parsedStage as 'initial' | 'negotiated';
        body = 'Original HTTPS return';
        type = 'text/plain';
      } else {
        res.statusCode = 404;
        body = 'Fixture resource not found';
      }
      if (subject)
        requests.push(Object.freeze({ subject, stage, headers: Object.freeze(headers) }));
      res.setHeader('Content-Type', type);
      res.setHeader('Cache-Control', 'no-store');
      res.setHeader('Accept-CH', hints);
      res.setHeader('Service-Worker-Allowed', '/identity/');
      end(body, resolve);
    } catch (value) {
      if (value !== localClosed) failure(value);
      try {
        res.destroy();
      } catch (cause) {
        failure(cause);
      }
      reject(value);
    }
  });
  const listen = server.listen.bind(server),
    stop = server.close.bind(server),
    stopConnections = server.closeAllConnections.bind(server);
  const owner = {
    listen(): Promise<number> {
      if (starting) return starting;
      starting = Promise.resolve().then(
        () =>
          new Promise<number>((resolve, reject) => {
            if (closed) {
              reject(localClosed);
              return;
            }
            const error = (value: unknown) => {
              server.off('listening', ready);
              server.off('close', gone);
              reject(value);
            };
            const gone = () => error(localClosed);
            const ready = () => {
              server.off('error', error);
              server.off('close', gone);
              const address = server.address();
              if (!address || typeof address === 'string') {
                reject(new Error('CHROME_MATRIX_LISTENER_UNKNOWN'));
                return;
              }
              port = address.port;
              resolve(port);
            };
            server.once('error', error);
            server.once('close', gone);
            server.once('listening', ready);
            try {
              listenEntered = true;
              listen(0, '127.0.0.1');
            } catch (value) {
              server.off('error', error);
              error(value);
            }
          })
      );
      void starting.catch((value) => {
        if (value !== localClosed) failure(value);
      });
      return starting;
    },
    requests() {
      return requests.map((value) =>
        Object.freeze({ ...value, headers: Object.freeze({ ...value.headers }) })
      );
    },
    close(): Promise<void> {
      closed = true;
      return (closing ??= Promise.resolve().then(async () => {
        // Enter original socket stop before waiting for any retained response/listen duty.
        try {
          stopConnections();
        } catch (value) {
          failure(value);
        }
        const returned = listenEntered
          ? new Promise<void>((resolve, reject) => {
              try {
                stop((value) => (value == null ? resolve() : reject(value)));
              } catch (value) {
                reject(value);
              }
            })
          : Promise.resolve();
        const results = await Promise.allSettled([
          returned,
          ...(starting ? [starting] : []),
          ...replies,
        ]);
        for (const result of results)
          if (result.status === 'rejected' && result.reason !== localClosed) failure(result.reason);
        if (first) throw first.value;
        retained.delete(owner);
      }));
    },
  };
  retained.add(owner);
  return Object.freeze(owner);
}
