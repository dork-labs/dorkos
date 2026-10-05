import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { PINS } from './policy.mjs';
import { isEntrypoint } from '../../entrypoint.mjs';

const sourceRoot = fileURLToPath(new URL('./native/', import.meta.url));
function hash(path, read) {
  return createHash('sha256').update(read(path)).digest('hex');
}

/** Compile/link only; never execute a helper, query identities or acquire native subjects. */
export function preflight({
  platform = process.platform,
  command = execFileSync,
  read = readFileSync,
  temporary = () => mkdtempSync(join(tmpdir(), 'dork-darwin-build-')),
  remove = (path) => rmSync(path, { recursive: true, force: true }),
} = {}) {
  const receipt = {
    pins: PINS,
    nativeSubjects: 0,
    nativeSignals: 0,
    status: 'unverified',
    runtimeExports: 'unverified',
    kernelCorrespondence: 'unverified',
    observations: [],
  };
  if (platform !== 'darwin') {
    receipt.reason = 'DARWIN_UNAVAILABLE';
    return receipt;
  }
  let root;
  try {
    const run = (tool, args) =>
      command(tool, args, { encoding: 'utf8', timeout: 10_000, maxBuffer: 1_000_000 }).trim();
    receipt.compiler = run('/usr/bin/xcrun', ['--find', 'clang']);
    receipt.sdk = run('/usr/bin/xcrun', ['--show-sdk-path']);
    receipt.sdkVersion = run('/usr/bin/xcrun', ['--show-sdk-version']);
    receipt.architecture = process.arch;
    receipt.compilerVersion = run(receipt.compiler, ['--version']);
    for (const relative of ['libproc.h', 'mach/task_info.h', 'sys/wait.h']) {
      const path = join(receipt.sdk, 'usr/include', relative);
      receipt.observations.push({ header: relative, sha256: hash(path, read) });
    }
    const declarations = read(join(receipt.sdk, 'usr/include/libproc.h'), 'utf8');
    for (const symbol of [
      'proc_pidinfo',
      'proc_signal_with_audittoken',
      'proc_terminate_with_audittoken',
    ])
      if (!declarations.includes(symbol + '(')) throw Error('SDK_DECLARATION_UNAVAILABLE');
    const stub = read(join(receipt.sdk, 'usr/lib/libproc.tbd'), 'utf8');
    receipt.sdkExports = [
      '_proc_pidinfo',
      '_proc_signal_with_audittoken',
      '_proc_terminate_with_audittoken',
    ].every((symbol) => stub.includes(symbol))
      ? 'declared'
      : 'unverified';
    root = temporary(); /* Cleanup is established before any compiler invocation. */
    const args = ['-std=c11', '-Wall', '-Wextra', '-Werror', '-isysroot', receipt.sdk];
    receipt.observations.push({
      source: 'bridge.h',
      sha256: hash(join(sourceRoot, 'bridge.h'), read),
    });
    for (const source of ['bridge.c', 'tree-fixture.c', 'fixture.c']) {
      receipt.observations.push({ source, sha256: hash(join(sourceRoot, source), read) });
      run(receipt.compiler, [
        ...args,
        '-c',
        join(sourceRoot, source),
        '-o',
        join(root, source + '.o'),
      ]);
    }
    const binary = join(root, 'fixture');
    run(receipt.compiler, [
      ...args,
      join(root, 'bridge.c.o'),
      join(root, 'tree-fixture.c.o'),
      join(root, 'fixture.c.o'),
      '-lproc',
      '-o',
      binary,
    ]);
    receipt.observations.push({ binary: 'fixture', sha256: hash(binary, read) });
    receipt.build = 'compiled-linked-not-executed';
    receipt.reason = 'PRIVATE_RUNTIME_BEHAVIOR_UNOBSERVED';
  } catch (error) {
    receipt.reason = error.message;
    receipt.build = 'unverified';
  } finally {
    if (root) {
      try {
        remove(root);
        receipt.buildCleanup = 'removed';
      } catch (error) {
        receipt.buildCleanup = 'unverified';
        receipt.cleanupError = error.message;
      }
    }
  }
  return receipt;
}

if (isEntrypoint(import.meta.url)) {
  const receipt = preflight();
  process.stdout.write(JSON.stringify(receipt, null, 2) + '\n');
  process.exitCode = receipt.build === 'compiled-linked-not-executed' ? 0 : 1;
}
