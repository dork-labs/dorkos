/** Exercise the real private guardian with local Node subjects and independent owner peers. */
import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import { fork } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { once } from 'node:events';
import { stat } from 'node:fs/promises';
import { resolve } from 'node:path';
import process from 'node:process';
import { createInterface } from 'node:readline';
import test from 'node:test';
import { witnessObservation } from './witness-reporter.mjs';
import { fileURLToPath, URL } from 'node:url';
import { launchWindowsGuardianFromPort } from '../../../src/run-custody/windows/guardian.mjs';
import { stopWindowsGuardianFromPort } from '../../../src/run-custody/windows/guardian-timing.mjs';

const ownerFixture = fileURLToPath(new URL('./owner-attempt-witness.mjs', import.meta.url));

function environment() {
  return Object.fromEntries(
    Object.entries(process.env).filter(([name]) => /^(systemroot|windir|temp|tmp)$/i.test(name))
  );
}

function owner(binding, role, capability) {
  const child = fork(ownerFixture, ['--owner-peer'], {
    env: environment(),
    execArgv: [],
    serialization: 'advanced',
    stdio: ['ignore', 'ignore', 'inherit', 'ipc'],
  });
  const closed = once(child, 'close');
  void closed.catch(() => undefined);
  const copy = Buffer.from(capability);
  child.send({ ...binding, role, capability: copy }, (error) => {
    copy.fill(0);
    if (error) child.emit('error', error);
  });
  return { child, closed };
}

async function within(promise, signal) {
  signal.throwIfAborted();
  const stop = new globalThis.AbortController();
  try {
    return await Promise.race([
      promise,
      once(signal, 'abort', { signal: stop.signal }).then(() => {
        throw signal.reason;
      }),
    ]);
  } finally {
    stop.abort();
  }
}

const subject = [
  "console.log('fixture ready', process.argv[1]);",
  "console.error('fixture diagnostic');",
  "process.stdin.setEncoding('utf8');",
  "process.stdin.on('data', chunk => process.stdout.write(chunk));",
  "process.stdin.on('end', () => { process.exitCode = 37; });",
].join('\n');

async function verify(scenario, context) {
  const { signal } = context;
  const observed = { ownerExits: [] };
  assert.equal(process.platform, 'win32');
  const binding = {
    scopeId: randomBytes(16).toString('hex'),
    attemptId: randomBytes(16).toString('hex'),
    mainCapability: randomBytes(32),
    scopeCapability: randomBytes(32),
  };
  const request = {
    executable: process.execPath,
    cwd: process.cwd(),
    deadline: Date.now() + 10_000,
    argv: ['-e', subject, '--', 'one "quoted" argument'],
    env: environment(),
    stdio: { stdin: 'pipe', stdout: 'pipe', stderr: 'pipe' },
  };
  if (scenario === 'spawn-failed') {
    request.executable = resolve('windows-guardian-absent-target.exe');
    await assert.rejects(stat(request.executable), { code: 'ENOENT' });
  }
  const native = launchWindowsGuardianFromPort({
    helper: resolve('windows-guardian-witness.exe'),
    request,
    binding,
  });
  const peers = [];
  const stdout = createInterface({ input: native.stdout });
  const lines = stdout[Symbol.asyncIterator]();
  let stderr = '';
  let sawDiagnostic;
  const diagnostic = new Promise((resolve) => {
    sawDiagnostic = resolve;
  });
  native.stderr.setEncoding('utf8').on('data', (chunk) => {
    stderr += chunk;
    if (stderr.includes('fixture diagnostic')) sawDiagnostic();
  });
  const outputClosed = once(native.stdout, 'end');
  const errorClosed = once(native.stderr, 'end');

  try {
    observed.ready = await within(native.ready, signal);
    assert.equal(observed.ready, true);
    if (scenario === 'stop-before-admission') {
      const terminal = await within(native.stop(), signal);
      observed.terminal = terminal;
      assert.deepEqual(
        { outcome: terminal.outcome, acquired: terminal.acquired, joined: terminal.joined },
        { outcome: 'stopped', acquired: false, joined: false }
      );
      const identity = await within(native.spawned, signal);
      assert.equal(identity, undefined);
      observed.target = null;
      assert.deepEqual(await within(lines.next(), signal), { value: undefined, done: true });
    } else {
      const { scopeId, attemptId } = binding;
      peers.push(owner({ scopeId, attemptId }, 'main', binding.mainCapability));
      peers.push(owner({ scopeId, attemptId }, 'scope', binding.scopeCapability));
      const identity = await within(native.spawned, signal);
      observed.target = identity ?? null;
      if (scenario === 'spawn-failed') {
        assert.equal(identity, undefined);
        const terminal = await within(native.terminal, signal);
        observed.terminal = terminal;
        assert.equal(terminal.outcome, 'spawn-failed');
        assert.equal(terminal.acquired, false);
        assert.equal(terminal.cleanupError, 0);
        assert.equal(terminal.code, null);
        assert.equal(terminal.error, 2);
      } else {
        assert.ok(
          Number.isSafeInteger(identity?.pid) && identity.pid > 0 && identity.pid !== process.pid
        );
        assert.equal(identity.executable, request.executable);
        assert.deepEqual(await within(lines.next(), signal), {
          value: 'fixture ready one "quoted" argument',
          done: false,
        });
        if (scenario === 'stop-after-resume') {
          await within(diagnostic, signal);
          assert.ok(
            peers.every(({ child }) => child.exitCode === null && child.signalCode === null)
          );
          const stopped = await within(
            stopWindowsGuardianFromPort({
              deadline: Date.now() + 5000,
              async waitForOrdinaryStop() {
                native.stdin.write('fixture ordinary stop\n');
                assert.deepEqual(await within(lines.next(), signal), {
                  value: 'fixture ordinary stop',
                  done: false,
                });
              },
              requestNativeStop(waitMs) {
                const pending = native.stop(waitMs);
                assert.equal(native.stop(waitMs), pending);
                return pending;
              },
            }),
            signal
          );
          assert.equal(stopped.ordinary.kind, 'finished');
          assert.equal(stopped.native.kind, 'reported');
          const terminal = stopped.native.result;
          observed.ordinary = stopped.ordinary.kind;
          observed.terminal = terminal;
          assert.deepEqual(terminal, {
            kind: 'terminal',
            outcome: 'stopped',
            acquired: true,
            resumed: true,
            joined: true,
            error: 0,
            cleanupError: 0,
            code: 1223,
          });
        } else {
          native.stdin.end('fixture input\n');
          assert.deepEqual(await within(lines.next(), signal), {
            value: 'fixture input',
            done: false,
          });
          const terminal = await within(native.terminal, signal);
          observed.terminal = terminal;
          assert.deepEqual(terminal, {
            kind: 'terminal',
            outcome: 'completed',
            acquired: true,
            resumed: true,
            joined: true,
            error: 0,
            cleanupError: 0,
            code: 37,
          });
        }
        await within(errorClosed, signal);
        assert.equal(stderr.trim(), 'fixture diagnostic');
      }
      for (const { closed } of peers) {
        const actual = await within(closed, signal);
        observed.ownerExits.push(actual);
        assert.deepEqual(actual, [0, null]);
      }
    }
    await within(outputClosed, signal);
    observed.stdoutClosed = true;
  } finally {
    witnessObservation(context, observed);
    binding.mainCapability.fill(0);
    binding.scopeCapability.fill(0);
    stdout.close();
    native.stdin.destroy();
    await within(native.stop(), globalThis.AbortSignal.timeout(6_000)).catch(() => undefined);
    for (const { child, closed } of peers) {
      if (child.exitCode === null && child.signalCode === null) child.kill();
      await within(closed, globalThis.AbortSignal.timeout(5_000));
    }
  }
}

for (const scenario of [
  'normal-stdio-exit',
  'spawn-failed',
  'stop-before-admission',
  'stop-after-resume',
]) {
  test(`Windows private guardian launcher: ${scenario}`, { timeout: 30_000 }, (context) =>
    verify(scenario, context)
  );
}
