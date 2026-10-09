import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
/** Controlled HTTP page only. The optional real destination grant must approve
 * this exact endpoint before runtime birth. This helper never sends a DOM event. */
export async function createHandoffPageReceiver() {
  const nonce = randomUUID();
  type Event = {
    x: number;
    y: number;
    trusted: boolean;
    buttons: number;
    shiftKey: boolean;
    ctrlKey: boolean;
    altKey: boolean;
    metaKey: boolean;
  };
  const events: Event[] = [];
  const listeners = new Set<() => void>();
  const server = createServer(async (req, res) => {
    if (req.method === 'GET' && req.url === '/') {
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      res.end(
        `<!doctype html><html><body style="margin:0;height:600px"><input aria-label="Handoff target" style="position:absolute;left:5px;top:5px;width:400px;height:550px"><script>document.addEventListener('pointermove',e=>{fetch('/events/${nonce}',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({x:e.clientX,y:e.clientY,trusted:e.isTrusted,buttons:e.buttons,shiftKey:e.shiftKey,ctrlKey:e.ctrlKey,altKey:e.altKey,metaKey:e.metaKey})}).catch(()=>{});});</script></body></html>`
      );
      return;
    }
    if (req.method !== 'POST' || req.url !== `/events/${nonce}`) {
      res.writeHead(404).end();
      return;
    }
    try {
      const chunks: Buffer[] = [];
      let size = 0;
      for await (const chunk of req) {
        size += chunk.length;
        if (size > 4096) throw new Error('EVENT_TOO_LARGE');
        chunks.push(Buffer.from(chunk));
      }
      const parsed: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      if (!parsed || typeof parsed !== 'object') throw new Error('INVALID_EVENT');
      const value = parsed as Record<string, unknown>;
      if (
        Object.keys(value).sort().join(',') !==
          'altKey,buttons,ctrlKey,metaKey,shiftKey,trusted,x,y' ||
        !Number.isFinite(value.x) ||
        !Number.isFinite(value.y) ||
        !Number.isInteger(value.buttons) ||
        ['trusted', 'shiftKey', 'ctrlKey', 'altKey', 'metaKey'].some(
          (key) => typeof value[key] !== 'boolean'
        )
      )
        throw new Error('INVALID_EVENT');
      if (events.length >= 512) throw new Error('EVENT_BANK_FULL');
      events.push(value as Event);
      for (const notify of listeners) notify();
      res.writeHead(204).end();
    } catch {
      res.writeHead(400).end();
    }
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.removeListener('error', reject);
      resolve();
    });
  });
  const address = server.address();
  if (!address || typeof address === 'string') {
    server.close();
    throw new Error('RECEIVER_ADDRESS_ABSENT');
  }
  let closed = false;
  return Object.freeze({
    url: `http://127.0.0.1:${address.port}/`,
    receivePointer(x: number, y: number, signal: AbortSignal): Promise<Event> {
      return new Promise((resolve, reject) => {
        const finish = () => {
          listeners.delete(check);
          signal.removeEventListener('abort', abort);
        };
        const abort = () => {
          finish();
          reject(signal.reason);
        };
        const check = () => {
          if (signal.aborted) {
            abort();
            return;
          }
          if (closed) {
            finish();
            reject(new Error('RECEIVER_CLOSED'));
            return;
          }
          const index = events.findIndex((event) => event.x === x && event.y === y);
          if (index >= 0) {
            const [actual] = events.splice(index, 1);
            finish();
            resolve(actual!);
          }
        };
        listeners.add(check);
        signal.addEventListener('abort', abort, { once: true });
        check();
      });
    },
    async close() {
      closed = true;
      for (const notify of [...listeners]) notify();
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve()))
      );
    },
  });
}
