import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync, chmodSync, rmSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { isEntrypoint } from '../../entrypoint.mjs';
import { PINS } from './policy.mjs';

const SOURCE = fileURLToPath(new URL('./native/', import.meta.url));
const SOURCES = [
  'bridge.h',
  'bridge.c',
  'fixture.c',
  'tree-fixture.h',
  'tree-fixture.c',
  'guardian.h',
  'guardian.c',
  'guardian-io.c',
  'guardian-custody.c',
  'guardian-exercise.c',
  'guardian-tree.h',
  'guardian-tree.c',
];
const digest = (bytes) => createHash('sha256').update(bytes).digest('hex');

/** Compile private custody artifacts only; no produced binary, export probe or native API is executed. */
export function buildCustody({
  platform = process.platform,
  retain = false,
  command = execFileSync,
  read = readFileSync,
  temporary = () => realpathSync(mkdtempSync(join(tmpdir(), 'dork-darwin-custody-build-'))),
  write = writeFileSync,
  chmod = chmodSync,
  remove = (root) => rmSync(root, { recursive: true, force: true }),
} = {}) {
  const receipt = {
    status: 'UNVERIFIED',
    nativeSubjects: 0,
    helperExecutions: 0,
    identityQueries: 0,
    signals: 0,
    runtimeExports: 'UNVERIFIED',
    kernelCorrespondence: 'UNVERIFIED',
    source: {},
    commands: [],
  };
  if (platform !== 'darwin') return { ...receipt, reason: 'DARWIN_UNAVAILABLE' };
  let root;
  try {
    const run = (tool, arguments_) => {
      receipt.commands.push({ tool, arguments: arguments_ });
      return command(tool, arguments_, {
        encoding: 'utf8',
        timeout: 10_000,
        maxBuffer: 1_000_000,
      }).trim();
    };
    const compiler = run('/usr/bin/xcrun', ['--find', 'clang']);
    const sdk = run('/usr/bin/xcrun', ['--show-sdk-path']);
    receipt.compiler = compiler;
    receipt.compilerVersion = run(compiler, ['--version']);
    receipt.sdk = sdk;
    receipt.sdkVersion = run('/usr/bin/xcrun', ['--show-sdk-version']);
    receipt.architecture = process.arch;
    for (const source of SOURCES) receipt.source[source] = digest(read(join(SOURCE, source)));
    const sourceDigest = digest(Buffer.from(JSON.stringify(receipt.source)));
    root = temporary();
    chmod(root, 0o700);
    const flags = [
      '-std=c11',
      '-Wall',
      '-Wextra',
      '-Werror',
      '-Wno-deprecated-declarations',
      '-isysroot',
      sdk,
    ];
    const object = (source) => join(root, source + '.o');
    for (const source of [
      'bridge.c',
      'tree-fixture.c',
      'guardian.c',
      'guardian-io.c',
      'guardian-custody.c',
      'guardian-exercise.c',
      'guardian-tree.c',
    ])
      run(compiler, [...flags, '-c', join(SOURCE, source), '-o', object(source)]);
    for (const [name, image] of [
      ['fixture-a', 1],
      ['fixture-b', 2],
    ]) {
      const fixtureObject = object(name);
      run(compiler, [
        ...flags,
        '-DDORK_FIXTURE_IMAGE=' + image,
        '-c',
        join(SOURCE, 'fixture.c'),
        '-o',
        fixtureObject,
      ]);
      run(compiler, [
        ...flags,
        object('bridge.c'),
        object('tree-fixture.c'),
        fixtureObject,
        '-lproc',
        '-o',
        join(root, name),
      ]);
    }
    run(compiler, [
      ...flags,
      ...[
        'bridge.c',
        'guardian.c',
        'guardian-io.c',
        'guardian-custody.c',
        'guardian-exercise.c',
        'guardian-tree.c',
      ].map(object),
      '-lproc',
      '-o',
      join(root, 'guardian'),
    ]);
    const assets = {};
    for (const name of ['guardian', 'fixture-a', 'fixture-b']) {
      const path = join(root, name);
      chmod(path, 0o700);
      const bytes = read(path);
      assets[name] = { sha256: digest(bytes), bytes: bytes.length };
    }
    const manifest = {
      version: 1,
      root,
      plan: PINS.plan,
      sourceDigest,
      compiler,
      sdk,
      architecture: process.arch,
      assets,
    };
    write(join(root, 'custody.json'), JSON.stringify(manifest, null, 2) + '\n', {
      flag: 'wx',
      mode: 0o600,
    });
    receipt.manifest = manifest;
    receipt.build = 'COMPILED_LINKED_NOT_EXECUTED';
    receipt.reason = 'NATIVE_RESEARCH_HELD';
  } catch (error) {
    receipt.build = 'UNVERIFIED';
    receipt.reason = 'BUILD_UNVERIFIED';
    receipt.diagnostic = error.message;
  } finally {
    if (root && (!retain || receipt.build !== 'COMPILED_LINKED_NOT_EXECUTED')) {
      try {
        remove(root);
        receipt.buildCleanup = 'removed';
      } catch (error) {
        receipt.buildCleanup = 'UNVERIFIED';
        receipt.cleanupDiagnostic = error.message;
      }
    } else if (root) receipt.buildCleanup = 'retained-private-compile-only';
  }
  return receipt;
}
if (isEntrypoint(import.meta.url)) {
  const receipt = buildCustody();
  process.stdout.write(JSON.stringify(receipt, null, 2) + '\n');
  process.exitCode =
    receipt.build === 'COMPILED_LINKED_NOT_EXECUTED' && receipt.buildCleanup === 'removed' ? 0 : 1;
}
