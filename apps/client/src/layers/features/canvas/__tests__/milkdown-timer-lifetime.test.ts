// @vitest-environment node
import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { afterEach, expect, it } from 'vitest';

// Select the real nearest editor dependencies without importing the browser editor.
function nearestPackage(importer: string, name: string): string {
  for (let directory = dirname(importer); ; directory = dirname(directory)) {
    const candidate = join(directory, 'node_modules', name, 'package.json');
    if (existsSync(candidate)) return realpathSync(candidate);
    if (dirname(directory) === directory) throw new Error(`Missing nearest ${name}`);
  }
}
function importEntry(packageFile: string, key: string): string {
  const metadata = JSON.parse(readFileSync(packageFile, 'utf8'));
  const entry = metadata.exports[key];
  const selected = typeof entry === 'string' ? entry : entry?.import;
  if (typeof selected !== 'string' || !selected.startsWith('./')) {
    throw new Error(`Missing public import ${metadata.name}${key}`);
  }
  return realpathSync(resolve(dirname(packageFile), selected));
}
const blintzEntry = importEntry(nearestPackage(fileURLToPath(import.meta.url), 'blintz'), '.');
const kitEntry = importEntry(nearestPackage(blintzEntry, '@milkdown/kit'), './ctx');
const ctxPackage = nearestPackage(kitEntry, '@milkdown/ctx');
const ctxEntry = importEntry(ctxPackage, '.');
expect(JSON.parse(readFileSync(ctxPackage, 'utf8')).version).toBe('7.22.1');
const endpointPrelude = `const KIT_ENDPOINT = ${JSON.stringify(pathToFileURL(kitEntry).href)};
const CTX_ENDPOINT = ${JSON.stringify(pathToFileURL(ctxEntry).href)};
`;

const ownedChildren = new Set<{ child: ChildProcess; settled: Promise<unknown> }>();
async function nativeRealm(script: string) {
  const child = spawn(process.execPath, ['--input-type=module', '-e', endpointPrelude + script], {
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let firstCaptureError: Error | undefined;
  async function capture(stream: NonNullable<typeof child.stdout>): Promise<string> {
    const chunks: Buffer[] = [];
    let bytes = 0;
    try {
      for await (const chunk of stream) {
        const block = Buffer.from(chunk);
        bytes += block.length;
        if (bytes > 65536) {
          firstCaptureError ??= new Error('Owned timer child output exceeded 64 KiB');
          child.kill('SIGTERM');
        } else if (!firstCaptureError) chunks.push(block);
      }
    } catch (cause) {
      child.kill('SIGTERM');
      throw cause;
    }
    return Buffer.concat(chunks).toString('utf8');
  }
  const exit = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(
    (resolve, reject) => {
      child.once('error', reject);
      child.once('exit', (code, signal) => resolve({ code, signal }));
    }
  );
  // Drain both genuine pipes through EOF and join direct exit even on failure.
  const settled = Promise.allSettled([exit, capture(child.stdout!), capture(child.stderr!)]).then(
    (records) => {
      for (const record of records) if (record.status === 'rejected') throw record.reason;
      if (firstCaptureError) throw firstCaptureError;
      const [exited, stdout, stderr] = records as [
        PromiseFulfilledResult<{ code: number | null; signal: NodeJS.Signals | null }>,
        PromiseFulfilledResult<string>,
        PromiseFulfilledResult<string>,
      ];
      return { ...exited.value, stdout: stdout.value, stderr: stderr.value };
    }
  );
  ownedChildren.add({ child, settled });
  return settled;
}
afterEach(async () => {
  // The original default body/hook deadlines remain unchanged. A failed body
  // cannot abandon its genuine isolated child or either capture pipe.
  const owners = [...ownedChildren];
  for (const owner of owners) {
    if (owner.child.exitCode === null && owner.child.signalCode === null)
      owner.child.kill('SIGTERM');
  }
  let settlements: PromiseSettledResult<unknown>[];
  try {
    settlements = await Promise.allSettled(owners.map((owner) => owner.settled));
  } finally {
    for (const owner of owners) ownedChildren.delete(owner);
  }
  const firstFailure = settlements.find((record) => record.status === 'rejected');
  if (firstFailure?.status === 'rejected') throw firstFailure.reason;
});

it('releases a resolved editor timer before its native event realm is removed', async () => {
  const result = await nativeRealm(String.raw`import assert from 'node:assert/strict';
import { createHook } from 'node:async_hooks';
import { performance } from 'node:perf_hooks';
const kit = await import(KIT_ENDPOINT);
const ctx = await import(CTX_ENDPOINT);
assert.equal(kit.Timer, ctx.Timer);
assert.equal(kit.createTimer, ctx.createTimer);
const { Timer, createTimer } = kit;

assert.equal(Number(process.versions.node.split('.')[0]), 24);
const NativeCustomEvent = globalThis.CustomEvent;
assert.equal(typeof NativeCustomEvent, 'function');
const realm = new EventTarget();
// Actual native event operations; no event, timer, rejection or error substitutes.
const ownedGlobals = {
  addEventListener: realm.addEventListener.bind(realm),
  removeEventListener: realm.removeEventListener.bind(realm),
  dispatchEvent: realm.dispatchEvent.bind(realm),
  CustomEvent: NativeCustomEvent,
};
for (const [name, value] of Object.entries(ownedGlobals)) {
  Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
}
const clock = new Map();
const type = createTimer('owned-realm-resolved-timer-regression');
assert.equal(type.timeout, 3000);
const timer = new Timer(clock, type);
assert.equal(clock.get(type.id), timer);
let starting = false;
const ownedTimeoutIds = new Set();
const destroyedTimeoutIds = new Set();
const resourceObservation = createHook({
  init(id, kind) { if (starting && kind === 'Timeout') ownedTimeoutIds.add(id); },
  destroy(id) { if (ownedTimeoutIds.has(id)) destroyedTimeoutIds.add(id); },
});
resourceObservation.enable();
const nativeStart = performance.now();
starting = true;
const resolved = timer.start();
starting = false;
assert.equal(ownedTimeoutIds.size, 1);
assert.equal(timer.status, 'pending');
timer.done();
await resolved;
assert.equal(timer.status, 'resolved');
assert.equal(timer.start(), resolved);
// Genuine repeated event reaches a native later listener only if Timer released its listener.
let laterEventCount = 0;
const laterListener = () => { laterEventCount += 1; };
realm.addEventListener(type.name, laterListener);
timer.done();
assert.equal(laterEventCount, 1);
realm.removeEventListener(type.name, laterListener);
await new Promise((resolve) => setImmediate(resolve));
const sampledElapsed = performance.now() - nativeStart;
assert.equal(Number.isFinite(sampledElapsed) && sampledElapsed >= 0 && sampledElapsed < type.timeout, true, 'Resource sample must precede the genuine original deadline');
const disposedBeforeOriginalDeadline = [...ownedTimeoutIds].every((id) => destroyedTimeoutIds.has(id));
process.stdout.write('REAL_TIMER_RESOLVED defaultTimeout=3000 listenerReleased=1\n');
// Simulate teardown of the event realm only after the real resolution.
for (const [name, value] of Object.entries(ownedGlobals)) {
  assert.equal(globalThis[name], value);
  assert.equal(Reflect.deleteProperty(globalThis, name), true);
  assert.equal(Object.hasOwn(globalThis, name), false);
}
process.stdout.write('OWNED_EVENT_REALM_REMOVED\n');
// Keep this otherwise idle native child alive beyond the original timeout.
// Original ctx throws uncaught removeEventListener ReferenceError around 3s.
// A correct lifecycle cleanup reaches this sentinel with no late callback.
await new Promise((resolve) => setTimeout(resolve, type.timeout + 100));
assert.equal(timer.status, 'resolved');
assert.equal(disposedBeforeOriginalDeadline, true, 'Resolved Timer must dispose its native timeout before the original deadline');
resourceObservation.disable();
process.stdout.write('REAL_TIMER_NO_LATE_CALLBACK\n');
`);
  expect(result.signal).toBeNull();
  expect(result.code, result.stderr).toBe(0);
  expect(result.stderr).toBe('');
  expect(result.stdout).toContain('REAL_TIMER_NO_LATE_CALLBACK');
});

it('retains the default pending timeout rejection and releases its native resources', async () => {
  const result = await nativeRealm(String.raw`import assert from 'node:assert/strict';
import { createHook } from 'node:async_hooks';
const kit = await import(KIT_ENDPOINT);
const ctx = await import(CTX_ENDPOINT);
assert.equal(kit.Timer, ctx.Timer);
assert.equal(kit.createTimer, ctx.createTimer);
const { Timer, createTimer } = kit;
assert.equal(Number(process.versions.node.split('.')[0]), 24);
const realm = new EventTarget();
const NativeCustomEvent = globalThis.CustomEvent;
assert.equal(typeof NativeCustomEvent, 'function');
const ownedGlobals = { addEventListener: realm.addEventListener.bind(realm), removeEventListener: realm.removeEventListener.bind(realm), dispatchEvent: realm.dispatchEvent.bind(realm), CustomEvent: NativeCustomEvent };
for (const [name, value] of Object.entries(ownedGlobals)) Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
const type = createTimer('owned-realm-pending-default-expiry-control');
assert.equal(type.timeout, 3000);
const clock = new Map();
const timer = new Timer(clock, type);
assert.equal(clock.get(type.id), timer);
let starting = false;
const ownedTimeoutIds = new Set();
const destroyedTimeoutIds = new Set();
const observation = createHook({ init(id, kind) { if (starting && kind === 'Timeout') ownedTimeoutIds.add(id); }, destroy(id) { if (ownedTimeoutIds.has(id)) destroyedTimeoutIds.add(id); } });
observation.enable();
starting = true;
const waiting = timer.start();
starting = false;
assert.equal(ownedTimeoutIds.size, 1);
assert.equal(timer.status, 'pending');
assert.equal(timer.start(), waiting);
// Handle only the actual expected Promise rejection; no uncaught-error handler.
await assert.rejects(waiting, { name: 'Error', message: 'Timing ' + type.name + ' timeout.' });
assert.equal(timer.status, 'rejected');
assert.equal(timer.start(), waiting);
// A repeated genuine done reaches a later native listener if the expired listener is detached.
let laterEvents = 0;
const laterListener = () => { laterEvents += 1; };
realm.addEventListener(type.name, laterListener);
timer.done();
assert.equal(laterEvents, 1);
assert.equal(timer.status, 'rejected');
realm.removeEventListener(type.name, laterListener);
await new Promise((resolve) => setImmediate(resolve));
assert.equal([...ownedTimeoutIds].every((id) => destroyedTimeoutIds.has(id)), true);
observation.disable();
for (const [name, value] of Object.entries(ownedGlobals)) { assert.equal(globalThis[name], value); assert.equal(Reflect.deleteProperty(globalThis, name), true); }
process.stdout.write('REAL_PENDING_TIMER_DEFAULT_REJECTED timeout=3000 listenerReleased=1 nativeTimeoutDestroyed=1\n');
`);
  expect(result.signal).toBeNull();
  expect(result.code, result.stderr).toBe(0);
  expect(result.stderr).toBe('');
  expect(result.stdout).toContain(
    'REAL_PENDING_TIMER_DEFAULT_REJECTED timeout=3000 listenerReleased=1 nativeTimeoutDestroyed=1'
  );
});
