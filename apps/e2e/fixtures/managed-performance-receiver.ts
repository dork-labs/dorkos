import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import type { Socket } from 'node:net';
import { test as original, expect } from './managed-browser-receiver';

export const test = original.extend<{
  performanceReceiver: { url: string; revisions: number[] };
}>({
  performanceReceiver: async ({ managedReceiver }, use) => {
    // Depend on the existing signed-owner fixture: its original Off cleanup remains owned.
    void managedReceiver;
    const path = `/performance/${randomUUID()}`;
    const revisions: number[] = [];
    const sockets = new Set<Socket>();
    let overflow = false;
    const server = createServer((req, res) => {
      if (req.method === 'GET' && req.url === path) {
        res.setHeader('Content-Type', 'text/html; charset=utf-8');
        res.setHeader('Cache-Control', 'no-store');
        res.end(`<!doctype html><meta charset="utf-8"><title>Actual frame revision</title>
<style>html,body{margin:0;background:#c00}.bit{position:absolute;top:32px;width:16px;height:32px}#signature{position:absolute;left:480px;top:32px;width:64px;height:32px;background:cyan}button{position:absolute;left:700px;top:350px;width:200px;height:100px}</style><div id="signature"></div><button>Advance actual revision</button><script>
let revision=0;const bits=[];for(let b=0;b<10;b++){const e=document.createElement('div');e.className='bit';e.style.left=(16+b*32)+'px';document.body.append(e);bits.push(e);}function paint(){for(let b=0;b<10;b++)bits[b].style.background=(revision&(1<<b))?'white':'black';fetch('${path}/observe',{method:'POST',body:String(revision)});}document.querySelector('button').addEventListener('pointerdown',()=>{revision++;paint();});paint();</script>`);
      } else if (req.method === 'POST' && req.url === `${path}/observe`) {
        let body = '';
        req.on('data', (b: Buffer) => {
          body += b.toString();
          if (body.length > 8) {
            overflow = true;
            req.destroy();
          }
        });
        req.on('end', () => {
          if (!/^\d{1,3}$/.test(body) || Number(body) > 511 || revisions.length >= 512) {
            overflow = true;
            res.writeHead(400).end();
            return;
          }
          revisions.push(Number(body));
          res.writeHead(204).end();
        });
      } else res.writeHead(404).end();
    });
    server.on('connection', (s) => {
      sockets.add(s);
      s.once('close', () => sockets.delete(s));
      if (sockets.size > 32) {
        overflow = true;
        s.destroy();
      }
    });
    let first: Readonly<{ value: unknown }> | undefined;
    try {
      await new Promise<void>((yes, no) => {
        server.once('error', no);
        server.listen(0, '127.0.0.1', yes);
      });
      const address = server.address();
      if (!address || typeof address === 'string')
        throw new Error('Original receiver address missing');
      await use({ url: `http://127.0.0.1:${address.port}${path}`, revisions });
      expect(overflow, 'real revision receiver bounds').toBe(false);
    } catch (value) {
      first = { value };
    } finally {
      const closing = new Promise<void>((yes, no) => server.close((e) => (e ? no(e) : yes())));
      for (const socket of sockets)
        try {
          socket.destroy();
        } catch (value) {
          first ??= { value };
        }
      try {
        await closing;
      } catch (value) {
        first ??= { value };
      }
    }
    if (first) throw first.value;
  },
});
export { expect };
