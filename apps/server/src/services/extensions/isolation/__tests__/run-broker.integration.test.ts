/**
 * RunBroker through a real isolated child (DOR-2686 task 3.4): the child's
 * `child_process` shim asks the host, and the host runs only declared
 * programs, only in folders the extension may use, at most 8 at a time, and
 * stops them all when the extension stops. Real processes throughout.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import { isolatedFilesDir } from '../grants.js';
import { SYNC_RUN_REFUSAL } from '../ipc-protocol.js';
import { RUN_CWD_REFUSAL, RUN_TOO_MANY } from '../run-broker.js';
import {
  cleanup,
  createHarness,
  makeHost,
  probe,
  runControl,
  startOk,
  type Harness,
} from './isolation-harness.js';

const DENIED = 'ERR_EXTENSION_RUN_DENIED';
const posix = process.platform !== 'win32';

/**
 * Whether a process is still alive.
 *
 * @param pid - A process this test's child started.
 */
function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

describe('RunBroker (real isolated child)', () => {
  let h: Harness;

  beforeEach(async () => {
    h = await createHarness();
  });

  afterEach(async () => {
    await cleanup(h);
  });

  // Purpose: a declared program runs and streams its output and exit code
  // back; an undeclared one is refused by name, though the control runs it.
  it.skipIf(!posix)('runs declared programs and refuses the rest', async () => {
    const host = makeHost(h, { run: ['/bin/echo', 'sh'] });
    await startOk(host);
    expect(await probe(host, 'run', '/bin/echo', ['hello', 'world'])).toMatchObject({
      ok: true,
      value: { code: 0, stdout: 'hello world\n' },
    });
    expect(await probe(host, 'run', 'sh', ['-c', 'exit 3'])).toMatchObject({
      ok: true,
      value: { code: 3 },
    });
    expect(await probe(host, 'run', '/bin/cat', ['/etc/hosts'])).toMatchObject({
      ok: false,
      code: DENIED,
      message: "/bin/cat isn't in this extension's allow.run list.",
    });
    expect(await probe(host, 'execFile', '/bin/echo', ['via execFile'])).toEqual({
      ok: true,
      value: 'via execFile\n',
    });
    expect((await runControl(h, 'run', '/bin/cat', ['/etc/hosts'])).ok).toBe(true);
  });

  // Purpose: exec runs the shell, so it needs `sh` declared itself.
  it.skipIf(!posix)('needs sh declared for exec', async () => {
    const without = makeHost(h, { run: ['/bin/echo'] });
    await startOk(without);
    expect(await probe(without, 'exec', 'echo hi')).toMatchObject({
      ok: false,
      code: DENIED,
      message: "sh isn't in this extension's allow.run list.",
    });
    const withSh = makeHost(h, { run: ['sh'] });
    await startOk(withSh);
    expect(await probe(withSh, 'exec', 'echo hi')).toEqual({ ok: true, value: 'hi\n' });
  });

  // Purpose: programs run only in the extension's files folder (the default)
  // or a project root; anywhere else is refused.
  it.skipIf(!posix)('confines the working folder', async () => {
    const host = makeHost(h, { id: 'cwd', run: ['/bin/pwd'] });
    await startOk(host);
    const files = await fs.realpath(isolatedFilesDir(h.dorkHome, 'cwd'));
    expect(await probe(host, 'run', '/bin/pwd', [])).toMatchObject({
      ok: true,
      value: { stdout: `${files}\n` },
    });
    await fs.mkdir(path.join(files, 'sub'));
    expect(
      await probe(host, 'run', '/bin/pwd', [], { cwd: path.join(files, 'sub') })
    ).toMatchObject({
      ok: true,
      value: { stdout: `${path.join(files, 'sub')}\n` },
    });
    expect(await probe(host, 'run', '/bin/pwd', [], { cwd: h.dorkHome })).toMatchObject({
      ok: false,
      message: RUN_CWD_REFUSAL,
    });
  });

  // Purpose: a project root the host hands the broker is usable too.
  it.skipIf(!posix)('allows a project root it was given', async () => {
    const project = path.join(h.tmp, 'project');
    await fs.mkdir(project);
    const host = makeHost(h, {
      run: ['/bin/pwd'],
      overrides: { projectRoots: async () => [project] },
    });
    await startOk(host);
    expect(await probe(host, 'run', '/bin/pwd', [], { cwd: project })).toMatchObject({
      ok: true,
      value: { stdout: `${project}\n` },
    });
  });

  // Purpose: at most 8 programs at once; the ninth is refused.
  it.skipIf(!posix)('caps concurrent programs at 8', async () => {
    const host = makeHost(h, { run: ['/bin/sleep'] });
    await startOk(host);
    const pids: number[] = [];
    for (let i = 0; i < 8; i++) {
      const started = await probe(host, 'startLong', '/bin/sleep', ['30']);
      expect(started.ok).toBe(true);
      pids.push(started.value as number);
    }
    expect(await probe(host, 'startLong', '/bin/sleep', ['30'])).toMatchObject({
      ok: false,
      message: RUN_TOO_MANY,
    });
    expect(pids.every(alive)).toBe(true);
  });

  // Purpose: stopping the extension stops every program it started (and only
  // those: each is signalled through the process the broker spawned).
  it.skipIf(!posix)('kills its programs when it stops', async () => {
    const host = makeHost(h, { run: ['/bin/sleep'] });
    await startOk(host);
    const started = await probe(host, 'startLong', '/bin/sleep', ['30']);
    const pid = started.value as number;
    expect(alive(pid)).toBe(true);
    await host.stop();
    const deadline = Date.now() + 3_000;
    while (alive(pid) && Date.now() < deadline) await new Promise((r) => setTimeout(r, 50));
    expect(alive(pid)).toBe(false);
  });

  // Purpose: a program inside the extension's own files is never run, even
  // when declared by absolute path (an update could swap it silently).
  it.skipIf(!posix)("refuses a program inside the extension's files", async () => {
    const extDir = path.join(h.tmp, 'ext', 'shipper');
    await fs.mkdir(extDir, { recursive: true });
    const tool = path.join(extDir, 'tool.sh');
    await fs.writeFile(tool, '#!/bin/sh\necho shipped\n');
    await fs.chmod(tool, 0o755);
    const host = makeHost(h, { id: 'shipper', extensionDir: extDir, run: [tool] });
    await startOk(host);
    const report = await probe(host, 'run', tool, []);
    expect(report).toMatchObject({ ok: false, code: DENIED });
    expect(report.message).toContain("can't run on this computer.");
  });

  // Purpose: a run-time resolution that differs from what discovery showed
  // the person is logged (here discovery "saw" a different file).
  it.skipIf(!posix)('logs when a program resolves differently than at discovery', async () => {
    const host = makeHost(h, {
      run: ['sh'],
      resolvedRun: [{ name: 'sh', path: '/opt/elsewhere/sh' }],
    });
    await startOk(host);
    await probe(host, 'exec', 'true');
    expect(
      h.logs.some((l) => l.level === 'warn' && l.message.includes('allow.run "sh" now resolves to'))
    ).toBe(true);
  });

  // Purpose: synchronous forms cannot be brokered and say so exactly.
  it('refuses synchronous child-process calls with the exact message', async () => {
    const host = makeHost(h, { run: ['sh'] });
    await startOk(host);
    for (const name of ['shimExecSync', 'shimSpawnSync', 'shimFork']) {
      expect(await probe(host, name)).toMatchObject({ ok: false, message: SYNC_RUN_REFUSAL });
    }
  });

  // Purpose: the Windows path — cmd runs through the broker with the same rules.
  it.skipIf(posix)('runs cmd on Windows when declared', async () => {
    const host = makeHost(h, { run: ['cmd'] });
    await startOk(host);
    const report = await probe(host, 'exec', 'echo hi');
    expect(report.ok).toBe(true);
    expect(String(report.value).trim()).toBe('hi');
    const refused = makeHost(h, { run: [] });
    await startOk(refused);
    expect(await probe(refused, 'exec', 'echo hi')).toMatchObject({ ok: false, code: DENIED });
  });
});
