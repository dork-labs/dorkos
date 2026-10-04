/**
 * The fixture "extension bundle" the isolation integration suites load into a
 * real child (DOR-2686). It is CommonJS source, exactly what the extension
 * compiler emits for a server entry, and it exports `probes`: each one tries
 * one thing an extension might do and reports what happened, never throwing,
 * so a test can assert the refusal (and its code) as data.
 *
 * The same source also runs in an unrestricted control process
 * (`runControl` in the harness) — plain Node, no permission model, no guard,
 * the real `child_process` — so every refusal a suite asserts is paired with
 * proof that the same probe succeeds when nothing stops it. A probe that could
 * never succeed would make its refusal test unable to fail.
 *
 * @module services/extensions/isolation/__tests__/fixtures/probe-bundle
 */

/** The bundle source. */
export const PROBE_BUNDLE_SOURCE = String.raw`
'use strict';
const fs = require('fs');
const net = require('net');
const tls = require('tls');
const dns = require('dns');
const dgram = require('dgram');
const http2 = require('http2');
const asyncHooks = require('async_hooks');
const childProcess = require('child_process');

/** Run fn, reporting { ok, value } or { ok: false, code, message }. */
async function attempt(fn) {
  try {
    return { ok: true, value: await fn() };
  } catch (e) {
    const cause = e && e.cause;
    return {
      ok: false,
      code: (e && e.code) || (cause && cause.code) || null,
      message: String(e && e.message),
      cause: cause ? String(cause.message) : null,
    };
  }
}

/** Open a TCP connection and close it again; resolves 'connected'. */
function tcpConnect(host, port, extra) {
  return new Promise((resolve, reject) => {
    const socket = net.connect(Object.assign({ host, port }, extra || {}));
    const timer = setTimeout(() => { socket.destroy(); reject(new Error('timeout')); }, 3000);
    socket.once('connect', () => { clearTimeout(timer); socket.destroy(); resolve('connected'); });
    socket.once('error', (e) => { clearTimeout(timer); reject(e); });
  });
}

exports.probes = {
  readFile: (p) => attempt(() => fs.readFileSync(p, 'utf8')),
  writeFile: (p, text) => attempt(() => { fs.writeFileSync(p, text); return true; }),
  // The real module, reached around the shim: only Node's permission model stops it.
  realExecSync: () =>
    attempt(() => process.mainModule.require('child_process').execSync('echo hi').toString().trim()),
  worker: () =>
    attempt(async () => {
      const { Worker } = require('worker_threads');
      const w = new Worker('1', { eval: true });
      await w.terminate();
      return 'started';
    }),
  binding: () => attempt(() => typeof process.binding('tcp_wrap')),
  env: () => attempt(() => Object.assign({}, process.env)),
  argvFlags: () => attempt(() => process.execArgv),
  fetch: (url) =>
    attempt(async () => {
      const res = await fetch(url);
      return res.status;
    }),
  tcpConnect: (host, port) => attempt(() => tcpConnect(host, port)),
  tcpConnectWithLookup: (host, port, ip) =>
    attempt(() =>
      tcpConnect(host, port, { lookup: (h, o, cb) => (typeof o === 'function' ? o : cb)(null, ip, 4) })
    ),
  tlsConnect: (host, port) =>
    attempt(
      () =>
        new Promise((resolve, reject) => {
          const socket = tls.connect({ host, port, rejectUnauthorized: false });
          const timer = setTimeout(() => { socket.destroy(); resolve('no-handshake'); }, 1500);
          socket.once('secureConnect', () => { clearTimeout(timer); socket.destroy(); resolve('secure'); });
          socket.once('error', (e) => {
            clearTimeout(timer);
            socket.destroy();
            // A handshake failure means the connection itself was made.
            if (e.code === 'ERR_EXTENSION_NET_DENIED') reject(e); else resolve('reached:' + e.code);
          });
        })
    ),
  http2Connect: (url) =>
    attempt(
      () =>
        new Promise((resolve, reject) => {
          const session = http2.connect(url);
          const timer = setTimeout(() => { session.destroy(); resolve('no-answer'); }, 1500);
          session.once('connect', () => { clearTimeout(timer); session.destroy(); resolve('connected'); });
          session.once('error', (e) => {
            clearTimeout(timer);
            session.destroy();
            if (e.code === 'ERR_EXTENSION_NET_DENIED') reject(e); else resolve('reached:' + e.code);
          });
        })
    ),
  dnsLookup: (name) =>
    attempt(() => new Promise((resolve, reject) => dns.lookup(name, (e, a) => (e ? reject(e) : resolve(a))))),
  dnsPromisesLookup: (name) => attempt(async () => (await dns.promises.lookup(name)).address),
  dnsPromisesResolve4: (name) => attempt(() => dns.promises.resolve4(name)),
  dnsReverse: (ip) => attempt(() => dns.promises.reverse(ip)),
  dnsSetServers: () => attempt(() => { new dns.Resolver().setServers(['1.1.1.1']); return true; }),
  udp: () =>
    attempt(() => {
      const s = dgram.createSocket('udp4');
      s.close();
      return 'created';
    }),
  listen: () =>
    attempt(
      () =>
        new Promise((resolve, reject) => {
          const server = net.createServer();
          server.once('error', reject);
          server.listen(0, '127.0.0.1', () => { server.close(); resolve('listening'); });
        })
    ),
  unixSocket: (p) =>
    attempt(
      () =>
        new Promise((resolve, reject) => {
          const socket = net.connect({ path: p });
          socket.once('connect', () => { socket.destroy(); resolve('connected'); });
          socket.once('error', reject);
        })
    ),
  // Rewrite the prototypes a naive guard would lean on, then connect anyway.
  tamperThenConnect: (host, port, lowerAs) => {
    String.prototype.endsWith = () => true;
    String.prototype.toLowerCase = function () { return lowerAs; };
    String.prototype.slice = function () { return ''; };
    Array.prototype.some = () => true;
    Array.prototype.includes = () => true;
    Map.prototype.get = () => Number.MAX_SAFE_INTEGER;
    return attempt(() => tcpConnect(host, port));
  },
  // Open a raw connection with a native handle and a request object captured
  // from async_hooks, around net.Socket entirely. Needs one allowed
  // connection first to reach the TCP constructor.
  rawHandleConnect: (allowedHost, allowedPort, host, port) =>
    attempt(async () => {
      let ReqCtor = null;
      const hook = asyncHooks.createHook({
        init(id, type, trigger, resource) {
          if (type === 'TCPCONNECTWRAP' && !ReqCtor) ReqCtor = resource.constructor;
        },
      });
      hook.enable();
      const TCP = await new Promise((resolve, reject) => {
        const s = net.connect({ host: allowedHost, port: allowedPort });
        s.once('connect', () => { const ctor = s._handle.constructor; s.destroy(); resolve(ctor); });
        s.once('error', reject);
      });
      hook.disable();
      if (!ReqCtor) throw new Error('no request constructor captured');
      return await new Promise((resolve, reject) => {
        const handle = new TCP(0);
        const req = new ReqCtor();
        req.oncomplete = (status) => { handle.close(); resolve('completed:' + status); };
        const err = handle.connect(req, host, port);
        if (err) { handle.close(); reject(Object.assign(new Error('refused'), { code: 'errno:' + err })); }
      });
    }),
  // The child_process shim.
  run: (file, args, options) =>
    attempt(
      () =>
        new Promise((resolve, reject) => {
          const child = childProcess.spawn(file, args || [], options || {});
          let stdout = '';
          let stderr = '';
          child.stdout.on('data', (d) => (stdout += d));
          child.stderr.on('data', (d) => (stderr += d));
          child.once('error', reject);
          child.once('close', (code, signal) => resolve({ code, signal, stdout, stderr, pid: child.pid }));
        })
    ),
  execFile: (file, args) =>
    attempt(
      () =>
        new Promise((resolve, reject) =>
          childProcess.execFile(file, args, (e, stdout) => (e ? reject(e) : resolve(stdout)))
        )
    ),
  exec: (command) =>
    attempt(
      () =>
        new Promise((resolve, reject) =>
          childProcess.exec(command, (e, stdout) => (e ? reject(e) : resolve(stdout)))
        )
    ),
  shimExecSync: () => attempt(() => childProcess.execSync('echo hi')),
  shimSpawnSync: () => attempt(() => childProcess.spawnSync('echo')),
  shimFork: () => attempt(() => childProcess.fork('x')),
  // Start a long program and report its pid once it runs.
  startLong: (file, args) =>
    attempt(
      () =>
        new Promise((resolve, reject) => {
          const child = childProcess.spawn(file, args);
          child.once('spawn', () => resolve(child.pid));
          child.once('error', reject);
        })
    ),
  requireOther: (name) => attempt(() => typeof require(name)),
  // Lifecycle probes. These do not report back.
  hang: () => { setTimeout(() => { for (;;) {} }, 10); return 'hanging'; },
  oom: () => {
    setTimeout(() => {
      const keep = [];
      for (;;) keep.push(new Array(100000).fill(Math.random()));
    }, 10);
    return 'allocating';
  },
  crash: () => { setTimeout(() => process.abort(), 10); return 'crashing'; },
  flood: (n) => { for (let i = 0; i < n; i++) console.log('line ' + i); return n; },
  floodMessages: (n) => { for (let i = 0; i < n; i++) process.send({ type: 'pong', n: i }); return n; },
  sendRaw: (message) => { process.send(message); return true; },
};
`;
