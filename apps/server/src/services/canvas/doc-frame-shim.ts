/** Fixed Doc SDK source only. F2 owns real injection; CSP and parser execution order stay unchanged. */
export const DOC_FRAME_SHIM_SCRIPT = String.raw`(()=>{
'use strict';
if(window.parent===window)return;
const parent=window.parent, observers=new Map(), pending=new Map();
let hostOrigin=null,helloTimer=null,pageRetired=false,handshakeToken={};
let port=null, binding=null, status='connecting', state=null, stateRev=-1, highest=-1, tries=0, queuedBytes=0;
const descriptor=Object.getOwnPropertyDescriptor(window,'dorkos');
if(descriptor&&(!('value' in descriptor)||!descriptor.value||typeof descriptor.value!=='object'))return;
const namespace=descriptor?descriptor.value:{};
if(Object.getOwnPropertyDescriptor(namespace,'channel'))return;
function freeze(value){if(value&&typeof value==='object'){Object.freeze(value);for(const key of Object.keys(value))freeze(value[key]);}return value;}
function notify(type,value){for(const callback of [...(observers.get(type)||[])]){try{callback(value);}catch{}}}
function failure(outcome){const error=new Error(outcome==='unconfirmed'?'Acceptance is unconfirmed.':'Document channel unavailable.');error.outcome=outcome;return error;}
function retire(next='offline'){const old=port;port=null;binding=null;status=next;state=null;stateRev=-1;highest=-1;try{old&&old.close();}catch{}for(const item of pending.values())item.reject(failure(item.sent?'unconfirmed':'cancelled'));pending.clear();queuedBytes=0;notify('status',status);}
function uuid(){return crypto.randomUUID();}
function safe(value){try{let bytes=0;const seen=new Set();function visit(v,depth){if(depth>32)return false;if(v===null||typeof v==='boolean')return true;if(typeof v==='string'){bytes+=new TextEncoder().encode(v).byteLength;return bytes<=1048576;}if(typeof v==='number')return Number.isFinite(v);if(typeof v!=='object'||seen.has(v))return false;seen.add(v);const proto=Object.getPrototypeOf(v),array=Array.isArray(v);if(array?proto!==Array.prototype:proto!==Object.prototype&&proto!==null)return false;const descriptors=Object.getOwnPropertyDescriptors(v),names=Object.keys(descriptors);if(array&&names.length!==v.length+1)return false;if(Object.getOwnPropertySymbols(v).length)return false;const entries=array?Array.from({length:v.length},(_,i)=>String(i)):names;for(const key of entries){const d=descriptors[key];if(['__proto__','prototype','constructor'].includes(key)||!d||!d.enumerable||!('value' in d)||!visit(d.value,depth+1))return false;bytes+=new TextEncoder().encode(key).byteLength;if(bytes>1048576)return false;}seen.delete(v);return true;}return visit(value,0);}catch{return false;}}
function keys(value,extra){const expected=['protocol','v','nonce','requestToken','loadToken','generation','kind',...extra];return Object.keys(value).length===expected.length&&Object.keys(value).every(key=>expected.includes(key));}
const sdk=Object.freeze({
get status(){return status;},get state(){return state;},
emit(type,payload,options={}){
if(!port||!binding||status!=='ready')return Promise.reject(failure('cancelled'));
let event,bytes;
try{if(!safe(payload)||typeof type!=='string'||!type||type.length>128||!/^[A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]+)*$/.test(type)||type.startsWith('doc.')||type.startsWith('state.')||['selection.ask','md.task.toggled','event.status','app.ack'].includes(type)||typeof options!=='object'||!safe(options)||Object.keys(options).some(key=>!['id','coalesceKey'].includes(key)))throw failure('refused');event=JSON.parse(JSON.stringify({v:1,id:options.id||uuid(),type,payload,...(options.coalesceKey===undefined?{}:{coalesceKey:options.coalesceKey})}));if(!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(event.id)||new TextEncoder().encode(JSON.stringify(event)).byteLength>16384||(event.coalesceKey!==undefined&&(typeof event.coalesceKey!=='string'||!event.coalesceKey||event.coalesceKey.length>128)))throw failure('refused');bytes=JSON.stringify({...binding,kind:'emit',requestId:event.id,event});}catch{return Promise.reject(failure('refused'));}
const old=pending.get(event.id);if(old)return old.bytes===bytes?old.promise:Promise.reject(failure('refused'));
const size=new TextEncoder().encode(bytes).byteLength+1024;
if(pending.size>=100||queuedBytes+size>1048576)return Promise.reject(failure('refused'));
let resolve,reject;const promise=new Promise((yes,no)=>{resolve=yes;reject=no;});
const item={promise,resolve,reject,bytes,size,sent:false};pending.set(event.id,item);queuedBytes+=size;
try{item.sent=true;port.postMessage(JSON.parse(bytes));}catch{retire();}return promise;
},
on(type,callback){if(typeof type!=='string'||!type||type.length>128||typeof callback!=='function')throw failure('refused');let count=0;for(const set of observers.values())count+=set.size;if(count>=100)throw failure('refused');const set=observers.get(type)||new Set();set.add(callback);observers.set(type,set);return()=>{set.delete(callback);if(!set.size)observers.delete(type);};}
});
try{Object.defineProperty(namespace,'channel',{value:sdk,enumerable:true});if(!descriptor)Object.defineProperty(window,'dorkos',{value:namespace,enumerable:true});}catch{return;}
function valid(value,kind){return value&&typeof value==='object'&&value.protocol==='dorkos-doc'&&value.v===1&&value.kind===kind&&typeof value.nonce==='string'&&value.nonce.length>0&&value.nonce.length<=128&&typeof value.requestToken==='string'&&value.requestToken.length>0&&value.requestToken.length<=128&&Number.isSafeInteger(value.loadToken)&&value.loadToken>=0&&typeof value.generation==='string'&&/^[a-f0-9]{64}$/.test(value.generation);}
function matches(value){return binding&&value.protocol==='dorkos-doc'&&value.v===1&&value.nonce===binding.nonce&&value.requestToken===binding.requestToken&&value.loadToken===binding.loadToken&&value.generation===binding.generation;}
window.addEventListener('message',event=>{
if(pageRetired||event.source!==parent||!safe(event.data))return;const value=event.data;
if(valid(value,'challenge')&&event.ports.length===0&&Object.keys(value).length===7){
if(binding&&matches(value)){parent.postMessage({...binding,kind:'ack'},event.origin==='null'?'*':event.origin);return;}
const token=handshakeToken={};retire();if(pageRetired||token!==handshakeToken)return;binding={protocol:'dorkos-doc',v:1,nonce:value.nonce,requestToken:value.requestToken,loadToken:value.loadToken,generation:value.generation};hostOrigin=event.origin;status='connecting';
parent.postMessage({protocol:'dorkos-doc',v:1,kind:'ack',nonce:binding.nonce,requestToken:binding.requestToken,loadToken:binding.loadToken,generation:binding.generation},event.origin==='null'?'*':event.origin);return;
}
if(!valid(value,'connect')||!matches(value)||event.origin!==hostOrigin||event.ports.length!==1||Object.keys(value).length!==7||port)return;
port=event.ports[0];if(helloTimer!==null)clearTimeout(helloTimer);helloTimer=null;status='ready';
port.onmessage=event=>{
const value=event.data;if(event.ports.length||!safe(value)||!matches(value))return;
if(value.kind==='receipt'||value.kind==='refused'){
if(!keys(value,value.kind==='receipt'?['requestId','receipt']:['requestId','outcome']))return;const item=pending.get(value.requestId);if(!item)return;
if(value.kind==='receipt'&&(!value.receipt||!value.receipt.receipt||value.receipt.receipt.id!==value.requestId||!['recorded','duplicate'].includes(value.receipt.receipt.status)||!Number.isSafeInteger(value.receipt.receipt.docSeq)||value.receipt.receipt.docSeq<=0))return;
pending.delete(value.requestId);queuedBytes-=item.size;
if(value.kind==='receipt')item.resolve(freeze(value.receipt));else item.reject(failure(['cancelled','refused','unconfirmed'].includes(value.outcome)?value.outcome:'unconfirmed'));
}else if(value.kind==='state'&&keys(value,['state','stateRev','docSeq','reset'])&&typeof value.reset==='boolean'&&value.state&&typeof value.state==='object'&&!Array.isArray(value.state)&&Number.isSafeInteger(value.stateRev)&&value.stateRev>=0&&Number.isSafeInteger(value.docSeq)&&value.docSeq>=0&&(value.reset===true||(value.stateRev>=stateRev&&value.docSeq>=highest))){state=freeze(value.state);stateRev=value.stateRev;highest=value.docSeq;notify('state',state);}
else if(value.kind==='event'&&keys(value,['frame'])&&value.frame&&value.frame.type==='canvas_event'&&value.frame.event&&typeof value.frame.event.type==='string'&&Number.isSafeInteger(value.frame.docSeq)&&value.frame.docSeq>highest){highest=value.frame.docSeq;notify(value.frame.event.type,freeze(value.frame.event));}
else if(value.kind==='status'&&keys(value,['status','unconfirmed'])&&typeof value.unconfirmed==='boolean'&&['connecting','ready','offline','revoked'].includes(value.status)){status=value.status;notify('status',status);if(status==='revoked'||status==='offline')retire(status);}
};port.start();notify('status',status);
});
window.addEventListener('pagehide',()=>{if(pageRetired)return;pageRetired=true;handshakeToken={};if(helloTimer!==null)clearTimeout(helloTimer);helloTimer=null;try{port&&port.postMessage({...binding,kind:'retire'});}catch{}retire();});
function hello(){if(pageRetired||port)return;try{parent.postMessage({protocol:'dorkos-doc',v:1,kind:'hello'},'*');}catch{}if(++tries<6)helloTimer=setTimeout(hello,500);else if(!port){status='offline';notify('status',status);}}
hello();
})();`;
