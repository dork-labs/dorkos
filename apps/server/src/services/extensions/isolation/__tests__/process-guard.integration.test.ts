/**
 * An isolated child may signal only itself (DOR-2686 review finding).
 *
 * Node's permission model does not gate signals: unguarded, a child can
 * SIGKILL DorkOS (`process.kill(process.ppid, 'SIGKILL')`), signal its whole
 * process group (`process.kill(0, …)`), or send SIGUSR1 to make DorkOS open
 * its V8 inspector with full authority.
 *
 * Each case runs in a THROWAWAY host process this test spawns (never the test
 * runner, never a real DorkOS): it forks the real bootstrap with the real
 * flags, asks the child to signal it, then reports whether it is alive and
 * whether its inspector opened (`--inspect-port=0`, so SIGUSR1 would bind a
 * random port, checked with `inspector.url()`). The control is the same host
 * forking a plain child that signals it with no guard: its inspector opens,
 * which proves the probe is real.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { fork, type ChildProcess } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { cleanup, createHarness, type Harness } from './isolation-harness.js';

/** The throwaway host: forks one child, runs one probe, reports. */
const HOST = String.raw`
const { fork, spawn } = require('child_process');
const inspector = require('inspector');
const [mode, bootstrap, bundle, dorkHome, probeName, arg] = process.argv.slice(2);
const report = (data) => process.send(data, () => setTimeout(() => process.exit(0), 50));
const settle = (result) =>
  setTimeout(() => report({ result, inspector: inspector.url() || null, alive: true }), 700);
if (mode === 'control') {
  const child = spawn(process.execPath, ['-e', 'process.kill(process.ppid, process.argv[1])', arg], {
    stdio: 'ignore',
  });
  child.on('exit', () => settle('sent'));
} else {
  const child = fork(bootstrap, [dorkHome], {
    execArgv: ['--permission', '--allow-fs-read=' + bootstrap, '--allow-fs-read=' + bundle],
    serialization: 'advanced',
    stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
  });
  child.on('message', (m) => {
    if (m.type === 'hello') {
      child.send({ type: 'init', extensionId: 'sig', bundlePath: bundle, allowNet: [], allowRun: [], dorkosPort: 1, testSeams: true, ctx: { extensionDir: dorkHome, dorkHome, filesDir: dorkHome }, displayName: 'Sig', allowAgents: false });
    } else if (m.type === 'loaded') {
      child.send({ type: 'probe', id: 1, name: probeName, args: arg ? [arg] : [] });
    } else if (m.type === 'probe-result') {
      child.kill('SIGKILL');
      settle(m.value);
    }
  });
}
`;

describe.skipIf(process.platform === 'win32')('an isolated child signals only itself', () => {
  let h: Harness;
  let hostScript: string;
  const hosts: ChildProcess[] = [];

  beforeEach(async () => {
    h = await createHarness();
    hostScript = path.join(h.tmp, 'throwaway-host.cjs');
    await fs.writeFile(hostScript, HOST);
  });

  afterEach(async () => {
    for (const host of hosts.splice(0)) {
      if (host.exitCode === null && host.signalCode === null) host.kill('SIGKILL');
    }
    await cleanup(h);
  });

  /** Run one throwaway host; resolve with its report, or how it died. */
  function runHost(
    mode: 'guarded' | 'control',
    probeName: string,
    arg = ''
  ): Promise<{
    report?: { result: unknown; inspector: string | null; alive: boolean };
    signal?: string | null;
  }> {
    const host = fork(hostScript, [mode, h.bootstrap, h.bundle, h.dorkHome, probeName, arg], {
      execArgv: ['--inspect-port=0'],
      stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
    });
    hosts.push(host);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('throwaway host timed out')), 10_000);
      let report: { result: unknown; inspector: string | null; alive: boolean } | undefined;
      host.on('message', (m) => {
        report = m as typeof report;
      });
      host.on('exit', (_code, signal) => {
        clearTimeout(timer);
        resolve({ report, signal });
      });
    });
  }

  // Purpose: the control. An unguarded child's SIGUSR1 opens the host's
  // inspector, so the guarded case below is testing something real.
  it('control: an unguarded child opens the host inspector with SIGUSR1', async () => {
    const outcome = await runHost('control', 'none', 'SIGUSR1');
    expect(outcome.report?.inspector).toMatch(/^ws:\/\//);
  });

  // Purpose: SIGUSR1 to the parent is refused and the inspector stays shut.
  it('refuses SIGUSR1 to its host', async () => {
    const outcome = await runHost('guarded', 'signalParent', 'SIGUSR1');
    expect(outcome.report?.result).toMatchObject({
      ok: false,
      code: 'ERR_EXTENSION_SIGNAL_DENIED',
    });
    expect(outcome.report?.inspector).toBeNull();
  });

  // Purpose: SIGKILL to the parent is refused and the host lives on.
  it('refuses SIGKILL to its host', async () => {
    const outcome = await runHost('guarded', 'signalParent', 'SIGKILL');
    expect(outcome.signal).toBeNull();
    expect(outcome.report).toMatchObject({
      alive: true,
      result: { ok: false, code: 'ERR_EXTENSION_SIGNAL_DENIED' },
    });
  });

  // Purpose: the other routes to the same harm are closed too: signal 0
  // (probing), the process group, the raw `_kill`, and renicing the host.
  it('refuses every other way to signal or renice its host', async () => {
    for (const [probeName, arg] of [
      ['signalParent', '0'],
      ['signalGroup', ''],
      ['rawKillParent', ''],
      ['reniceParent', ''],
    ] as const) {
      const outcome = await runHost('guarded', probeName, arg);
      expect(outcome.report?.result, probeName).toMatchObject({
        ok: false,
        code: 'ERR_EXTENSION_SIGNAL_DENIED',
      });
    }
  });

  // Purpose: signalling itself still works (nothing legitimate breaks).
  it('still lets it signal itself', async () => {
    const outcome = await runHost('guarded', 'signalSelf');
    expect(outcome.report?.result).toEqual({ ok: true, value: true });
  });
});
