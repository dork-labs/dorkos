/** Owned stdio MCP App resource: the production endpoint connects, reads and closes it. */
import { createRequire } from 'node:module';
import { pathToFileURL, URL } from 'node:url';
const require = createRequire(new URL('../../../server/package.json', import.meta.url));
const { McpServer } = await import(
  pathToFileURL(require.resolve('@modelcontextprotocol/sdk/server/mcp.js')).href
);
const { StdioServerTransport } = await import(
  pathToFileURL(require.resolve('@modelcontextprotocol/sdk/server/stdio.js')).href
);
const uri = 'ui://original-document-app/main';
const html = `<!doctype html><html><head><meta charset="utf-8"><title>Original document MCP App</title></head><body>
<h1>Original document MCP App</h1><label>App draft <input id="draft"></label>
<p id="state">No state</p><p id="permission">Not negotiated</p><p id="result">No request</p><p id="downstream">No downstream event</p>
<button id="connect">Connect document</button><button id="emit">Send app event</button>
<button id="retry">Retry original event</button><button id="wrong-doc">Wrong document</button>
<button id="wrong-generation">Wrong generation</button><button id="wrong-bridge">Wrong bridge generation</button><button id="reserved">Reserved host event</button>
<button id="tool">Try tools call</button><button id="incoming">Try downstream request</button>
<div style="height:1600px">Scrollable app content</div><script>
(() => {
  let nextId = 0, displayId = 0, binding, original;
  const pending = new Map();
  const request = (method, params) => new Promise((resolve, reject) => {
    const id = ++nextId; pending.set(id, {resolve, reject});
    parent.postMessage({jsonrpc:'2.0',id,method,params}, '*');
  });
  addEventListener('message', (message) => {
    if (message.source !== parent || !message.data || message.data.jsonrpc !== '2.0') return;
    const data = message.data;
    if (data.method === 'dorkos/app.event') {
      const value = data.params;
      if (!binding || value?.documentId !== binding.documentId || value?.generation !== binding.generation || value?.bridgeGeneration !== binding.bridgeGeneration) return;
      if(value.kind === 'state') {
        document.getElementById('state').textContent = typeof value.state?.message === 'string' ? value.state.message : 'No state';
        document.getElementById('state').dataset.stateRev = String(value.stateRev);
        document.getElementById('state').dataset.largeLength = String((value.state.largeA?.length ?? 0) + (value.state.largeB?.length ?? 0));
      }
      if (value.kind === 'event' && ['app.ack','app.reply'].includes(value.event.type)) {
        document.getElementById('downstream').textContent = value.event.type;
        document.getElementById('downstream').dataset.eventId = value.event.id;
        if(value.event.type === 'app.ack') {
          document.getElementById('downstream').dataset.ackEventId = value.event.id;
          document.getElementById('downstream').dataset.ackInputIds = value.event.payload.eventIds.join(',');
        }
        if(value.event.type === 'app.reply')document.getElementById('downstream').dataset.replyInputIds = value.event.payload.eventIds.join(',');
      }
      return;
    }
    const waiter = pending.get(data.id); if (!waiter) return; pending.delete(data.id);
    if (data.error) waiter.reject(data.error); else waiter.resolve(data.result);
  });
  const display = async (work) => {
    const output = document.getElementById('result');
    const operation = ++displayId;
    try {
      const result = await work();
      output.textContent = result.receipt?.status ?? 'Accepted';
      output.dataset.eventId = result.receipt?.id ?? '';
      output.dataset.docSeq = String(result.receipt?.docSeq ?? '');
    } catch (error) { output.textContent = 'Refused'; output.dataset.code = String(error?.code ?? 'unknown'); }
    finally { output.dataset.settled = String(operation); }
  };
  const envelope = (event) => ({v:1,documentId:binding?.documentId ?? 'unnegotiated',generation:binding?.generation ?? 'unnegotiated',bridgeGeneration:binding?.bridgeGeneration ?? 'unnegotiated',event});
  const uuid = () => {const bytes=crypto.getRandomValues(new Uint8Array(16));bytes[6]=(bytes[6]&15)|64;bytes[8]=(bytes[8]&63)|128;const h=Array.from(bytes,b=>b.toString(16).padStart(2,'0')).join('');return h.slice(0,8)+'-'+h.slice(8,12)+'-'+h.slice(12,16)+'-'+h.slice(16,20)+'-'+h.slice(20);};
  const makeEvent = () => ({v:1,id:uuid(),type:'task.changed',payload:{source:'original-mcp-app'}});
  document.getElementById('connect').onclick = () => display(async () => {
    const result = await request('ui/initialize', {extensions:{'dorkos/app':{version:1}}});
    binding = result.extensions?.['dorkos/app'];
    if(!binding)document.getElementById('permission').textContent = 'No document permission';
    if (binding?.version !== 1 || binding.emit !== true || binding.events !== true || typeof binding.bridgeGeneration !== 'string') throw {code:'NO_PERMISSION'};
    document.getElementById('permission').textContent = 'Document connected';
    document.getElementById('permission').dataset.bridgeGeneration = binding.bridgeGeneration;
    return result;
  });
  document.getElementById('emit').onclick = () => display(() => {
    original = envelope(makeEvent()); return request('dorkos/app.emit', original);
  });
  document.getElementById('retry').onclick = () => display(() => request('dorkos/app.emit', original));
  document.getElementById('wrong-doc').onclick = () => display(() => request('dorkos/app.emit', {...envelope(makeEvent()),documentId:uuid()}));
  document.getElementById('wrong-generation').onclick = () => display(() => request('dorkos/app.emit', {...envelope(makeEvent()),generation:uuid()}));
  document.getElementById('wrong-bridge').onclick = () => display(() => request('dorkos/app.emit', {...envelope(makeEvent()),bridgeGeneration:uuid()}));
  document.getElementById('reserved').onclick = () => display(() => request('dorkos/app.emit', envelope({...makeEvent(),type:'selection.ask'})));
  document.getElementById('tool').onclick = () => display(() => request('tools/call', {name:'canvas_send',arguments:{}}));
  document.getElementById('incoming').onclick = () => display(() => request('dorkos/app.event', {v:1,kind:'event',event:{type:'app.ack'}}));
})();
</script></body></html>`;
const server = new McpServer(
  { name: 'original-document-app', version: '1.0.0' },
  { capabilities: { resources: {} } }
);
server.registerResource(
  'original-document-app',
  uri,
  { mimeType: 'text/html;profile=mcp-app' },
  async (requested) => ({
    contents: [
      {
        uri: requested.href,
        mimeType: 'text/html;profile=mcp-app',
        text: html,
        _meta: {
          'ui/csp':
            "default-src 'none'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'",
          'ui/permissions': [],
        },
      },
    ],
  })
);
await server.connect(new StdioServerTransport());
