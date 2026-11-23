import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import { Readable } from 'node:stream';
import test from 'node:test';
import {
  encodeGuardianRequest,
  readGuardianReports,
} from '../../../src/run-custody/windows/guardian-protocol.mjs';

const binding = {
  scopeId: 'a'.repeat(32),
  attemptId: 'b'.repeat(32),
  mainCapability: Buffer.alloc(32, 1),
  scopeCapability: Buffer.alloc(32, 2),
};
const request = {
  executable: 'C:\\Program Files\\local-fixture.exe',
  cwd: 'C:\\fixture',
  argv: ['', 'two words', 'one"quote', 'ends in slash\\', 'emoji 🚀'],
  env: { PATH: 'C:\\fixture', Path: 'ignored duplicate', ZERO: '', MISSING: undefined },
  stdio: { stdin: 'pipe', stdout: 'inherit', stderr: 'ignore' },
};

function report(kind, values = {}) {
  const { outcome = 0, flags = 0, pid = 0, error = 0, cleanupError = 0, code = 0 } = values;
  const frame = Buffer.alloc(32);
  frame.write('DGR1', 'ascii');
  [kind, outcome, flags, pid, error, cleanupError, code].forEach((word, index) => {
    frame.writeUInt32LE(word, 4 + index * 4);
  });
  return frame;
}

function read(chunks, events = []) {
  return readGuardianReports(Readable.from(chunks), {
    ready: () => events.push('ready'),
    spawned: (pid) => events.push(pid),
  });
}

test('bootstrap keeps the resolved executable, CRT arguments and explicit environment', () => {
  const frame = encodeGuardianRequest(request, binding, 5);
  assert.equal(frame.toString('ascii', 0, 4), 'DKG1');
  assert.equal(frame.readUInt32LE(4), 5);
  assert.equal(frame.readUInt32LE(8), 3);
  assert.equal(frame.subarray(28, 44).toString('hex'), binding.scopeId);
  assert.equal(frame.subarray(44, 60).toString('hex'), binding.attemptId);
  assert.deepEqual(frame.subarray(60, 92), binding.mainCapability);
  assert.deepEqual(frame.subarray(92, 124), binding.scopeCapability);
  let offset = 124;
  const values = [];
  for (let field = 12; field < 28; field += 4) {
    const end = offset + frame.readUInt32LE(field) * 2;
    values.push(frame.toString('utf16le', offset, end));
    offset = end;
  }
  assert.equal(offset, frame.length);
  assert.deepEqual(values, [
    request.executable + '\0',
    request.cwd + '\0',
    '"C:\\Program Files\\local-fixture.exe" "" "two words" "one\\"quote" "ends in slash\\\\" "emoji 🚀"\0',
    'PATH=C:\\fixture\0ZERO=\0\0',
  ]);
});

test('bootstrap rejects an unqualified drive path and malformed request values', () => {
  assert.throws(() => encodeGuardianRequest({ ...request, cwd: 'C:fixture' }, binding, 5));
  assert.throws(() => encodeGuardianRequest({ ...request, argv: ['bad\0arg'] }, binding, 5));
  assert.throws(() => encodeGuardianRequest(request, binding, 0));
  assert.throws(() =>
    encodeGuardianRequest(request, { ...binding, scopeCapability: binding.mainCapability }, 5)
  );
  assert.throws(() =>
    encodeGuardianRequest({ ...request, argv: ['x'.repeat(32_767)] }, binding, 5)
  );
});

test('fragmented native reports preserve observed identity and independently observed closure', async () => {
  const events = [];
  const frame = Buffer.concat([
    report(1),
    report(2, { pid: 91 }),
    report(3, { outcome: 3, flags: 7, code: 37 }),
  ]);
  const chunks = [
    frame.subarray(0, 1),
    frame.subarray(1, 36),
    frame.subarray(36, 73),
    frame.subarray(73),
  ];
  assert.deepEqual(await read(chunks, events), {
    kind: 'terminal',
    outcome: 'completed',
    acquired: true,
    resumed: true,
    joined: true,
    error: 0,
    cleanupError: 0,
    code: 37,
  });
  assert.deepEqual(events, ['ready', 91]);
});

test('explicit stop before acquisition reports no target and no exit code', async () => {
  const result = await read([report(1), report(3, { outcome: 4, error: 1223 })]);
  assert.equal(result.outcome, 'stopped');
  assert.equal(result.acquired, false);
  assert.equal(result.joined, false);
  assert.equal(result.code, null);
});

test('native failure retains separate primary and cleanup errors', async () => {
  const result = await read([
    report(1),
    report(2, { pid: 5 }),
    report(3, { outcome: 7, flags: 3, error: 13, cleanupError: 1460 }),
  ]);
  assert.equal(result.error, 13);
  assert.equal(result.cleanupError, 1460);
  assert.equal(result.joined, false);
  assert.equal(result.code, null);
});

test('EOF, partial and contradictory terminal reports cannot confirm cleanup', async () => {
  const done = report(3, { outcome: 3, flags: 7, code: 37 });
  await assert.rejects(read([report(1)]), /without a terminal report/);
  await assert.rejects(read([report(1), done]), /Out-of-order/);
  await assert.rejects(
    read([report(1), report(2, { pid: 1 }), done.subarray(0, 31)]),
    /without a terminal report/
  );
  await assert.rejects(read([report(3, { outcome: 1, flags: 4 })]), /Inconsistent/);
  await assert.rejects(read([report(1), report(2, { pid: 1 }), done, report(1)]), /Data after/);
});
