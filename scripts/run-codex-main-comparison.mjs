/** Temporary Linux-CI comparison; never execute native probes on this Mac. */
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

if (process.env.CI !== 'true' || process.platform !== 'linux') {
  throw new Error('Codex main comparison requires Linux CI.');
}
const workspace = process.cwd();
const out = path.resolve('.temp/codex-main-comparison');
mkdirSync(out, { recursive: true });
const rows = [];
function run(name, command, args, cwd, timeout = 180_000, env = process.env) {
  const result = spawnSync(command, args, {
    cwd,
    env,
    encoding: 'utf8',
    timeout,
    maxBuffer: 32 * 1024 * 1024,
    detached: true,
  });
  if (result.error?.code === 'ETIMEDOUT')
    console.info('Codex diagnostic timeout signal', {
      source: 'run-codex-main-comparison.mjs',
      name,
      senderPid: process.pid,
      targetPid: result.pid,
      signal: 'SIGTERM',
      origin: 'spawnSync-timeout',
      observedAtMs: Date.now(),
    });
  if (result.pid) {
    try {
      const signal = {
        source: 'run-codex-main-comparison.mjs',
        name,
        senderPid: process.pid,
        targetGroup: result.pid,
        signal: 'SIGKILL',
        atMs: Date.now(),
      };
      console.info('Codex diagnostic signal requested', signal);
      process.kill(-result.pid, 'SIGKILL');
      console.info('Codex diagnostic signal sent', { ...signal, sent: true });
    } catch (error) {
      console.info('Codex diagnostic signal failed', {
        source: 'run-codex-main-comparison.mjs',
        name,
        senderPid: process.pid,
        targetGroup: result.pid,
        atMs: Date.now(),
        code: error.code,
      });
      if (error.code !== 'ESRCH') throw error;
    }
  }
  writeFileSync(path.join(out, `${name}.log`), `${result.stdout ?? ''}\n${result.stderr ?? ''}`);
  const row = { name, status: result.status, signal: result.signal, error: result.error?.message };
  rows.push(row);
  console.info('Codex main comparison', row);
  writeFileSync(path.join(out, 'summary.json'), JSON.stringify(rows, null, 2));
  return result;
}
const nativeFile =
  'apps/server/src/services/runtimes/codex/app-server/__tests__/app-server.binary.test.ts';
const vitest = (report) => [
  'vitest',
  'run',
  nativeFile,
  '--reporter=default',
  '--reporter=json',
  `--outputFile=${path.join(out, report)}`,
];
function receipt(report, required) {
  let tests = [];
  try {
    tests = JSON.parse(readFileSync(path.join(out, report), 'utf8')).testResults.flatMap(
      (suite) => suite.assertionResults
    );
  } catch {
    /* Missing reports remain unproven. */
  }
  const completed = required.every((title) =>
    tests.some((test) => test.title.includes(title) && test.status === 'passed')
  );
  rows.push({
    name: `receipt-${report}`,
    status: completed ? 0 : 1,
    passed: tests.filter((test) => test.status === 'passed').length,
  });
  writeFileSync(path.join(out, 'summary.json'), JSON.stringify(rows, null, 2));
}
// Isolate the new branch control from any previously timed-out provider FIFO.
run(
  'branch-isolated-default',
  'strace',
  [
    '-ff',
    '-e',
    'trace=execve,execveat',
    '-s',
    '4096',
    '-o',
    path.join(out, 'branch-isolated'),
    'pnpm',
    ...vitest('branch-isolated.json'),
    '-t',
    'protects fake secrets through app-server despite a loaded legacy Full setting',
  ],
  workspace,
  180_000,
  { ...process.env, DORKOS_CODEX_PROBE_SCENARIO: 'home-10k', DORKOS_CODEX_PROBE_MODE: 'default' }
);
receipt('branch-isolated.json', ['protects fake secrets through app-server']);

// Genuine main source and its own dependencies/build, not a transplanted test file.
const baselineRoot = mkdtempSync(path.join(os.tmpdir(), 'codex-main-comparison-'));
let attached = false;
try {
  if (
    run('fetch-main', 'git', ['fetch', '--no-tags', 'origin', 'main'], workspace, 60_000).status !==
    0
  )
    throw new Error('Cannot obtain the main baseline.');
  const mainHead = run('main-head', 'git', ['rev-parse', 'FETCH_HEAD'], workspace).stdout?.trim();
  writeFileSync(path.join(out, 'main-head.txt'), `${mainHead}\n`);
  if (
    !mainHead ||
    run('worktree', 'git', ['worktree', 'add', '--detach', baselineRoot, mainHead], workspace)
      .status !== 0
  )
    throw new Error('Cannot create the main baseline.');
  attached = true;
  if (
    run('install', 'pnpm', ['install', '--frozen-lockfile', '--offline'], baselineRoot).status !== 0
  )
    throw new Error('Main dependencies unavailable offline; baseline unproven.');
  if (
    run(
      'build',
      'pnpm',
      ['exec', 'turbo', 'run', 'build', '--filter=@dorkos/server^...'],
      baselineRoot
    ).status !== 0
  )
    throw new Error('Main workspace dependencies did not build.');
  const baselineSource = readFileSync(path.join(baselineRoot, nativeFile), 'utf8');
  writeFileSync(
    path.join(out, 'comparison-scope.txt'),
    `Main protected-control row present: ${baselineSource.includes('protects fake secrets through')}\n` +
      'Compare main native suite (including background tests), traced and untraced, with branch S1.\n'
  );
  run(
    'main-traced',
    'strace',
    [
      '-ff',
      '-e',
      'trace=execve,execveat',
      '-s',
      '4096',
      '-o',
      path.join(out, 'main'),
      'pnpm',
      ...vitest('main-traced.json'),
    ],
    baselineRoot,
    240_000
  );
  run('main-untraced', 'pnpm', vitest('main-untraced.json'), baselineRoot, 240_000);
  for (const report of ['main-traced.json', 'main-untraced.json'])
    receipt(report, [
      'streams a turn',
      'never wakes for a command',
      'stops a never-ending command',
    ]);
} catch (error) {
  console.error(String(error));
  writeFileSync(path.join(out, 'baseline-error.txt'), String(error));
  process.exitCode = 1;
} finally {
  if (attached)
    run('cleanup-worktree', 'git', ['worktree', 'remove', '--force', baselineRoot], workspace);
}
if (rows.some((row) => row.status !== 0 || row.error)) process.exitCode = 1;
