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
 * it to get ready (its own check that it can change nothing) and to refuse a plain setup write. It
 * also reports what the child costs on the packaged binary, which can be measured nowhere else: no
 * packaged build is launched on a developer's Mac for this.
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
      await host.check('git status && ls -la src | head -5', roots, i % 2 === 0);
      warm.push(performance.now() - at);
    }
    warm.sort((a, b) => a - b);
    const p50 = warm[Math.floor(warm.length * 0.5)]!;
    const p99 = warm[Math.floor(warm.length * 0.99)]!;
    const pid = host.warmPid;
    const rssMb = pid
      ? Number(execFileSync('ps', ['-o', 'rss=', '-p', String(pid)], { encoding: 'utf8' })) / 1024
      : NaN;
    return (
      `ready and refusing setup writes; first ${firstMs.toFixed(0)} ms, warm p50 ` +
      `${p50.toFixed(2)} ms, p99 ${p99.toFixed(2)} ms, ${rssMb.toFixed(0)} MB`
    );
  } finally {
    host.stop();
    rmSync(root, { recursive: true, force: true });
  }
}
