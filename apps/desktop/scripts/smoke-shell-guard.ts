import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync } from 'fs';
import { execFileSync } from 'child_process';
import os from 'os';
import path from 'path';
import { GuardHost } from '../../server/src/services/runtimes/claude-code/shell-guard/guard-host';
import { helperBinary } from './helper-binary';

/**
 * The packaged-desktop proof for the shell guard's child (DOR-3300).
 *
 * In the packaged app the server forks `shell-guard-child.cjs`, unpacked beside `app.asar`, on the
 * app's own helper binary with `ELECTRON_RUN_AS_NODE=1`. A child that won't start stops the shell at
 * Full, so this forks the packaged child on the packaged helper, through the real host, and requires
 * it to get ready (its own check that it can change nothing) and to refuse a plain setup write.
 * Heap and stall shapes must be refused at production limits, with the next command still checked.
 * It also reports what the child costs on the packaged binary, which can be measured nowhere else:
 * no packaged build is launched on a developer's Mac for this.
 *
 * What it does not reproduce: the `utilityProcess` parent. The host here is plain Node; the child's
 * binary, flags, environment and file are the ones the packaged server uses.
 *
 * @param appPath - The packaged `.app` bundle.
 * @returns A one-line summary for the smoke log.
 */
export async function assertShellGuard(appPath: string): Promise<string> {
  const child = path.join(
    appPath,
    'Contents',
    'Resources',
    'app.asar.unpacked',
    'dist',
    'server',
    'shell-guard-child.cjs'
  );
  if (!existsSync(child)) {
    throw new Error(
      `The packaged app has no unpacked shell guard child at ${child}. electron-builder.yml must ` +
        `asarUnpack dist/server/shell-guard-child.cjs, and build-server.ts must emit it.`
    );
  }
  const root = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'dorkos-smoke-guard-')));
  const agent = path.join(root, 'agent');
  mkdirSync(path.join(agent, '.claude'), { recursive: true });
  const roots = {
    cwd: root,
    dorkHome: path.join(root, 'data'),
    home: path.join(root, 'home'),
    accounts: [],
    env: {},
    agentHomes: () => [agent],
  };
  const host = new GuardHost({
    childFile: async () => child,
    execPath: helperBinary(appPath),
    electronRunAsNode: true,
    log: { warn: (message) => console.warn(message) },
    // A hosted Mac can be slow to start a process.
    tuning: { startMs: 30_000, answerMs: 30_000 },
  });
  // Adversarial rows must use production limits, including the five-second answer timer.
  const limited = new GuardHost({
    childFile: async () => child,
    execPath: helperBinary(appPath),
    electronRunAsNode: true,
    log: { warn: (message) => console.warn(message) },
  });
  try {
    const startedAt = performance.now();
    const first = await host.check('echo hello', roots, true);
    const firstMs = performance.now() - startedAt;
    if (first.outcome !== 'checked' || first.write !== 'none' || first.reaches) {
      throw new Error(
        `The packaged shell guard child did not answer about a plain command: ${JSON.stringify(first)}. ` +
          `If it never got ready, Electron's Node ignored --permission in run-as-node mode: report it, ` +
          `do not weaken the check.`
      );
    }
    const write = await host.check(`echo x > ${agent}/.claude/settings.json`, roots, false);
    if (write.outcome !== 'checked' || write.write !== 'writes') {
      throw new Error(`The packaged child did not refuse a setup write: ${JSON.stringify(write)}`);
    }
    const warm: number[] = [];
    for (let i = 0; i < 200; i++) {
      const at = performance.now();
      const answer = await host.check('git status && ls -la src | head -5', roots, i % 2 === 0);
      if (answer.outcome !== 'checked' || answer.write !== 'none' || answer.reaches) {
        throw new Error(`The packaged child failed a warm check: ${JSON.stringify(answer)}`);
      }
      warm.push(performance.now() - at);
    }
    warm.sort((a, b) => a - b);
    const p50 = warm[Math.floor(warm.length * 0.5)]!;
    const p99 = warm[Math.floor(warm.length * 0.99)]!;
    const pid = host.warmPid;
    const rssMb = pid
      ? Number(execFileSync('ps', ['-o', 'rss=', '-p', String(pid)], { encoding: 'utf8' })) / 1024
      : NaN;
    const rest = 'abcdefghijklmnopqrstuvwxyz0123456789';
    const names = Array.from(
      { length: 31_000 },
      (_, i) => rest[Math.floor(i / 1296)]! + rest[Math.floor(i / 36) % 36]! + rest[i % 36]!
    );
    // The same heap and stall shapes as guard-host.test.ts, on the packaged child and helper.
    const heap = [
      `xa0=${'x'.repeat(12)}`,
      ...[1, 2, 3, 4].map((n) => `xa${n}=${`$xa${n - 1}`.repeat(8)}`),
      'V=$xa4$xa3$xa3$xa2$xa2$xa2$xa2$xa2$xa1$xa1',
      ...names.map((name) => `${name}=x$V`),
      'echo hi',
    ].join(';');
    const stall = `V=${root}/nomatch/${'[a'.repeat(1900)}; rm ${'$V '.repeat(400)}`;
    const refusals: string[] = [];
    for (const [name, command] of [
      ['heap', heap],
      ['stall', stall],
    ] as const) {
      // Prove startup separately: an unavailable helper is not evidence of resource containment.
      const before = await limited.check('echo before', roots, false);
      if (before.outcome !== 'checked') {
        throw new Error(
          `The packaged child could not start before ${name}: ${JSON.stringify(before)}`
        );
      }
      const at = performance.now();
      const refused = await limited.check(command, roots, false);
      const elapsed = performance.now() - at;
      if (refused.outcome !== 'failed') {
        throw new Error(`The packaged child did not refuse ${name}: ${JSON.stringify(refused)}`);
      }
      const after = await limited.check('echo after', roots, false);
      if (after.outcome !== 'checked' || after.write !== 'none' || after.reaches) {
        throw new Error(
          `The packaged child did not recover after ${name}: ${JSON.stringify(after)}`
        );
      }
      refusals.push(`${name} refused ${elapsed.toFixed(0)} ms, next command checked`);
    }
    return (
      `ready and refusing setup writes; first ${firstMs.toFixed(0)} ms, warm p50 ` +
      `${p50.toFixed(2)} ms, p99 ${p99.toFixed(2)} ms, ${rssMb.toFixed(0)} MB; ` +
      refusals.join('; ')
    );
  } finally {
    host.stop();
    limited.stop();
    rmSync(root, { recursive: true, force: true });
  }
}
