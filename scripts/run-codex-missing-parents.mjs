/** Temporary Linux-CI evidence: stop at the first failed protection row, retaining its argv. */
import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const protectionRows = [
  ['agent-home-10k', 'acceptEdits'],
  ['agent-home-10k', 'bypassPermissions'],
  ['other-home-10k', 'acceptEdits'],
  ['other-home-10k', 'bypassPermissions'],
  ['person-cwd-10k', 'acceptEdits'],
  ['person-symlink-10k', 'acceptEdits'],
  ['person-symlink-10k', 'bypassPermissions'],
  ['outside-tmp-10k', 'acceptEdits'],
  ['outside-tmp-10k', 'bypassPermissions'],
  ['kill-midturn-10k', 'acceptEdits'],
];

export function traceMissingParents(
  run = spawnSync,
  out = '.temp/codex-bwrap-trace',
  now = Date.now
) {
  mkdirSync(out, { recursive: true });
  const deadline = now() + 570_000; // Leave cleanup time inside the approved ten-minute step.
  const rows = [];
  for (const [scenario, mode] of [
    ...protectionRows,
    ['rg-unreadable-10k', 'default'],
    ['rg-vanishing-10k', 'default'],
  ]) {
    const stem = path.join(out, `${scenario}-${mode}`);
    const budget = Math.min(190_000, deadline - now());
    if (budget <= 0) {
      rows.push({ scenario, mode, complete: false, error: 'Diagnostic step budget exhausted' });
      break;
    }
    const result = run(
      'strace',
      [
        '-ff',
        '-ttt',
        '-e',
        'trace=execve,execveat,mount,umount2,unlink,unlinkat,openat,mkdir,mkdirat,mknod,mknodat',
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
        },
        encoding: 'utf8',
        detached: true,
        timeout: budget,
        maxBuffer: 32 * 1024 * 1024,
      }
    );
    let cleanupError;
    if (result.pid) {
      try {
        process.kill(-result.pid, 'SIGKILL');
      } catch (error) {
        if (error.code !== 'ESRCH') cleanupError = error.message;
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
    // Security requires argv before another attempted fix. Keep the refusal
    // rows last: their expected rg failures must not hide protection evidence.
    if (!row.complete && !scenario.startsWith('rg-')) break;
  }
  writeFileSync(path.join(out, 'missing-parents-summary.json'), JSON.stringify(rows, null, 2));
  return rows.length === protectionRows.length + 2 && rows.every((row) => row.complete) ? 0 : 1;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.env.CI !== 'true' || process.platform !== 'linux')
    throw new Error('Requires Linux CI.');
  process.exitCode = traceMissingParents();
}
