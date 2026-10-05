import test from 'node:test';
import assert from 'node:assert/strict';
import { preflight } from '../preflight.mjs';

const declarations = 'proc_pidinfo( proc_signal_with_audittoken( proc_terminate_with_audittoken(';
const symbols = '_proc_pidinfo _proc_signal_with_audittoken _proc_terminate_with_audittoken';
function fake(overrides = {}) {
  const calls = [];
  const removed = [];
  return {
    calls,
    removed,
    options: {
      platform: 'darwin',
      temporary: () => '/fake/private-build',
      remove: (path) => removed.push(path),
      read: (path) => {
        if (path.endsWith('libproc.h')) return declarations;
        if (path.endsWith('libproc.tbd')) return symbols;
        return 'source';
      },
      command: (tool, args) => {
        calls.push({ tool, args });
        assert.notEqual(tool, '/fake/private-build/fixture', 'must never execute helper');
        if (args.includes('--find')) return '/fake/clang';
        if (args.includes('--show-sdk-path')) return '/fake/sdk';
        return 'compiler';
      },
      ...overrides,
    },
  };
}

test('zero-subject preflight compiles/links with explicit SDK, never executes helper', () => {
  const f = fake();
  const receipt = preflight(f.options);
  assert.equal(receipt.build, 'compiled-linked-not-executed');
  assert.equal(receipt.nativeSubjects, 0);
  assert.equal(receipt.nativeSignals, 0);
  assert.equal(receipt.status, 'unverified');
  assert.equal(receipt.runtimeExports, 'unverified');
  assert.equal(receipt.kernelCorrespondence, 'unverified');
  const compile = f.calls.filter(
    (call) => call.tool === '/fake/clang' && !call.args.includes('--version')
  );
  assert.equal(compile.length, 4);
  for (const call of compile) assert.ok(call.args.includes('-isysroot'));
  assert.deepEqual(f.removed, ['/fake/private-build']);
});

test('missing compiler, SDK declaration and unsupported host remain zero-subject unverified', () => {
  for (const overrides of [
    { platform: 'linux' },
    {
      command() {
        throw Error('COMPILER_UNAVAILABLE');
      },
    },
    { read: () => 'missing' },
  ]) {
    const f = fake(overrides);
    const receipt = preflight(f.options);
    assert.equal(receipt.nativeSubjects, 0);
    assert.equal(receipt.status, 'unverified');
    assert.notEqual(receipt.build, 'compiled-linked-not-executed');
    assert.deepEqual(f.removed, []);
  }
});

test('compile/link failure and cleanup failure retain unverified outcomes', () => {
  const f = fake();
  const command = f.options.command;
  f.options.command = (tool, args) => {
    if (args.includes('-c')) throw Error('COMPILE_FAILED');
    return command(tool, args);
  };
  const receipt = preflight(f.options);
  assert.equal(receipt.reason, 'COMPILE_FAILED');
  assert.equal(receipt.build, 'unverified');
  assert.deepEqual(f.removed, ['/fake/private-build']);
  const badCleanup = preflight(
    fake({
      remove() {
        throw Error('BUILD_CLEANUP_FAILED');
      },
    }).options
  );
  assert.equal(badCleanup.buildCleanup, 'unverified');
  assert.equal(badCleanup.cleanupError, 'BUILD_CLEANUP_FAILED');
  assert.equal(badCleanup.nativeSubjects, 0);
});
