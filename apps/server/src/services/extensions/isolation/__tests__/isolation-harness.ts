/**
 * Shared setup for the isolation integration suites (DOR-2686): a temporary
 * DorkOS data directory, the real child bootstrap (bundled from source, as in
 * development), real forked children with the real flags, an unrestricted
 * control process, and cleanup that stops every process a suite started.
 *
 * Nothing here mocks `fork`, the permission model or the guard.
 *
 * @module services/extensions/isolation/__tests__/isolation-harness
 */
import { fork, type ChildProcess } from 'node:child_process';
import fs from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import type { ExtensionIsolation } from '@dorkos/extension-api';
import { resolveChildEntry } from '../child-entry.js';
import {
  IsolatedExtensionHost,
  type IsolatedExit,
  type IsolatedHostOptions,
} from '../isolated-host.js';
import { PROBE_BUNDLE_SOURCE } from './fixtures/probe-bundle.js';

/** One log line the host wrote. */
export interface LogLine {
  level: 'info' | 'warn' | 'error';
  message: string;
}

/** Everything a suite needs, and everything cleanup must undo. */
export interface Harness {
  tmp: string;
  dorkHome: string;
  bootstrap: string;
  bundle: string;
  logs: LogLine[];
  hosts: IsolatedExtensionHost[];
  controls: ChildProcess[];
  servers: net.Server[];
  sockets: Set<net.Socket>;
}

/** A probe's report (see the fixture). */
export interface ProbeReport {
  ok: boolean;
  value?: unknown;
  code?: string | null;
  message?: string;
  cause?: string | null;
}

/**
 * Create a harness: a real-path temp folder (grants must be real paths), a
 * data directory, the bundled bootstrap and the probe bundle.
 */
export async function createHarness(): Promise<Harness> {
  const tmp = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'dorkos-isolation-')));
  const dorkHome = path.join(tmp, '.dork');
  await fs.mkdir(dorkHome, { recursive: true });
  const bootstrap = await resolveChildEntry(dorkHome);
  const bundle = path.join(tmp, 'bundles', 'probes.js');
  await fs.mkdir(path.dirname(bundle), { recursive: true });
  await fs.writeFile(bundle, PROBE_BUNDLE_SOURCE);
  return {
    tmp,
    dorkHome,
    bootstrap,
    bundle,
    logs: [],
    hosts: [],
    controls: [],
    servers: [],
    sockets: new Set(),
  };
}

/** Options for {@link makeHost}. */
export interface MakeHostOptions {
  id?: string;
  bundle?: string;
  net?: string[];
  run?: string[];
  resolvedRun?: ExtensionIsolation['resolvedRun'];
  memoryMb?: number;
  dorkosPort?: number;
  extensionDir?: string;
  onExit?: (exit: IsolatedExit) => void;
  overrides?: Partial<IsolatedHostOptions>;
}

/**
 * Build a host for the probe bundle (tracked for cleanup).
 *
 * @param h - The harness.
 * @param options - Its isolation and test seams.
 */
export function makeHost(h: Harness, options: MakeHostOptions = {}): IsolatedExtensionHost {
  const id = options.id ?? `probe-${h.hosts.length + 1}`;
  const run = options.run ?? [];
  const host = new IsolatedExtensionHost({
    extensionId: id,
    displayName: 'Probe',
    bundlePath: options.bundle ?? h.bundle,
    extensionDir: options.extensionDir ?? path.join(h.tmp, 'ext', id),
    dorkHome: h.dorkHome,
    isolation: {
      runtime: 'subprocess',
      net: options.net ?? [],
      run,
      resolvedRun: options.resolvedRun ?? run.map((name) => ({ name, path: name })),
      agents: false,
      memoryMb: options.memoryMb ?? 256,
    },
    dorkosPort: options.dorkosPort ?? 1,
    bootstrapPath: h.bootstrap,
    logger: {
      info: (message) => h.logs.push({ level: 'info', message }),
      warn: (message) => h.logs.push({ level: 'warn', message }),
      error: (message) => h.logs.push({ level: 'error', message }),
    },
    onExit: options.onExit,
    testSeams: { probes: true },
    ...options.overrides,
  });
  h.hosts.push(host);
  return host;
}

/**
 * Start a host and require it to start.
 *
 * @param host - The host.
 */
export async function startOk(host: IsolatedExtensionHost): Promise<void> {
  const result = await host.start();
  if (!result.ok) throw new Error(`expected a start, got ${result.code}: ${result.message}`);
}

/**
 * Call a probe in an isolated child.
 *
 * @param host - A started host.
 * @param name - The probe.
 * @param args - Its arguments.
 */
export async function probe(
  host: IsolatedExtensionHost,
  name: string,
  ...args: unknown[]
): Promise<ProbeReport> {
  return (await host.probe(name, ...args)) as ProbeReport;
}

/** The control runner: plain Node, the real modules, no flags, no guard. */
const CONTROL_RUNNER = `
const probes = require(process.argv[2]).probes;
process.on('message', async ({ name, args }) => {
  const result = await probes[name](...args);
  process.send(result, () => process.exit(0));
});
`;

/**
 * Run a probe in an unrestricted control process: the same bundle under plain
 * Node, so a refusal test is paired with proof the probe can succeed.
 *
 * @param h - The harness.
 * @param name - The probe.
 * @param args - Its arguments.
 */
export async function runControl(
  h: Harness,
  name: string,
  ...args: unknown[]
): Promise<ProbeReport> {
  const runner = path.join(h.tmp, 'control-runner.cjs');
  await fs.writeFile(runner, CONTROL_RUNNER);
  const child = fork(runner, [h.bundle], {
    execArgv: [],
    env: { PATH: process.env.PATH ?? '', HOME: h.tmp },
    stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
  });
  h.controls.push(child);
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`control probe ${name} timed out`));
    }, 10_000);
    child.once('message', (result) => {
      clearTimeout(timer);
      resolve(result as ProbeReport);
    });
    child.once('error', reject);
    child.send({ name, args });
  });
}

/** A TCP server on 127.0.0.1 that counts the connections it accepts. */
export interface CountingServer {
  port: number;
  count: () => number;
}

/**
 * Start a counting TCP server (tracked for cleanup).
 *
 * @param h - The harness.
 */
export async function countingServer(h: Harness): Promise<CountingServer> {
  let accepted = 0;
  const server = net.createServer((socket) => {
    accepted++;
    h.sockets.add(socket);
    socket.on('close', () => h.sockets.delete(socket));
    socket.on('error', () => {});
    socket.end('HTTP/1.1 200 OK\r\ncontent-length: 0\r\nconnection: close\r\n\r\n');
  });
  h.servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as net.AddressInfo).port;
  return { port, count: () => accepted };
}

/**
 * Stop every child, control process and server a suite started, then remove
 * the temp folder. Only processes this harness started are ever signalled.
 *
 * @param h - The harness.
 */
export async function cleanup(h: Harness): Promise<void> {
  await Promise.all(
    h.hosts.map(async (host) => {
      host.killNow();
      await host.stop();
    })
  );
  for (const child of h.controls) {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
  }
  for (const socket of h.sockets) socket.destroy();
  await Promise.all(h.servers.map((s) => new Promise((resolve) => s.close(resolve))));
  await fs.rm(h.tmp, { recursive: true, force: true });
}
