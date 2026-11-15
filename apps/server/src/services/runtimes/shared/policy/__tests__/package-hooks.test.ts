import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { _internal, checkShellCommand } from '../package-hooks.js';
import { makeGuardProject, PACKAGE, type GuardProject } from './package-hook-fixture.js';

let project: GuardProject;
beforeEach(() => {
  project = makeGuardProject();
});
afterEach(() => project.cleanup());

function check(command: string | undefined) {
  return checkShellCommand(
    {
      runtime: 'opencode',
      cwd: project.dir,
      command,
      sessionId: 'session-1',
      permissionMode: 'bypassPermissions',
    },
    5_000
  );
}

describe('checkShellCommand', () => {
  it.each(['git stash', 'pkill -f vite'])('refuses %s with the guard’s own reason', async (cmd) => {
    project.install([{ event: 'PreToolUse', matcher: 'Bash', command: project.guardCommand }]);
    const verdict = await check(cmd);
    expect(verdict).toMatchObject({ allowed: false, packageName: PACKAGE });
    expect(!verdict.allowed && verdict.reason).toMatch(/^Blocked: /);
  });

  it('lets a command the guard does not match run', async () => {
    project.install([{ event: 'PreToolUse', matcher: 'Bash', command: project.guardCommand }]);
    expect(await check('git status')).toEqual({ allowed: true });
  });

  it('sends the stdin Claude Code sends a Bash PreToolUse hook', async () => {
    project.install([{ event: 'PreToolUse', matcher: 'Bash', command: project.guardCommand }]);
    await check('ls -la');
    expect(project.lastPayload()).toEqual({
      session_id: 'session-1',
      cwd: project.dir,
      hook_event_name: 'PreToolUse',
      permission_mode: 'bypassPermissions',
      tool_name: 'Bash',
      tool_input: { command: 'ls -la' },
    });
  });

  it('runs the guard in the project, with Claude Code’s variables set', async () => {
    project.install([
      { event: 'PreToolUse', matcher: 'Bash', command: 'echo "$CLAUDE_PROJECT_DIR" >&2; exit 2' },
    ]);
    expect(await check('ls')).toMatchObject({ reason: project.dir });
    project.install([{ event: 'PreToolUse', matcher: 'Bash', command: 'pwd -P >&2; exit 2' }]);
    expect(await check('ls')).toMatchObject({ reason: realpathSync(project.dir) });
    project.install([
      { event: 'PreToolUse', matcher: 'Bash', command: 'echo "$CLAUDE_PLUGIN_ROOT" >&2; exit 2' },
    ]);
    expect(await check('ls')).toMatchObject({
      reason: join(project.dir, '.dork', 'plugins', PACKAGE),
    });
  });

  it('fails closed when a guard crashes', async () => {
    project.install([
      { event: 'PreToolUse', matcher: 'Bash', command: `node -e "throw new Error('boom')"` },
    ]);
    const verdict = await check('ls');
    expect(verdict.allowed).toBe(false);
    expect(!verdict.allowed && verdict.reason).toMatch(
      new RegExp(`^A safety check from ${PACKAGE} failed with exit code 1`)
    );
  });

  it('fails closed when a guard does not finish in time', async () => {
    project.install([{ event: 'PreToolUse', matcher: 'Bash', command: 'sleep 5' }]);
    const verdict = await checkShellCommand(
      { runtime: 'doe', cwd: project.dir, command: 'ls', sessionId: 's' },
      200
    );
    expect(verdict).toEqual({
      allowed: false,
      packageName: PACKAGE,
      reason: `A safety check from ${PACKAGE} did not finish within 1 second, so this command was blocked.`,
    });
  });

  it.skipIf(process.platform === 'win32')(
    'stops the whole guard on a timeout, not only its shell',
    async () => {
      const pidFile = join(project.dir, 'grandchild.pid');
      project.install([
        {
          event: 'PreToolUse',
          matcher: 'Bash',
          command: `node -e "require('fs').writeFileSync('${pidFile}', String(process.pid)); setInterval(() => {}, 1000)"; true`,
        },
      ]);
      const verdict = await checkShellCommand(
        { runtime: 'doe', cwd: project.dir, command: 'ls', sessionId: 's' },
        1_000
      );
      expect(verdict).toMatchObject({ allowed: false });
      const pid = Number(readFileSync(pidFile, 'utf8'));
      await vi.waitFor(() => expect(() => process.kill(pid, 0)).toThrow());
    }
  );

  it('fails closed when the abort signal fires', async () => {
    project.install([{ event: 'PreToolUse', matcher: 'Bash', command: 'sleep 5' }]);
    const controller = new AbortController();
    const pending = checkShellCommand(
      {
        runtime: 'doe',
        cwd: project.dir,
        command: 'ls',
        sessionId: 's',
        signal: controller.signal,
      },
      5_000
    );
    controller.abort();
    expect(await pending).toMatchObject({ allowed: false });
  });

  it('honours a JSON deny decision on stdout from a guard that exits 0', async () => {
    project.install([
      {
        event: 'PreToolUse',
        matcher: 'Bash',
        command: `echo '{"hookSpecificOutput":{"permissionDecision":"deny","permissionDecisionReason":"Not here."}}'`,
      },
    ]);
    expect(await check('ls')).toEqual({
      allowed: false,
      packageName: PACKAGE,
      reason: 'Not here.',
    });
  });

  it('skips hooks for other tools and other events', async () => {
    project.install([
      { event: 'PreToolUse', matcher: 'Edit|Write', command: 'exit 2' },
      { event: 'PostToolUse', matcher: 'Bash', command: 'exit 2' },
      { event: 'PreToolUse', matcher: 'Bash', command: project.guardCommand },
    ]);
    expect(await check('ls')).toEqual({ allowed: true });
  });

  it('runs a hook with no matcher or a matcher pattern that covers Bash', async () => {
    project.install([{ event: 'PreToolUse', command: 'echo "every tool" >&2; exit 2' }]);
    expect(await check('ls')).toMatchObject({ allowed: false, reason: 'every tool' });
    project.install([
      { event: 'PreToolUse', matcher: 'Ba.*', command: 'echo "pattern" >&2; exit 2' },
    ]);
    expect(await check('ls')).toMatchObject({ allowed: false, reason: 'pattern' });
  });

  it('runs nothing a person has not been asked about', async () => {
    project.install(
      [{ event: 'PreToolUse', matcher: 'Bash', command: project.guardCommand }],
      'unasked'
    );
    expect(await check('git stash')).toEqual({ allowed: true });
    expect(project.lastPayload()).toBeUndefined();
  });

  it('runs nothing a person turned down', async () => {
    project.install(
      [{ event: 'PreToolUse', matcher: 'Bash', command: project.guardCommand }],
      'refused'
    );
    expect(await check('git stash')).toEqual({ allowed: true });
    expect(project.lastPayload()).toBeUndefined();
  });

  it('refuses a command it cannot read only when a shell check applies', async () => {
    project.install([{ event: 'PreToolUse', matcher: 'Bash', command: project.guardCommand }]);
    expect(await check(undefined)).toMatchObject({ allowed: false, packageName: 'DorkOS' });
    project.uninstall();
    expect(await check(undefined)).toEqual({ allowed: true });
  });

  it('fails closed when the consent lists cannot be read', async () => {
    project.install([{ event: 'PreToolUse', matcher: 'Bash', command: project.guardCommand }]);
    _internal.decisions = () => {
      throw new Error('config unreadable');
    };
    expect(await check('ls')).toMatchObject({ allowed: false, packageName: 'DorkOS' });
  });
});
