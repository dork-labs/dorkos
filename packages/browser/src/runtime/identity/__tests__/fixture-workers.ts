import { z } from 'zod';
import { NativeIdentitySchema } from '../native-observation.js';

const workerResult = z
  .object({ identity: NativeIdentitySchema, nested: NativeIdentitySchema.optional() })
  .strict();
/** Nested-child evidence is mandatory for the subject that claims its lifetime. */
export function parseFixtureWorkerResult(subject: string, payload: unknown) {
  return (
    subject === 'nested-parent'
      ? workerResult.extend({ nested: NativeIdentitySchema })
      : workerResult
  ).parse(payload);
}

/** Exact private fixture worker scripts. Portable controls do not certify native identity. */
export function fixtureWorkerScripts(identitySource: string) {
  const failure = `function reportFailure(error){postMessage({error:String(error instanceof Error?error.message:error).slice(0,1024)});}`;
  return {
    dedicated: `${identitySource}\n${failure}
self.onmessage=async()=>{try{postMessage({stage:'message-entered'});await fetch('/worker-fetch?subject=dedicated');postMessage({stage:'fetch-returned'});postMessage({identity:await readIdentity()});}catch(error){reportFailure(error);}};
postMessage({stage:'script-ready'});`,
    child: `${identitySource}\n${failure}
self.onmessage=async()=>{try{await fetch('/worker-fetch?subject=nested-child');postMessage(await readIdentity());}catch(error){reportFailure(error);}};
postMessage({stage:'script-ready'});`,
    nested: `${identitySource}\n${failure}
self.onmessage=async()=>{let child,result,failed=false,primary;
try{postMessage({stage:'message-entered'});child=new Worker('/nested-child.js');
let childTriggered=false;
const returned=new Promise((resolve,reject)=>{child.onmessage=e=>{if(e.data.stage==='script-ready'){if(!childTriggered){childTriggered=true;child.postMessage('observe');}return;}e.data.error?reject(new Error(e.data.error)):resolve(e.data);};child.onerror=e=>reject(new Error(e.message));});
const observedReturned=returned.then(value=>({ok:true,value}),error=>({ok:false,error}));
await fetch('/worker-fetch?subject=nested-parent');postMessage({stage:'fetch-returned'});
const nested=await observedReturned;if(!nested.ok)throw nested.error;
result={identity:await readIdentity(),nested:nested.value};
}catch(error){failed=true;primary=error;}
if(child)try{child.terminate();}catch(error){if(!failed){failed=true;primary=error;}}
if(failed)reportFailure(primary);else postMessage(result);};
postMessage({stage:'script-ready'});`,
    shared: `${identitySource}
self.onconnect=e=>{const port=e.ports[0];port.onmessage=async event=>{try{await fetch('/worker-fetch?subject=shared&phase='+encodeURIComponent(event.data));port.postMessage({identity:await readIdentity()});}catch(error){port.postMessage({error:String(error instanceof Error?error.message:error).slice(0,1024)});}};port.start();};`,
  };
}
/** Retains the actual per-Page connection until explicit close, including timeout/error. */
export const readSharedFixture = `(phase)=>new Promise((resolve,reject)=>{
const worker=globalThis.nativeShared??=new SharedWorker('/shared.js',{name:'identity-shared'});
let settled=false;
const fail=error=>{if(settled)return;settled=true;clearTimeout(timer);try{worker.port.close();}catch(closeError){globalThis.nativeSharedCloseError=String(closeError).slice(0,1024);}reject(error);};
const timer=setTimeout(()=>fail(new Error('SHARED_WORKER_TIMEOUT')),5000);
worker.port.onmessageerror=()=>fail(new Error('SHARED_WORKER_MESSAGE_ERROR'));
worker.onerror=event=>fail(new Error(event.message));
worker.port.onmessage=e=>{if(settled)return;if(e.data.error){fail(new Error(e.data.error));return;}settled=true;clearTimeout(timer);resolve(e.data);};
worker.port.start();worker.port.postMessage(phase);
})`;

/** The trigger waits for a genuine script acknowledgment sent after listener installation. */
export const readFixtureWorker = `(script)=>new Promise((resolve,reject)=>{
 const stages=[];let triggered=false,settled=false;const worker=new Worker(script);
 const fail=error=>{if(settled)return;settled=true;clearTimeout(timer);try{worker.terminate();}catch{}reject(error);};
 const timer=setTimeout(()=>fail(new Error('WORKER_OBSERVATION_TIMEOUT:'+script+':'+stages.join(','))),5000);
 worker.onerror=event=>fail(new Error(event.message));
 worker.onmessage=event=>{if(settled)return;
 if(event.data.stage){if(stages.length<16)stages.push(String(event.data.stage));if(event.data.stage==='script-ready'&&!triggered){triggered=true;worker.postMessage('observe');}return;}
 if(event.data.error){fail(new Error('WORKER_REPORTED_FAILURE:'+script+':'+event.data.error));return;}
 settled=true;clearTimeout(timer);try{worker.terminate();}catch(error){reject(error);return;}resolve({result:event.data,stages});};
})`;
