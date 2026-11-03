/** Diagnostic failures must not prevent the other requested rows from running. */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { it } from 'vitest';

it.each(['passed', 'missing', 'failed'])(
  'retains all scenarios when one report is %s',
  (status) => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'codex-measure-driver-'));
    const module = pathToFileURL(
      path.resolve(import.meta.dirname, '../run-codex-untraced.mjs')
    ).href;
    try {
      execFileSync(
        process.execPath,
        [
          '--input-type=module',
          '-e',
          `
      import assert from 'node:assert/strict';
      import { writeFileSync, readFileSync } from 'node:fs';
      import { measure } from ${JSON.stringify(module)};
      const seen = [];
      const code = measure((command, args, options) => {
        assert.equal(command, 'pnpm');
        assert(!args.includes('strace'));
        seen.push([options.env.DORKOS_CODEX_PROBE_SCENARIO, options.env.DORKOS_CODEX_PROBE_MODE]);
        const broken = seen.length === 1;
        const report = args.find(arg => arg.startsWith('--outputFile=')).slice(13);
        if (!broken || ${JSON.stringify(status)} !== 'missing') {
          writeFileSync(report, JSON.stringify({ testResults: [{ assertionResults:
            ['app-server', 'exec'].map(kind => ({ title: 'protects fake secrets through ' + kind,
              status: broken ? ${JSON.stringify(status)} : 'passed' })) }] }));
        }
        return { status: 0, stdout: '', stderr: '' };
      }, ${JSON.stringify(dir)});
      assert.equal(code, ${status === 'passed' ? 0 : 1});
      assert.equal(new Set(seen.map(row => row.join('/'))).size, 9);
      assert.equal(JSON.parse(readFileSync(${JSON.stringify(path.join(dir, 'summary.json'))}, 'utf8')).length, 9);
    `,
        ],
        { stdio: 'pipe' }
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }
);
