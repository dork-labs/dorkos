/** A failed native row must retain evidence and stop the new protection matrix. */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { it } from 'vitest';

it.each(['passed', 'failed', 'missing'])(
  'preserves a %s report and respects the trace budget',
  (status) => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'codex-trace-driver-'));
    const module = pathToFileURL(
      path.resolve(import.meta.dirname, '../run-codex-missing-parents.mjs')
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
        import { traceMissingParents, protectionRows } from ${JSON.stringify(module)};
        let count = 0;
        const code = traceMissingParents((command, args, options) => {
          count++;
          assert.equal(command, 'strace');
          assert(args.includes('-ttt'));
          assert(!args.includes('-v'));
          for (const syscall of ['openat', 'mkdir', 'mkdirat', 'mknod', 'mknodat', 'mount', 'unlinkat'])
            assert(args.find(arg => arg.startsWith('trace=')).split('=')[1].split(',').includes(syscall));
          assert(options.timeout > 0 && options.timeout <= 190000);
          const report = args.find(arg => arg.startsWith('--outputFile=')).slice(13);
          if (${JSON.stringify(status)} !== 'missing') writeFileSync(report, JSON.stringify({
            testResults: [{ assertionResults: [{ title: 'protects fake secrets through app-server', status: ${JSON.stringify(status)} }] }]
          }));
          return { status: 0, stdout: 'synthetic output', stderr: '' };
        }, ${JSON.stringify(dir)});
        assert.equal(code, ${status === 'passed' ? 0 : 1});
        assert.equal(count, ${status === 'passed' ? 'protectionRows.length + 2' : '1'});
        const rows = JSON.parse(readFileSync(${JSON.stringify(path.join(dir, 'missing-parents-summary.json'))}, 'utf8'));
        assert.equal(rows.length, count);
        assert.equal(readFileSync(${JSON.stringify(path.join(dir, 'agent-home-10k-acceptEdits.log'))}, 'utf8').trim(), 'synthetic output');
      `,
        ],
        { stdio: 'pipe' }
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }
);
