/** Drive the Windows pipe witness with independently owned Node connections. */
import assert from 'node:assert/strict';
import { fork, spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { once } from 'node:events';
import { createConnection } from 'node:net';
import { resolve } from 'node:path';
import process from 'node:process';
import { createInterface } from 'node:readline';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

async function connectOwner(scopeId, role, firstByte, signal) {
  assert.match(scopeId, /^[a-f0-9]{32}$/);
  const path = `\\\\.\\pipe\\dorkos-run-custody-${scopeId}-${role}`;
  signal.throwIfAborted();
  const socket = createConnection(path);
  const close = () => socket.destroy();
  signal.addEventListener('abort', close, { once: true });
  socket.once('close', () => signal.removeEventListener('abort', close));
  try {
    await once(socket, 'connect', { signal });
    socket.write(firstByte);
    return socket;
  } catch (error) {
    socket.destroy();
    throw error;
  }
}

async function scopePeer(scopeId) {
  const owner = new globalThis.AbortController();
  process.once('disconnect', () => owner.abort());
  if (!process.connected) owner.abort();
  let socket;
  try {
    socket = await connectOwner(scopeId, 'scope', 's', owner.signal);
  } catch (error) {
    if (owner.signal.aborted) return;
    throw error;
  }
  process.on('message', (step) => {
    if (step === 'confirm-live') socket.write('r');
    else if (step === 'close-owner') process.exit(0);
    else throw new Error('Unexpected scope witness step');
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

if (process.argv[2] === '--scope-peer') {
  await scopePeer(process.argv[3]);
} else {
  test(
    'observes two protected Windows owner pipes independently',
    { timeout: 40_000 },
    async ({ signal }) => {
      assert.equal(process.platform, 'win32');
      const scopeId = randomBytes(16).toString('hex');
      const native = track(
        spawn(resolve('owner-pipe-witness.exe'), [scopeId], {
          stdio: ['ignore', 'pipe', 'inherit'],
          shell: false,
        })
      );
      const peers = [native];
      const output = createInterface({ input: native.child.stdout });
      const lines = output[Symbol.asyncIterator]();
      async function expectLine(expected) {
        assert.deepEqual(await within(lines.next(), signal), { value: expected, done: false });
      }

      let main;
      const failures = [];
      try {
        await expectLine('ready');
        main = await connectOwner(scopeId, 'main', 'm', signal);
        const scope = track(
          fork(fileURLToPath(import.meta.url), ['--scope-peer', scopeId], {
            execArgv: [],
            stdio: ['ignore', 'inherit', 'inherit', 'ipc'],
          })
        );
        peers.push(scope);
        await expectLine('both-observed');
        main.destroy();
        await expectLine('main-closed');
        scope.child.send('confirm-live');
        await expectLine('scope-live');
        scope.child.send('close-owner');
        assert.deepEqual(await within(scope.closed, signal), [0, null]);
        await expectLine('closed');
        assert.deepEqual(await within(native.closed, signal), [0, null]);
      } catch (error) {
        failures.push(error);
      } finally {
        main?.destroy();
        output.close();
        const closures = await Promise.allSettled(peers.map(closePeer));
        for (const result of closures)
          if (result.status === 'rejected') failures.push(result.reason);
      }
      if (failures.length === 1) throw failures[0];
      if (failures.length > 1)
        throw new AggregateError(failures, 'Windows owner pipe witness failed');
    }
  );
}
