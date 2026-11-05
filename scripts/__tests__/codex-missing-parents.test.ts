/** Native failures retain their evidence without hiding any later row. */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { it } from 'vitest';

it.each(['passed', 'failed', 'missing', 'cleanup-failed'])(
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
        let prepared = 0;
        let cleaned = 0;
        const sentSignals = [];
        const signalLogs = [];
        process.kill = (pid, signal) => { sentSignals.push([pid, signal]); return true; };
        console.info = (...items) => signalLogs.push(items);
        assert.equal(protectionRows[2][0], 'kill-midturn-10k');
        assert.deepEqual(protectionRows[3], ['default-stub-10k', 'default']);
        assert(protectionRows.some(([scenario]) => scenario === 'agent-symlink-10k'));
        for (const scenario of ['reconcile-leak-10k', 'reconcile-default-10k', 'concurrent-ledger-10k', 'nonempty-ledger-10k', 'person-root-link-10k', 'skill-discovery-10k', 'new-agent-fork-10k'])
          assert(protectionRows.some(([name]) => name === scenario));
        const code = traceMissingParents((command, args, options) => {
          count++;
          if (options.env.DORKOS_CODEX_PROBE_SCENARIO === 'person-root-link-10k') {
            assert.equal(options.env.DORKOS_CODEX_PROBE_ROOT, '/fake-root-owned-home');
            assert.equal(prepared, cleaned + 1);
          } else assert.equal(options.env.DORKOS_CODEX_PROBE_ROOT, undefined);
          assert.equal(command, 'strace');
          assert(args.includes('-ttt'));
          assert(!args.includes('-v'));
          for (const syscall of ['openat', 'mkdir', 'mkdirat', 'mknod', 'mknodat', 'mount', 'unlinkat', 'creat', 'kill', 'tgkill', 'tkill'])
            assert(args.find(arg => arg.startsWith('trace=')).split('=')[1].split(',').includes(syscall));
          assert(options.timeout > 0 && options.timeout <= 190000);
          const report = args.find(arg => arg.startsWith('--outputFile=')).slice(13);
          if (${JSON.stringify(status)} !== 'missing') writeFileSync(report, JSON.stringify({
            testResults: [{ assertionResults: [{ title: 'protects fake secrets through app-server', status: ${JSON.stringify(status === 'cleanup-failed' ? 'passed' : status)} }] }]
          }));
          return { pid: 424242, status: 0, stdout: 'synthetic output', stderr: '' };
        }, ${JSON.stringify(dir)}, Date.now, () => {
          prepared++;
          return { root: '/fake-root-owned-home', cleanup: () => { cleaned++; ${status === 'cleanup-failed' ? 'throw new Error("fixture cleanup failed");' : ''} } };
        });
        assert.equal(prepared, 2);
        assert.equal(cleaned, 2);
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
