/** CI-only diagnostic: keep every scenario's failure, and attempt every mode. */
import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export function measure(run = spawnSync, out = '.temp/codex-untraced') {
  mkdirSync(out, { recursive: true });
  const rows = [];
  for (const scenario of ['home-10k', 'home-500k', 'cwd-500k']) {
    for (const mode of ['default', 'acceptEdits', 'bypassPermissions']) {
      const stem = path.join(out, `${scenario}-${mode}`);
      const result = run(
        'pnpm',
        [
          'vitest',
          'run',
          'apps/server/src/services/runtimes/codex/app-server/__tests__/app-server.binary.test.ts',
          '-t',
          'protects fake secrets through',
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
          timeout: 420_000,
          maxBuffer: 32 * 1024 * 1024,
        }
      );
      // Each invocation owns this new process group. A timed-out pnpm must not
      // leave Codex helpers consuming CPU during the next measurement.
      if (result.error?.code === 'ETIMEDOUT')
        console.info('Codex diagnostic timeout signal', {
          source: 'run-codex-untraced.mjs',
          scenario,
          mode,
          senderPid: process.pid,
          targetPid: result.pid,
          signal: 'SIGTERM',
          origin: 'spawnSync-timeout',
          observedAtMs: Date.now(),
        });
      let cleanupError;
      if (result.pid) {
        try {
          const signal = {
            source: 'run-codex-untraced.mjs',
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
            source: 'run-codex-untraced.mjs',
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
      writeFileSync(`${stem}.log`, `${result.stdout ?? ''}\n${result.stderr ?? ''}`);
      let tests = [];
      try {
        const report = JSON.parse(readFileSync(`${stem}.json`, 'utf8'));
        tests = report.testResults
          .flatMap((suite) => suite.assertionResults)
          .filter((test) => test.title.startsWith('protects fake secrets through'));
      } catch {
        /* Missing reports are a failed diagnostic, never a skip. */
      }
      const complete = tests.length === 2 && tests.every((test) => test.status === 'passed');
      const row = {
        scenario,
        mode,
        status: result.status,
        signal: result.signal,
        error: result.error?.message,
        cleanupError,
        complete,
        tests,
      };
      rows.push(row);
      console.info('Codex untraced diagnostic', row);
      // Emit measured rows and native failures; full details remain in the artifact.
      console.info(result.stdout ?? '');
      console.error(result.stderr ?? '');
      writeFileSync(path.join(out, 'summary.json'), JSON.stringify(rows, null, 2));
    }
  }
  return rows.every((row) => row.status === 0 && row.complete && !row.cleanupError) ? 0 : 1;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.env.CI !== 'true' || process.platform !== 'linux') {
    throw new Error('Native Codex measurement requires Linux CI.');
  }
  process.exitCode = measure();
}
