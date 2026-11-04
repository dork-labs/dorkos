/**
 * The shell guard's child process, for real (DOR-3300): what it answers, what ends it, and that no
 * way of ending it reads as "go ahead".
 *
 * @vitest-environment node
 */
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { resolveGuardChild } from '../guard-child-file.js';
import { GuardHost, type GuardHostOptions } from '../guard-host.js';
import type { ShellGuardRoots } from '../shell-check.js';

let root: string;
let roots: ShellGuardRoots;
let agent: string;
const hosts: GuardHost[] = [];

/** A host on the real child, stopped after the test. */
function hostWith(options: Partial<GuardHostOptions> = {}): GuardHost {
  const host = new GuardHost({
    childFile: resolveGuardChild,
    log: { warn: () => {} },
    ...options,
  });
  hosts.push(host);
  return host;
}

/** A child file of made-up behaviour. */
function fakeChild(name: string, body: string): string {
  const file = path.join(root, name);
  writeFileSync(file, body);
  return file;
}

const READY = `process.on('disconnect', () => process.exit(0)); process.send({ type: 'ready' });`;

beforeAll(() => {
  root = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'guard-host-')));
  agent = path.join(root, 'data', 'agents', 'scout');
  mkdirSync(path.join(agent, '.claude'), { recursive: true });
  mkdirSync(path.join(root, 'home', '.ssh'), { recursive: true });
  writeFileSync(path.join(root, 'home', '.ssh', 'id_ed25519'), '');
  roots = {
    cwd: root,
    dorkHome: path.join(root, 'data'),
    home: path.join(root, 'home'),
    accounts: [],
    env: {},
    agentHomes: () => [agent],
  };
});

afterEach(() => {
  for (const host of hosts.splice(0)) host.stop();
});

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

describe('GuardHost on the real child', () => {
  it('answers the same as the check does', async () => {
    const host = hostWith();
    expect(await host.check('echo hello', roots, true)).toEqual({
      outcome: 'checked',
      write: 'none',
      reaches: false,
    });
    expect(await host.check(`echo x > ${agent}/.claude/settings.json`, roots, true)).toEqual({
      outcome: 'checked',
      write: 'writes',
      reaches: false,
    });
    expect(await host.check('cat ~/.ssh/id_ed25519', roots, true)).toEqual({
      outcome: 'checked',
      write: 'none',
      reaches: true,
    });
    // At Full the read side isn't asked.
    expect(await host.check('cat ~/.ssh/id_ed25519', roots, false)).toMatchObject({
      reaches: false,
    });
  });

  it('sees an agent added after the host started', async () => {
    const host = hostWith();
    const later = path.join(root, 'elsewhere', 'later');
    const command = `rm ${later}/.mcp.json`;
    expect(await host.check(command, roots, false)).toMatchObject({ write: 'none' });
    expect(
      await host.check(command, { ...roots, agentHomes: () => [agent, later] }, false)
    ).toMatchObject({ write: 'writes' });
  });

  it('reads a variable the command names, from the launch', async () => {
    const host = hostWith();
    const command = 'echo x > $TARGET_DIR/.mcp.json';
    expect(
      await host.check(command, { ...roots, env: { TARGET_DIR: agent, OTHER_KEY: 'x' } }, false)
    ).toMatchObject({ write: 'writes' });
  });

  it('refuses a command past the child’s heap limit, and the next one still works', async () => {
    const host = hostWith({ tuning: { heapMb: 16, answerMs: 5_000 } });
    const answered = await host.check('echo first', roots, false);
    expect(answered.outcome).toBe('checked');
    const values = Array.from({ length: 5_000 }, (_, i) => `value${i}`).join(' ');
    const big = Array.from({ length: 40 }, (_, i) => `A${i}="${values}"`).join('; ');
    const crashed = await host.check(big, roots, false);
    expect(['failed', 'checked']).toContain(crashed.outcome);
    expect(crashed).not.toMatchObject({ write: 'none' });
    expect(await host.check('echo after', roots, false)).toMatchObject({ outcome: 'checked' });
  });
});

describe('GuardHost when a child misbehaves', () => {
  it('refuses a command a child never answers, after one retry', async () => {
    const childFile = vi.fn(async () => fakeChild('silent.cjs', READY));
    const host = hostWith({ childFile, tuning: { answerMs: 100 } });
    expect(await host.check('ls', roots, false)).toEqual({ outcome: 'failed' });
    expect(childFile).toHaveBeenCalledTimes(2);
  });

  it('refuses a command a child dies on, after one retry', async () => {
    const childFile = vi.fn(async () =>
      fakeChild('dies.cjs', `${READY} process.on('message', () => process.exit(3));`)
    );
    const host = hostWith({ childFile });
    expect(await host.check('ls', roots, false)).toEqual({ outcome: 'failed' });
    expect(childFile).toHaveBeenCalledTimes(2);
  });

  it.each([
    ['another id', `{ type: 'answer', id: 0, answer: { write: 'none', reaches: false } }`],
    ['no answer', `{ type: 'answer', id: m.id }`],
    [
      'a word it can’t know',
      `{ type: 'answer', id: m.id, answer: { write: 'ok', reaches: false } }`,
    ],
  ])('refuses %s', async (_name, reply) => {
    const file = fakeChild(
      'odd.cjs',
      `${READY} process.on('message', (m) => process.send(${reply}));`
    );
    const host = hostWith({ childFile: async () => file });
    expect(await host.check('ls', roots, false)).toEqual({ outcome: 'failed' });
  });

  it('holds nobody else up while one command stalls', async () => {
    const file = fakeChild(
      'stalls.cjs',
      `${READY} process.on('message', (m) => {
        if (m.command === 'stall') for (;;);
        process.send({ type: 'answer', id: m.id, answer: { write: 'none', reaches: false } });
      });`
    );
    const host = hostWith({ childFile: async () => file, tuning: { answerMs: 1_000 } });
    const stalled = host.check('stall', roots, false);
    expect(await host.check('ls', roots, false)).toMatchObject({ outcome: 'checked' });
    expect(await stalled).toEqual({ outcome: 'failed' });
  });

  it('gives each command past the limit a place in line, and refuses at the end of its wait', async () => {
    const file = fakeChild('stuck.cjs', READY);
    const host = hostWith({
      childFile: async () => file,
      tuning: { answerMs: 500, maxChildren: 1, queueMs: 50 },
    });
    const results = await Promise.all([
      host.check('one', roots, false),
      host.check('two', roots, false),
    ]);
    expect(results).toEqual([{ outcome: 'failed' }, { outcome: 'failed' }]);
  });

  it('never carries the launch’s other variables to the child', async () => {
    const file = fakeChild('echoes.cjs', READY);
    const host = hostWith({ childFile: async () => file });
    const send = vi.fn();
    const spy = vi
      .spyOn(host as unknown as { ask: (...args: unknown[]) => unknown }, 'ask')
      .mockImplementation((...args: unknown[]) => {
        send(args[2]);
        return Promise.resolve({ write: 'none', reaches: false });
      });
    await host.check('echo $NAMED', { ...roots, env: { NAMED: 'a', SECRET_KEY: 'b' } }, false);
    spy.mockRestore();
    expect(send.mock.calls[0]![0]).toMatchObject({ env: { NAMED: 'a' } });
    expect(JSON.stringify(send.mock.calls[0])).not.toContain('SECRET_KEY');
  });

  it('calls a command failed, not "no check", when the agent list can’t be read', async () => {
    const warn = vi.fn();
    const host = hostWith({ log: { warn } });
    const broken = {
      ...roots,
      agentHomes: () => {
        throw new Error(`could not read ${agent}`);
      },
    };
    expect(await host.check('ls', broken, false)).toEqual({ outcome: 'failed' });
    expect(JSON.stringify(warn.mock.calls)).not.toContain(agent);
  });
});

describe('GuardHost when no child can start', () => {
  it('never tells the person about crashes, however many', async () => {
    const onUnavailable = vi.fn();
    const file = fakeChild(
      'dies-too.cjs',
      `${READY} process.on('message', () => process.exit(3));`
    );
    const host = hostWith({ childFile: async () => file, onUnavailable });
    for (let i = 0; i < 4; i++) {
      expect(await host.check('ls', roots, false)).toEqual({ outcome: 'failed' });
    }
    expect(onUnavailable).not.toHaveBeenCalled();
    expect(host.unavailable).toBe(false);
  });

  it('says so, tells the person once, and recovers', async () => {
    let file = path.join(root, 'not-there.cjs');
    const onUnavailable = vi.fn();
    const onRecovered = vi.fn();
    const host = hostWith({
      childFile: async () => file,
      onUnavailable,
      onRecovered,
      tuning: { startRetryMs: 0 },
    });
    // Fork of a missing file exits without getting ready.
    expect(await host.check('ls', roots, false)).toEqual({ outcome: 'unavailable' });
    expect(host.unavailable).toBe(true);
    expect(await host.check('ls', roots, false)).toEqual({ outcome: 'unavailable' });
    expect(await host.check('ls', roots, false)).toEqual({ outcome: 'unavailable' });
    expect(onUnavailable).toHaveBeenCalledOnce();
    expect(onUnavailable).toHaveBeenCalledWith({ full: true });
    expect(onRecovered).not.toHaveBeenCalled();

    file = fakeChild(
      'works.cjs',
      `${READY} process.on('message', (m) => process.send({ type: 'answer', id: m.id, answer: { write: 'none', reaches: false } }));`
    );
    expect(await host.check('ls', roots, false)).toMatchObject({ outcome: 'checked' });
    expect(host.unavailable).toBe(false);
    expect(onRecovered).toHaveBeenCalledOnce();
  });

  it('doesn’t fork on every command while it can’t start', async () => {
    const childFile = vi.fn(async () => {
      throw new Error('gone');
    });
    const host = hostWith({ childFile, tuning: { startRetryMs: 60_000 } });
    await host.check('ls', roots, false);
    expect(childFile).toHaveBeenCalledTimes(2);
    expect(await host.check('ls', roots, false)).toEqual({ outcome: 'unavailable' });
    expect(childFile).toHaveBeenCalledTimes(2);
  });

  it('won’t call a child ready if it holds power it was promised it wouldn’t', async () => {
    // The real child, started without the permission flags, must not say it is ready.
    const { fork } = await import('node:child_process');
    const child = fork(await resolveGuardChild(), [], {
      execArgv: [],
      env: {},
      stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
    });
    const code = await new Promise<number | null>((resolve) => {
      child.once('exit', (exitCode) => resolve(exitCode));
      child.once('message', () => {
        child.kill('SIGKILL');
        resolve(-1);
      });
    });
    expect(code).toBe(1);
  });

  it('can’t change a file from inside the real child', async () => {
    // The flags the host uses, on a one-line child that reports what they allow.
    const report = fakeChild(
      'report.cjs',
      `const fs = require('fs');
       let wrote = true;
       try { fs.writeFileSync(${JSON.stringify(path.join(root, 'written.txt'))}, 'x'); } catch { wrote = false; }
       let spawned = true;
       try { require('child_process').execFileSync('/bin/echo'); } catch { spawned = false; }
       process.send({ wrote, spawned, read: fs.existsSync(${JSON.stringify(agent)}) });`
    );
    const { fork } = await import('node:child_process');
    const child = fork(report, [], {
      execArgv: ['--permission', '--allow-fs-read=*'],
      env: {},
      stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
    });
    const seen = await new Promise((resolve) => child.once('message', resolve));
    expect(seen).toEqual({ wrote: false, spawned: false, read: true });
  });
});
