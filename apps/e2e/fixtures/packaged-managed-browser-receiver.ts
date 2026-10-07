import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import type { Socket } from 'node:net';
import type { ManagedReceiver } from './managed-browser-receiver';

/** Same actual input/cookie receiver, owned independently of the Electron app. */
export async function ownPackagedManagedReceiver(): Promise<
  ManagedReceiver & { close(): Promise<void> }
> {
  const token = randomUUID();
  const path = `/acceptance/${token}`;
  const sockets = new Set<Socket>();
  const socketReturns: Promise<void>[] = [];
  const observations: ManagedReceiver['observations'] = [];
  const visits: ManagedReceiver['visits'] = [];
  let overflow = false;
  const server = createServer((req, res) => {
    if (req.url === path && req.method === 'GET') {
      if (visits.length >= 48) {
        overflow = true;
        res.writeHead(429).end();
        return;
      }
      visits.push({
        cookieReturned: (req.headers.cookie ?? '')
          .split(';')
          .some((value) => value.trim() === `ui_acceptance=${token}`),
      });
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      res.setHeader('Cache-Control', 'no-store');
      res.setHeader(
        'Set-Cookie',
        `ui_acceptance=${token}; HttpOnly; SameSite=Lax; Path=${path}; Max-Age=3600`
      );
      res.end(`<!doctype html><meta charset="utf-8"><title>Managed browser acceptance</title>
<style>html,body{margin:0;background:rgb(220,0,0)}input{position:fixed;left:32px;top:32px;width:200px;height:96px;box-sizing:border-box;border:0;outline:0;padding:8px;background:black;color:white;caret-color:white;font:64px monospace}#marker{position:fixed;left:300px;top:40px;width:80px;height:80px;background:rgb(0,0,220)}</style>
<input aria-label="Acceptance field" value="" autocomplete="off" spellcheck="false"><div id="marker"></div>
<script>const field=document.querySelector('input');function report(){fetch('${path}/observe',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({width:innerWidth,height:innerHeight,value:field.value,focused:document.activeElement===field})});}for(const name of ['input','focus','blur'])field.addEventListener(name,report);report();</script>`);
      return;
    }
    if (req.url === `${path}/observe` && req.method === 'POST') {
      const chunks: Buffer[] = [];
      let size = 0;
      req.on('data', (chunk: Buffer) => {
        size += chunk.length;
        if (size > 2048) {
          overflow = true;
          req.destroy();
        } else chunks.push(chunk);
      });
      req.on('end', () => {
        try {
          const value: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'));
          if (!value || typeof value !== 'object') throw new Error('Invalid observation');
          const v = value as Record<string, unknown>;
          if (
            Object.keys(v).length !== 4 ||
            !Number.isInteger(v.width) ||
            !Number.isInteger(v.height) ||
            Number(v.width) < 400 ||
            Number(v.width) > 16384 ||
            Number(v.height) < 150 ||
            Number(v.height) > 16384 ||
            typeof v.value !== 'string' ||
            v.value.length > 64 ||
            typeof v.focused !== 'boolean'
          )
            throw new Error('Invalid observation');
          if (observations.length >= 384) throw new Error('Observation capacity');
          observations.push({
            width: Number(v.width),
            height: Number(v.height),
            value: v.value,
            focused: v.focused,
          });
          res.writeHead(204).end();
        } catch {
          overflow = true;
          res.writeHead(400).end();
        }
      });
      return;
    }
    res.writeHead(404).end();
  });
  server.on('connection', (socket) => {
    socketReturns.push(new Promise<void>((resolve) => socket.once('close', resolve)));
    sockets.add(socket);
    socket.once('close', () => sockets.delete(socket));
    if (sockets.size > 16) {
      overflow = true;
      socket.destroy();
    }
  });

  let closing: Promise<void> | undefined;
  const close = (): Promise<void> => {
    if (closing) return closing;
    closing = Promise.resolve().then(async () => {
      let first: { value: unknown } | undefined;
      const stopped = new Promise<void>((resolve, reject) =>
        server.close((error) =>
          error && (error as NodeJS.ErrnoException).code !== 'ERR_SERVER_NOT_RUNNING'
            ? reject(error)
            : resolve()
        )
      );
      void stopped.catch((value) => {
        first ??= { value };
      });
      for (const socket of sockets) {
        try {
          socket.destroy();
        } catch (value) {
          first ??= { value };
        }
      }
      await Promise.allSettled([stopped, ...socketReturns]);
      if (first) throw first.value;
      if (overflow) throw new Error('CONTROLLED_RECEIVER_CAPACITY');
    });
    return closing;
  };
  try {
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', resolve);
    });
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('RECEIVER_ADDRESS');
    return Object.freeze({
      url: `http://127.0.0.1:${address.port}${path}`,
      observations,
      visits,
      close,
    });
  } catch (value) {
    await Promise.allSettled([close()]);
    throw value;
  }
}
