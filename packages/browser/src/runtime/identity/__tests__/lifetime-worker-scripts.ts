import { z } from 'zod';
import { NativeIdentitySchema } from '../native-observation.js';

/** Actual worker data never borrows identity metadata from its owning Page. */
export const LifetimeWorkerObservationSchema = z
  .object({
    kind: z.enum(['shared', 'service']),
    instance: z.string().uuid(),
    version: z.number().int().min(1).max(2),
    phase: z.enum(['observe', 'after-detach']),
    unavailableApis: z.array(z.string().max(128)).max(4),
    identity: NativeIdentitySchema,
  })
  .strict();

export const lifetimeIdentitySource = `const nativeUnavailableApis=new Set();
async function readIdentity(){
 const data=navigator.userAgentData;
 if(!data)nativeUnavailableApis.add('navigator.userAgentData');
 else if(typeof data.getHighEntropyValues!=='function')nativeUnavailableApis.add('userAgentData.getHighEntropyValues');
 const low=data&&typeof data.toJSON==='function'?data.toJSON():null;let high={};
 if(data&&typeof data.getHighEntropyValues==='function')try{high=await data.getHighEntropyValues([
 'architecture','bitness','fullVersionList','model','platformVersion','uaFullVersion','wow64','formFactors']);}catch{nativeUnavailableApis.add('userAgentData.highEntropy:rejected');}
 const metadata=low?{...low,...high}:null;
 return {userAgent:navigator.userAgent,appVersion:navigator.appVersion,platform:navigator.platform,
 secureContext:self.isSecureContext,metadata};
}`;
/** Gate receipt occurs before detach; fetch resumes only when the owned server releases it. */
export function lifetimeWorkerScripts(version: 1 | 2) {
  const common = `${lifetimeIdentitySource}
const instance=crypto.randomUUID(),version=${version};
async function observation(kind,phase){return {kind,instance,version,phase,identity:await readIdentity(),unavailableApis:[...nativeUnavailableApis]};}
async function afterDetach(kind){
 const gate=await fetch('/gate?kind='+kind+'&instance='+instance);await gate.text();
 const response=await fetch('/after-detach?kind='+kind+'&instance='+instance,{
 method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(await observation(kind,'after-detach'))});
 await response.text();
}
function failure(port,error){port.postMessage({error:String(error instanceof Error?error.message:error).slice(0,1024)});}`;
  return {
    shared: `${common}
let connections=0;
self.onconnect=event=>{const port=event.ports[0];
 if(++connections>8){failure(port,new Error('SHARED_CONNECTION_CAP'));port.close();return;}
 port.onmessage=async event=>{try{
 if(event.data==='arm'){const original=afterDetach('shared');original.catch(()=>{});port.postMessage({armed:true,instance});await original;}
 else port.postMessage(await observation('shared','observe'));
 }catch(error){failure(port,error);}};port.start();};`,
    service: `${common}
self.addEventListener('install',event=>event.waitUntil(self.skipWaiting()));
self.addEventListener('activate',event=>event.waitUntil(self.clients.claim()));
self.addEventListener('message',event=>{const port=event.ports[0];
 const original=(async()=>{if(event.data==='arm'){
 const pending=afterDetach('service');pending.catch(()=>{});port.postMessage({armed:true,instance});await pending;
 }else port.postMessage(await observation('service','observe'));})();
 event.waitUntil(original.catch(error=>failure(port,error)));
});`,
  };
}

/** A Page owns its exact shared port through success, timeout and explicit detach cleanup. */
export const lifetimeSharedRequest = `(command)=>new Promise((resolve,reject)=>{
 const worker=globalThis.lifetimeShared??=new SharedWorker('/shared.js',{name:'native-lifetime'});
 const port=worker.port;let settled=false;
 const finish=(error,value)=>{if(settled)return;settled=true;clearTimeout(timer);port.onmessage=null;port.onmessageerror=null;worker.onerror=null;if(error)reject(error);else resolve(value);};
 const timer=setTimeout(()=>finish(new Error('SHARED_RESPONSE_EXPIRED')),3000);
 port.onmessage=e=>e.data.error?finish(new Error(e.data.error)):finish(null,e.data);
 port.onmessageerror=()=>finish(new Error('SHARED_MESSAGE_ERROR'));worker.onerror=e=>finish(new Error(e.message));
 port.start();port.postMessage(command);
})`;
/** MessageChannel originals close on every return, including rejected ready and late messages. */
export const lifetimeServiceRequest = `(command)=>new Promise((resolve,reject)=>{
 const channel=new MessageChannel();let settled=false;
 const finish=(failed,primary,value)=>{if(settled)return;settled=true;clearTimeout(timer);
 for(const port of [channel.port1,channel.port2])try{port.close();}catch(error){if(!failed){failed=true;primary=error;}}
 if(failed)reject(primary);else resolve(value);};
 const timer=setTimeout(()=>finish(true,new Error('SERVICE_RESPONSE_EXPIRED')),3000);
 channel.port1.onmessage=e=>e.data.error?finish(true,new Error(e.data.error)):finish(false,undefined,e.data);
 channel.port1.onmessageerror=()=>finish(true,new Error('SERVICE_MESSAGE_ERROR'));
 navigator.serviceWorker.ready.then(r=>{if(settled)return;if(!r.active){finish(true,new Error('SERVICE_NOT_ACTIVE'));return;}
 try{r.active.postMessage(command,[channel.port2]);}catch(error){finish(true,error);}},error=>finish(true,error));
})`;
