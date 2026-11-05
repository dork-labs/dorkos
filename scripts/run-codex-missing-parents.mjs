/** Temporary Linux-CI evidence: collect every row, retaining each failure and argv. */
import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { prepareRootHome } from './codex-root-home-fixture.mjs';

export const protectionRows = [
  ['agent-home-10k', 'acceptEdits'],
  ['agent-home-10k', 'bypassPermissions'],
  ['kill-midturn-10k', 'acceptEdits'],
  ['default-stub-10k', 'default'],
  ['agent-symlink-10k', 'acceptEdits'],
  ['other-home-10k', 'acceptEdits'],
  ['other-home-10k', 'bypassPermissions'],
  ['person-cwd-10k', 'acceptEdits'],
  ['person-symlink-10k', 'acceptEdits'],
  ['person-symlink-10k', 'bypassPermissions'],
  ['outside-tmp-10k', 'acceptEdits'],
  ['outside-tmp-10k', 'bypassPermissions'],
  ['reconcile-leak-10k', 'acceptEdits'],
  ['reconcile-default-10k', 'default'],
  ['concurrent-ledger-10k', 'acceptEdits'],
  ['nonempty-ledger-10k', 'acceptEdits'],
  ['nonempty-ledger-10k', 'bypassPermissions'],
  ['person-root-link-10k', 'acceptEdits'],
  ['person-root-link-10k', 'bypassPermissions'],
  ['skill-discovery-10k', 'acceptEdits'],
  ['skill-discovery-10k', 'bypassPermissions'],
  ['new-agent-fork-10k', 'bypassPermissions'],
];

export function traceMissingParents(
  run = spawnSync,
  out = '.temp/codex-bwrap-trace',
  now = Date.now,
  prepare = prepareRootHome
) {
  mkdirSync(out, { recursive: true });
  const deadline = now() + 870_000; // Leave cleanup time inside the approved fifteen-minute step.
  const rows = [];
  const matrix = [
    ...protectionRows,
    ['rg-unreadable-10k', 'default'],
    ['rg-vanishing-10k', 'default'],
  ];
  for (const [index, [scenario, mode]] of matrix.entries()) {
    const stem = path.join(out, `${scenario}-${mode}`);
    // Reserve a share for every remaining row, even after a timeout. Fast rows
    // release their unused share to later rows; no row can consume the step.
    const budget = Math.min(190_000, Math.floor((deadline - now()) / (matrix.length - index)));
    if (budget <= 0) {
      rows.push({ scenario, mode, complete: false, error: 'Diagnostic step budget exhausted' });
      writeFileSync(`${stem}.log`, 'Diagnostic step budget exhausted; row unproven\n');
      continue;
    }
    let fixture;
    try {
      fixture = scenario === 'person-root-link-10k' ? prepare() : undefined;
    } catch (error) {
      const row = { scenario, mode, complete: false, error: String(error) };
      rows.push(row);
      writeFileSync(`${stem}.log`, `Root fixture setup failed: ${error}\n`);
      writeFileSync(path.join(out, 'missing-parents-summary.json'), JSON.stringify(rows, null, 2));
      continue;
    }
    let result;
    let cleanupError;
    try {
      result = run(
        'strace',
        [
          '-ff',
          '-ttt',
          '-e',
          'trace=execve,execveat,mount,umount2,unlink,unlinkat,openat,mkdir,mkdirat,mknod,mknodat,creat,kill,tgkill,tkill',
          '-s',
          '1048576',
          '-o',
          stem,
          'pnpm',
          'vitest',
          'run',
          'apps/server/src/services/runtimes/codex/app-server/__tests__/app-server.binary.test.ts',
          '-t',
          'protects fake secrets through app-server despite a loaded legacy Full setting',
          '--reporter=default',
          '--reporter=json',
          `--outputFile=${stem}.json`,
        ],
        {
          env: {
            ...process.env,
            DORKOS_CODEX_PROBE_SCENARIO: scenario,
            DORKOS_CODEX_PROBE_MODE: mode,
            ...(fixture ? { DORKOS_CODEX_PROBE_ROOT: fixture.root } : {}),
          },
          encoding: 'utf8',
          detached: true,
          timeout: budget,
          maxBuffer: 32 * 1024 * 1024,
        }
      );
      if (result.error?.code === 'ETIMEDOUT')
        console.info('Codex diagnostic timeout signal', {
          source: 'run-codex-missing-parents.mjs',
          scenario,
          mode,
          senderPid: process.pid,
          targetPid: result.pid,
          signal: 'SIGTERM',
          origin: 'spawnSync-timeout',
          observedAtMs: Date.now(),
        });
      if (result.pid) {
        try {
          const signal = {
            source: 'run-codex-missing-parents.mjs',
            scenario,
            mode,
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
            source: 'run-codex-missing-parents.mjs',
            scenario,
            mode,
            senderPid: process.pid,
            targetGroup: result.pid,
            atMs: Date.now(),
            code: error.code,
          });
          if (error.code !== 'ESRCH') cleanupError = error.message;
        }
      }
    } finally {
      try {
        fixture?.cleanup();
      } catch (error) {
        cleanupError = String(error);
      }
    }
    writeFileSync(`${stem}.log`, `${result.stdout ?? ''}\n${result.stderr ?? ''}`);
    let tests = [];
    try {
      tests = JSON.parse(readFileSync(`${stem}.json`, 'utf8'))
        .testResults.flatMap((suite) => suite.assertionResults)
        .filter((test) => test.title.startsWith('protects fake secrets through app-server'));
    } catch {
      /* A missing report never proves a native row. */
    }
    const row = {
      scenario,
      mode,
      status: result.status,
      signal: result.signal,
      error: result.error?.message,
      cleanupError,
      complete:
        result.status === 0 && tests.length === 1 && tests[0].status === 'passed' && !cleanupError,
      tests,
    };
    rows.push(row);
    writeFileSync(path.join(out, 'missing-parents-summary.json'), JSON.stringify(rows, null, 2));
    console.info('Codex missing-parent diagnostic', row);
    console.info(result.stdout ?? '');
    console.error(result.stderr ?? '');
  }
  writeFileSync(path.join(out, 'missing-parents-summary.json'), JSON.stringify(rows, null, 2));
  return rows.length === protectionRows.length + 2 && rows.every((row) => row.complete) ? 0 : 1;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.env.CI !== 'true' || process.platform !== 'linux')
    throw new Error('Requires Linux CI.');
  process.exitCode = traceMissingParents();
}
