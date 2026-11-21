/** Exercise the Windows guardian fixture with two real, separately owned Node peers. */
import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import { fork, spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { once } from 'node:events';
import { createConnection } from 'node:net';
import { resolve } from 'node:path';
import process from 'node:process';
import { createInterface } from 'node:readline';
import { test } from 'node:test';
import { witnessObservation } from './witness-reporter.mjs';
import { fileURLToPath } from 'node:url';
import {
  createOwnerAttemptPeer,
  OWNER_FRAME_BYTES,
} from '../../../src/run-custody/windows/owner-attempt.mjs';

async function runOwner() {
  const lifetime = new globalThis.AbortController();
  process.once('disconnect', () => lifetime.abort());
  if (!process.connected) return;

  const [binding] = await once(process, 'message', { signal: lifetime.signal });
  const capability = binding.capability;
  const owner = createOwnerAttemptPeer({ ...binding, capability });
  capability.fill(0);
  const path = `\\\\.\\pipe\\dorkos-run-custody-${binding.scopeId}-${binding.role}`;
  const socket = createConnection(path);
  lifetime.signal.addEventListener('abort', () => socket.destroy(), { once: true });
  socket.on('error', (error) => {
    if (error.code === 'EPIPE' || error.code === 'ECONNRESET') socket.destroy();
    else throw error;
  });
  socket.once('close', () => {
    owner.dispose();
    if (process.connected) process.disconnect();
  });
  process.on('message', (step) => {
    if (step === 'exit-owner') process.exit(0);
    throw new Error('Unexpected owner witness instruction');
  });

  const frame = Buffer.alloc(OWNER_FRAME_BYTES);
  let bytes = 0;
  let altered = false;
  socket.on('data', (chunk) => {
    let offset = 0;
    while (offset < chunk.length) {
      const count = Math.min(OWNER_FRAME_BYTES - bytes, chunk.length - offset);
      chunk.copy(frame, bytes, offset, offset + count);
      bytes += count;
      offset += count;
      if (bytes !== OWNER_FRAME_BYTES) continue;
      const result = owner.accept(frame);
      bytes = 0;
      if (result.kind !== 'response') continue;
      if (binding.invalidFirstResponse && !altered) {
        result.frame[OWNER_FRAME_BYTES - 1] ^= 1;
        altered = true;
      }
      socket.write(result.frame);
    }
  });
}

function track(child) {
  const closed = once(child, 'close');
  void closed.catch(() => undefined);
  return { child, closed };
}

async function within(promise, signal) {
  signal.throwIfAborted();
  const abort = new globalThis.AbortController();
  try {
    return await Promise.race([
      promise,
      once(signal, 'abort', { signal: abort.signal }).then(() => {
        throw signal.reason;
      }),
    ]);
  } finally {
    abort.abort();
  }
}

async function closePeer({ child, closed }) {
  if (child.exitCode === null && child.signalCode === null) child.kill();
  await within(closed, globalThis.AbortSignal.timeout(5000));
}

function fixtureEnvironment() {
  return Object.fromEntries(
    Object.entries(process.env).filter(([name]) => /^(systemroot|windir|temp|tmp)$/i.test(name))
  );
}

function startOwner(binding, role, capability, peers, invalidFirstResponse) {
  const peer = track(
    fork(fileURLToPath(import.meta.url), ['--owner-peer'], {
      execArgv: [],
      env: fixtureEnvironment(),
      stdio: ['ignore', 'inherit', 'inherit', 'ipc'],
      serialization: 'advanced',
    })
  );
  peers.push(peer);
  const copy = Buffer.from(capability);
  peer.child.send({ ...binding, role, capability: copy, invalidFirstResponse }, (error) => {
    copy.fill(0);
    if (error) peer.child.emit('error', error);
  });
  return peer;
}

async function runFixture(scenario, context) {
  const { signal } = context;
  const observed = { markers: [], ownerExits: [], target: null };
  assert.equal(process.platform, 'win32');
  const scope = randomBytes(16);
  const attempt = randomBytes(16);
  const mainKey = randomBytes(32);
  const scopeKey = randomBytes(32);
  const binding = { scopeId: scope.toString('hex'), attemptId: attempt.toString('hex') };
  const native = track(
    spawn(resolve('owner-attempt-witness.exe'), scenario.args ?? [], {
      shell: false,
      env: fixtureEnvironment(),
      stdio: ['pipe', 'pipe', 'inherit'],
    })
  );
  const peers = [native];
  const output = createInterface({ input: native.child.stdout });
  const lines = output[Symbol.asyncIterator]();
  const failures = [];
  async function expectLine(expected) {
    const actual = await within(lines.next(), signal);
    if (!actual.done) observed.markers.push(actual.value);
    assert.deepEqual(actual, { value: expected, done: false });
  }

  try {
    await within(
      new Promise((resolve, reject) => {
        const bytes = Buffer.concat([scope, attempt, mainKey, scopeKey]);
        native.child.stdin.write(bytes, (error) => {
          bytes.fill(0);
          if (error) reject(error);
          else resolve();
        });
      }),
      signal
    );
    await expectLine('ready');
    const main = startOwner(binding, 'main', mainKey, peers, scenario.wrongProof);
    const worker = startOwner(binding, 'scope', scopeKey, peers, false);
    async function loseOwner() {
      const [lost, remaining] = scenario.role === 'main' ? [main, worker] : [worker, main];
      assert.equal(remaining.child.exitCode, null);
      assert.equal(remaining.child.signalCode, null);
      lost.child.send('exit-owner');
      assert.deepEqual(await within(lost.closed, signal), [0, null]);
    }

    if (!scenario.wrongProof) {
      await expectLine('prepared');
      if (scenario.beforeResume) await loseOwner();
      native.child.stdin.end('g');
      if (scenario.liveMarker) {
        await expectLine(scenario.liveMarker);
        await loseOwner();
      }
      const { value, done } = await within(lines.next(), signal);
      assert.equal(done, false);
      assert.match(value, /^joined [1-9]\d* [0-4] [01] \d+ \d+ \d+$/);
      const [pid, end, resumed, code, error, cleanupError] = value.slice(7).split(' ').map(Number);
      observed.target = {
        pid,
        end,
        resumed: resumed === 1,
        code,
        error,
        cleanupError,
        joined: true,
      };
    }
    await expectLine(scenario.terminal);
    await expectLine('closed');
    observed.fixtureExit = await within(native.closed, signal);
    assert.deepEqual(observed.fixtureExit, [0, null]);
    for (const owner of [main, worker]) {
      const actual = await within(owner.closed, signal);
      observed.ownerExits.push(actual);
      assert.deepEqual(actual, [0, null]);
    }
  } catch (error) {
    failures.push(error);
  } finally {
    mainKey.fill(0);
    scopeKey.fill(0);
    native.child.stdin.destroy();
    output.close();
    const closures = await Promise.allSettled(peers.map(closePeer));
    for (const result of closures) if (result.status === 'rejected') failures.push(result.reason);
    witnessObservation(context, observed);
  }
  if (failures.length === 1) throw failures[0];
  if (failures.length > 1)
    throw new AggregateError(failures, 'Windows owner attempt witness failed');
}

if (process.argv[2] === '--owner-peer') {
  await runOwner();
} else {
  const scenarios = [
    { name: 'live-owners', terminal: 'resumed' },
    { name: 'wrong-proof', wrongProof: true, terminal: 'admission-refused' },
    {
      name: 'main-lost',
      role: 'main',
      beforeResume: true,
      terminal: 'owner-lost-before-resume',
    },
    {
      name: 'scope-lost',
      role: 'scope',
      beforeResume: true,
      terminal: 'owner-lost-before-resume',
    },
    {
      name: 'main-lost-after-resume',
      args: ['--hold-target'],
      role: 'main',
      liveMarker: 'target-running',
      terminal: 'main-owner-closed',
    },
    {
      name: 'scope-lost-after-resume',
      args: ['--hold-target'],
      role: 'scope',
      liveMarker: 'target-running',
      terminal: 'scope-owner-closed',
    },
    {
      name: 'main-lost-with-descendant-after-leader-exit',
      args: ['--hold-descendant'],
      role: 'main',
      liveMarker: 'descendant-running-after-leader-exit',
      terminal: 'main-owner-closed',
    },
  ];
  for (const scenario of scenarios) {
    test(`Windows owner attempt: ${scenario.name}`, { timeout: 40_000 }, (context) =>
      runFixture(scenario, context)
    );
  }
}
