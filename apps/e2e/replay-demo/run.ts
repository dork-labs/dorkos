import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { spawn, type ChildProcess } from 'node:child_process';
import { parseArgs } from 'node:util';
import { createDemoHome, demoEnvironment } from './home.js';

const repo = path.resolve(import.meta.dirname, '../../..');
const { values } = parseArgs({
  options: {
    recording: { type: 'string', default: 'codex' },
    home: { type: 'string' },
    'server-port': { type: 'string' },
    'client-port': { type: 'string' },
    check: { type: 'boolean', default: false },
  },
});
if (!['codex', 'connection-access'].includes(values.recording!))
  throw new Error('Choose recording codex or connection-access.');

// Hold both sockets until launch so the automatic pair is distinct.
async function reserve(port = 0): Promise<net.Server> {
  const server = net.createServer();
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', resolve);
  });
  return server;
}
function portOf(server: net.Server): number {
  return (server.address() as net.AddressInfo).port;
}
async function close(server: net.Server): Promise<void> {
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve()))
  );
}
async function stop(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null || !child.pid) return;
  const exited = new Promise<void>((resolve) => child.once('exit', () => resolve()));
  const signal = (value: NodeJS.Signals) => {
    try {
      process.kill(-child.pid!, value);
    } catch {
      /* Already exited. */
    }
  };
  signal('SIGTERM');
  const timer = setTimeout(() => signal('SIGKILL'), 3_000);
  try {
    await exited;
  } finally {
    clearTimeout(timer);
  }
}
async function ready(url: string, children: ChildProcess[]): Promise<void> {
  const deadline = Date.now() + 120_000;
  while (Date.now() < deadline) {
    if (
      children.some((child) => !child.pid || child.exitCode !== null || child.signalCode !== null)
    )
      throw new Error('Demo process stopped. See the logs in the demo home.');
    try {
      if ((await fetch(url, { signal: AbortSignal.timeout(1_000) })).ok) return;
    } catch {
      /* Still starting. */
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error('Demo startup timed out. See the logs in the demo home.');
}

const sockets: net.Server[] = [];
const children: ChildProcess[] = [];
let stopping = false;
const quit = () => {
  stopping = true;
  for (const child of children) void stop(child);
};
process.once('SIGINT', quit);
process.once('SIGTERM', quit);
try {
  // Validate explicit ports BEFORE binding (including the protected ports).
  const requestedServer = values['server-port'] === undefined ? 0 : Number(values['server-port']);
  const requestedClient = values['client-port'] === undefined ? 0 : Number(values['client-port']);
  for (const [provided, port] of [
    [values['server-port'], requestedServer],
    [values['client-port'], requestedClient],
  ] as const) {
    if (provided !== undefined)
      demoEnvironment(
        { root: '', accountHome: '', recording: '' },
        port,
        port === 4643 ? 4644 : 4643
      );
  }
  if (requestedServer && requestedClient && requestedServer === requestedClient)
    throw new Error('Choose two distinct ports.');
  const api = await reserve(requestedServer);
  sockets.push(api);
  const web = await reserve(requestedClient);
  sockets.push(web);
  const serverPort = portOf(api);
  const clientPort = portOf(web);
  const fixture = path.join(
    repo,
    'apps/server/src/services/runtimes/test-mode/__fixtures__',
    `replay-${values.recording === 'codex' ? 'codex-chat' : 'connection-access'}.json`
  );
  const home = await createDemoHome(fixture, values.home);
  const env = demoEnvironment(home, serverPort, clientPort);
  console.log(`Recorded demo home: ${home.root}`);
  for (const socket of sockets.splice(0)) await close(socket);
  for (const [label, executable, args, cwd] of [
    [
      'server',
      path.join(repo, 'apps/server/node_modules/.bin/tsx'),
      ['src/index.ts'],
      path.join(repo, 'apps/server'),
    ],
    [
      'client',
      process.execPath,
      [
        path.join(repo, 'apps/client/node_modules/vite/bin/vite.js'),
        '--host',
        '127.0.0.1',
        '--port',
        String(clientPort),
        '--strictPort',
      ],
      path.join(repo, 'apps/client'),
    ],
  ] as const) {
    if (stopping) throw new Error('Demo startup cancelled.');
    const log = fs.openSync(path.join(home.root, `${label}.log`), 'wx', 0o600);
    try {
      const child = spawn(executable, [...args], {
        cwd,
        env,
        detached: true,
        stdio: ['ignore', log, log],
      });
      child.once('error', (error) => {
        console.error(`Demo ${label}: ${error.message}`);
        quit();
      });
      children.push(child);
    } finally {
      fs.closeSync(log);
    }
  }
  await ready(`http://127.0.0.1:${serverPort}/api/health`, children);
  await ready(`http://127.0.0.1:${clientPort}`, children);
  console.log(`Recorded demo ready: http://127.0.0.1:${clientPort} (API ${serverPort})`);
  console.log('Scout is the default. Atlas uses the Codex demo. Ctrl-C stops both processes.');
  if (!values.check && !stopping) {
    await Promise.race(
      children.map((child) => new Promise<void>((resolve) => child.once('exit', () => resolve())))
    );
    if (!stopping) throw new Error('A demo process stopped. See the logs in the demo home.');
  }
} finally {
  for (const socket of sockets) await close(socket);
  await Promise.all(children.map(stop));
  process.removeListener('SIGINT', quit);
  process.removeListener('SIGTERM', quit);
}
