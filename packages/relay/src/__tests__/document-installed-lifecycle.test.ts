/** Actual configured CCA/bus/pool and native Node child controls; runtime transport is a paid-unarmed stub. */
import { afterEach, expect, it, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import { RelayCore } from '../relay-core.js';
import { AdapterRegistry } from '../adapter-registry.js';
import {
  ClaudeCodeAdapter,
  consumeInstalledDocumentAdapterOrigin,
  readOriginalInstalledDocumentAdapterOrigin,
} from '../adapters/claude-code/claude-code-adapter.js';
import type { AgentRuntimeLike } from '../adapters/claude-code/types.js';
import type { OriginalDocumentProcessReservation } from '../document-process-custody.js';
const owners: {
  registry: AdapterRegistry;
  bus: RelayCore;
  directory: string;
  children: OriginalDocumentProcessReservation[];
}[] = [];
afterEach(async () => {
  for (const own of owners) {
    // Start every captured physical drain before awaiting peers. A raw error is
    // drainable only when the original closure recognizer positively succeeds.
    const results = await Promise.allSettled(own.children.map((child) => child.drain()));
    for (let index = 0; index < results.length; index++) own.children[index]!.requireReleased();
    await own.registry.shutdown();
    await own.bus.close();
    await rm(own.directory, { recursive: true, force: true });
  }
  owners.length = 0;
});
async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), 'relay-original-installed-'));
  const registry = new AdapterRegistry();
  const { relay: bus } = RelayCore.createServerDocumentRelay({
    dataDir: directory,
    adapterRegistry: registry,
  });
  const own = { registry, bus, directory, children: [] as OriginalDocumentProcessReservation[] };
  owners.push(own);
  await bus.registerEndpoint('relay.system.lifecycle-control');
  const runtime: AgentRuntimeLike = {
    type: 'claude-code',
    ensureSession: vi.fn(),
    sendMessage: vi.fn(async function* () {
      throw new Error('No model/provider is armed');
    }),
    getSdkSessionId: () => undefined,
    approveTool: () => false,
    interruptQuery: vi.fn(),
  };
  const constructed = ClaudeCodeAdapter.createInstalledDocumentAdapter(
    'configured-claude',
    { maxConcurrent: 1, defaultCwd: directory },
    {
      agentManager: runtime,
      agentRuntimes: new Map([['claude-code', runtime]]),
      traceStore: { insertSpan: vi.fn(), updateSpan: vi.fn() },
      approvalAuthorizer: () => false,
    }
  );
  expect(readOriginalInstalledDocumentAdapterOrigin(constructed.adapter)).toBeUndefined();
  await registry.register(constructed.adapter);
  expect(readOriginalInstalledDocumentAdapterOrigin(constructed.adapter)).toBe(constructed.origin);
  const source = consumeInstalledDocumentAdapterOrigin(constructed.origin);
  const reserve = () => {
    const reservation = source.reserveDocumentProcess('claude-code');
    if (!reservation) throw new Error('Actual configured process slot unavailable');
    own.children.push(reservation);
    return reservation;
  };
  return { own, runtime, constructed, source, reserve };
}
const holdScript = "process.stdout.write('ready\\n');setInterval(()=>{},1000)";
async function childReady(reservation: OriginalDocumentProcessReservation) {
  const child = reservation.spawn({ command: process.execPath, args: ['-e', holdScript], env: {} });
  let exited = false,
    closed = false,
    stdinClosed = false,
    stdoutClosed = false,
    stderrClosed = false;
  child.once('exit', () => {
    exited = true;
  });
  child.once('close', () => {
    closed = true;
  });
  child.stdin.once('close', () => {
    stdinClosed = true;
  });
  child.stdout.once('close', () => {
    stdoutClosed = true;
  });
  child.stderr.once('close', () => {
    stderrClosed = true;
  });
  const [data] = await once(child.stdout, 'data');
  expect(String(data)).toBe('ready\n');
  return { child, physical: () => ({ exited, closed, stdinClosed, stdoutClosed, stderrClosed }) };
}
it('actual configured original CCA owns one nonwaiting pool slot and retires its original lookup on unregister', async () => {
  const { own, constructed, source, reserve, runtime } = await fixture();
  const held = reserve();
  expect(source.readRuntime('claude-code')).toBe(runtime);
  expect(source.readPoolCensus()).toEqual({ running: 1, waiting: 0 });
  expect(source.reserveDocumentProcess('claude-code')).toBeNull();
  expect(() => held.requireReleased()).toThrow('closure UNKNOWN');
  held.releaseNeverInvoked();
  held.requireReleased();
  expect(source.readPoolCensus()).toEqual({ running: 0, waiting: 0 });
  await own.registry.unregister(constructed.adapter.id);
  expect(readOriginalInstalledDocumentAdapterOrigin(constructed.adapter)).toBeUndefined();
  expect(() => source.reserveDocumentProcess('claude-code')).toThrow('ADAPTER_RETIRED');
  expect(runtime.ensureSession).not.toHaveBeenCalled();
  expect(runtime.sendMessage).not.toHaveBeenCalled();
});
it('captured original native cancellation reaches a held real child despite reflected kill replacement, then waits for exit and three pipes', async () => {
  const { source, reserve } = await fixture();
  const reservation = reserve();
  const { child, physical } = await childReady(reservation);
  expect(source.readPoolCensus()).toEqual({ running: 1, waiting: 0 });
  expect(() => reservation.requireReleased()).toThrow('closure UNKNOWN');
  const replacement = vi.fn(() => {
    throw new Error('Reflected kill must not certify or block original stop');
  });
  child.kill = replacement;
  const first = reservation.drain();
  expect(reservation.drain()).toBe(first);
  await first;
  reservation.requireReleased();
  expect(replacement).not.toHaveBeenCalled();
  expect(physical()).toEqual({
    exited: true,
    closed: true,
    stdinClosed: true,
    stdoutClosed: true,
    stderrClosed: true,
  });
  expect(child.signalCode).toBe('SIGTERM');
  expect(source.readPoolCensus()).toEqual({ running: 0, waiting: 0 });
});
it('actual failed executable start releases the configured pool only after original close and all pipes', async () => {
  const { own, source, reserve } = await fixture();
  const reservation = reserve();
  const child = reservation.spawn({
    command: join(own.directory, 'missing-executable'),
    args: [],
    env: {},
  });
  let closed = false,
    stdinClosed = false,
    stdoutClosed = false,
    stderrClosed = false;
  child.once('close', () => {
    closed = true;
  });
  child.stdin.once('close', () => {
    stdinClosed = true;
  });
  child.stdout.once('close', () => {
    stdoutClosed = true;
  });
  child.stderr.once('close', () => {
    stderrClosed = true;
  });
  expect(() => reservation.requireReleased()).toThrow('closure UNKNOWN');
  await expect(reservation.awaitPhysicalCloseAndRelease()).rejects.toMatchObject({
    code: 'ENOENT',
  });
  reservation.requireReleased();
  expect({ closed, stdinClosed, stdoutClosed, stderrClosed }).toEqual({
    closed: true,
    stdinClosed: true,
    stdoutClosed: true,
    stderrClosed: true,
  });
  expect(source.readPoolCensus()).toEqual({ running: 0, waiting: 0 });
});
it('actual adapter retirement refuses new work while the existing genuine child remains separately owned until original drain', async () => {
  const { own, constructed, source, reserve } = await fixture();
  const reservation = reserve();
  const { physical } = await childReady(reservation);
  await own.registry.unregister(constructed.adapter.id);
  expect(() => source.requireReady()).toThrow('ADAPTER_RETIRED');
  expect(() => reservation.requireReleased()).toThrow('closure UNKNOWN');
  await reservation.drain();
  reservation.requireReleased();
  expect(physical()).toEqual({
    exited: true,
    closed: true,
    stdinClosed: true,
    stdoutClosed: true,
    stderrClosed: true,
  });
});
