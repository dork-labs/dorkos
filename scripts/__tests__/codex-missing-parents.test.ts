/** Native failures retain their evidence without hiding any later row. */
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
        const sentSignals = [];
        const signalLogs = [];
        process.kill = (pid, signal) => { sentSignals.push([pid, signal]); return true; };
        console.info = (...items) => signalLogs.push(items);
        assert.equal(protectionRows[2][0], 'kill-midturn-10k');
        assert.deepEqual(protectionRows[3], ['default-stub-10k', 'default']);
        assert(protectionRows.some(([scenario]) => scenario === 'agent-symlink-10k'));
        const code = traceMissingParents((command, args, options) => {
          count++;
          assert.equal(command, 'strace');
          assert(args.includes('-ttt'));
          assert(!args.includes('-v'));
          for (const syscall of ['openat', 'mkdir', 'mkdirat', 'mknod', 'mknodat', 'mount', 'unlinkat', 'creat', 'kill', 'tgkill', 'tkill'])
            assert(args.find(arg => arg.startsWith('trace=')).split('=')[1].split(',').includes(syscall));
          assert(options.timeout > 0 && options.timeout <= 190000);
          const report = args.find(arg => arg.startsWith('--outputFile=')).slice(13);
          if (${JSON.stringify(status)} !== 'missing') writeFileSync(report, JSON.stringify({
            testResults: [{ assertionResults: [{ title: 'protects fake secrets through app-server', status: ${JSON.stringify(status)} }] }]
          }));
          return { pid: 424242, status: 0, stdout: 'synthetic output', stderr: '' };
        }, ${JSON.stringify(dir)});
        assert.equal(code, ${status === 'passed' ? 0 : 1});
        assert.equal(count, protectionRows.length + 2);
        const rows = JSON.parse(readFileSync(${JSON.stringify(path.join(dir, 'missing-parents-summary.json'))}, 'utf8'));
        assert.equal(rows.length, count);
        assert.equal(sentSignals.length, count);
        assert(sentSignals.every(([pid, signal]) => pid === -424242 && signal === 'SIGKILL'));
        const sent = signalLogs.filter(([message]) => message === 'Codex diagnostic signal sent');
        assert.equal(sent.length, count);
        assert(sent.every(([, fields]) => fields.senderPid === process.pid &&
          fields.targetGroup === 424242 && fields.sent === true && Number.isFinite(fields.atMs)));
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
