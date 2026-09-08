import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'node:events';

vi.mock('../../claude-code/sdk/sdk-utils.js', () => ({
  resolveClaudeCliPath: vi.fn(),
}));

vi.mock('../../claude-code/claude-config-dir.js', () => ({
  resolveActiveClaudeRoot: vi.fn(),
  resolveClaudeRootSet: vi.fn(),
  claudeConfigDirEnv: vi.fn(),
}));

vi.mock('../../../observability/index.js', () => ({
  noteSigninRepaired: vi.fn(),
}));

import {
  runDelegatedLogin,
  pipeSecretToChild,
  delegateRuntimeLogin,
  resolveLoginCommand,
  type SpawnFn,
} from '../delegated-login.js';
import { resolveClaudeCliPath } from '../../claude-code/sdk/sdk-utils.js';
import {
  resolveActiveClaudeRoot,
  resolveClaudeRootSet,
  claudeConfigDirEnv,
} from '../../claude-code/claude-config-dir.js';
import { noteSigninRepaired } from '../../../observability/index.js';

/**
 * Minimal ChildProcess double: an EventEmitter (for `once('exit'|'error')`) plus
 * a stderr emitter, a stdin sink, and a `kill` spy. Enough for the login helpers.
 */
class FakeChild extends EventEmitter {
  stdin = { end: vi.fn() };
  stderr = new EventEmitter();
  kill = vi.fn();
}

/** One recorded spawn invocation, options included so env can be asserted. */
interface SpawnCall {
  cmd: string;
  args: string[];
  options?: { env?: NodeJS.ProcessEnv };
}

/** A spawn double that records its args (+ options) and hands back a controllable child. */
function fakeSpawn(child: FakeChild): {
  spawn: SpawnFn;
  calls: SpawnCall[];
} {
  const calls: SpawnCall[] = [];
  const spawn = ((cmd: string, args: string[], options?: { env?: NodeJS.ProcessEnv }) => {
    calls.push({ cmd, args, options });
    return child;
  }) as unknown as SpawnFn;
  return { spawn, calls };
}

describe('runDelegatedLogin', () => {
  it('resolves ok when the login CLI exits 0', async () => {
    const child = new FakeChild();
    const { spawn, calls } = fakeSpawn(child);
    const p = runDelegatedLogin({ binary: '/bin/codex', args: ['login'] }, { spawn });
    child.emit('exit', 0);
    await expect(p).resolves.toEqual({ ok: true });
    expect(calls[0].cmd).toBe('/bin/codex');
    expect(calls[0].args).toEqual(['login']);
    // Even a direct login command without overrides gets a complete projection.
    expect(calls[0].options?.env).toBeDefined();
    expect(calls[0].options?.env).not.toHaveProperty('MCP_API_KEY');
  });

  it('forwards an explicit command env to the spawned child (the account pin)', async () => {
    const child = new FakeChild();
    const { spawn, calls } = fakeSpawn(child);
    const pinnedEnv = { CLAUDE_CONFIG_DIR: '/Users/x/.claude2' };
    const p = runDelegatedLogin(
      { binary: '/bin/claude', args: ['auth', 'login'], env: pinnedEnv },
      { spawn }
    );
    child.emit('exit', 0);
    await p;
    expect(calls[0].options?.env).toBe(pinnedEnv);
  });

  it('resolves an honest failure when the CLI exits non-zero', async () => {
    const child = new FakeChild();
    const { spawn } = fakeSpawn(child);
    const p = runDelegatedLogin({ binary: '/bin/codex', args: ['login'] }, { spawn });
    child.stderr.emit('data', Buffer.from('authentication cancelled\nmore detail'));
    child.emit('exit', 1);
    const result = await p;
    expect(result.ok).toBe(false);
    // Condensed to the first line, no raw multi-line dump.
    expect(result.error).toContain('authentication cancelled');
    expect(result.error).not.toContain('more detail');
  });

  it('resolves an honest failure on spawn error', async () => {
    const child = new FakeChild();
    const { spawn } = fakeSpawn(child);
    const p = runDelegatedLogin({ binary: '/bin/nope', args: ['login'] }, { spawn });
    child.emit('error', new Error('ENOENT'));
    const result = await p;
    expect(result.ok).toBe(false);
    expect(result.error).toBeTruthy();
  });

  describe('with fake timers', () => {
    beforeEach(() => vi.useFakeTimers());
    afterEach(() => vi.useRealTimers());

    it('bounds a hung login by the timeout, kills the child, and degrades honestly', async () => {
      const child = new FakeChild();
      const { spawn } = fakeSpawn(child);
      const p = runDelegatedLogin(
        { binary: '/bin/codex', args: ['login'] },
        { spawn, timeoutMs: 1000 }
      );
      // Never emit 'exit' — simulate a login the user never completes.
      vi.advanceTimersByTime(1000);
      const result = await p;
      expect(result.ok).toBe(false);
      expect(result.error).toMatch(/timed out/i);
      expect(child.kill).toHaveBeenCalledWith('SIGKILL');
    });
  });
});

describe('pipeSecretToChild', () => {
  it('writes the secret to stdin — never to argv — and resolves ok on exit 0', async () => {
    const child = new FakeChild();
    const { spawn, calls } = fakeSpawn(child);
    const secret = 'sk-super-secret-value';
    const p = pipeSecretToChild(
      { binary: '/bin/codex', args: ['login', '--with-api-key'] },
      secret,
      { spawn }
    );
    child.emit('exit', 0);
    await expect(p).resolves.toEqual({ ok: true });
    // Secret reached stdin, and NEVER appeared on the command line.
    expect(child.stdin.end).toHaveBeenCalledWith(secret);
    expect(calls[0].args.join(' ')).not.toContain(secret);
  });

  it('resolves an honest failure when the apply exits non-zero', async () => {
    const child = new FakeChild();
    const { spawn } = fakeSpawn(child);
    const p = pipeSecretToChild(
      { binary: '/bin/codex', args: ['login', '--with-api-key'] },
      's3cret',
      { spawn }
    );
    child.stderr.emit('data', Buffer.from('invalid api key'));
    child.emit('exit', 1);
    const result = await p;
    expect(result.ok).toBe(false);
    expect(result.error).toContain('invalid api key');
  });
});

describe('resolveLoginCommand (claude-code)', () => {
  beforeEach(() => {
    // resetAllMocks (not clearAllMocks): clearAllMocks only wipes call
    // history, it leaves a prior test's mockReturnValue/mockImplementation in
    // place — resolveClaudeRootSet in particular is set by a later describe
    // in this file, and a plain clear would let that leak forward/backward
    // across tests that share this module-level mock.
    vi.resetAllMocks();
  });

  it('returns null when the claude CLI cannot be resolved, without consulting an account', async () => {
    vi.mocked(resolveClaudeCliPath).mockReturnValue(undefined);
    const cmd = await resolveLoginCommand('claude-code');
    expect(cmd).toBeNull();
    expect(resolveActiveClaudeRoot).not.toHaveBeenCalled();
  });

  it('pins the spawn env to the active account when no explicit root is given', async () => {
    vi.mocked(resolveClaudeCliPath).mockReturnValue('/bin/claude');
    vi.mocked(resolveActiveClaudeRoot).mockReturnValue('/Users/x/.claude');
    vi.mocked(claudeConfigDirEnv).mockReturnValue({ CLAUDE_CONFIG_DIR: '/Users/x/.claude' });

    const cmd = await resolveLoginCommand('claude-code');

    expect(cmd?.binary).toBe('/bin/claude');
    expect(cmd?.args).toEqual(['auth', 'login']);
    expect(cmd?.env?.CLAUDE_CONFIG_DIR).toBe('/Users/x/.claude');
    expect(claudeConfigDirEnv).toHaveBeenCalledWith('/Users/x/.claude');
    expect(resolveActiveClaudeRoot).toHaveBeenCalled();
  });

  it('erases CLAUDE_CONFIG_DIR (rather than inheriting the server process env) when claudeConfigDirEnv says so', async () => {
    vi.mocked(resolveClaudeCliPath).mockReturnValue('/bin/claude');
    vi.mocked(resolveActiveClaudeRoot).mockReturnValue('/Users/x/.claude');
    // The documented default-root case: undefined erases rather than inherits.
    vi.mocked(claudeConfigDirEnv).mockReturnValue({ CLAUDE_CONFIG_DIR: undefined });

    const cmd = await resolveLoginCommand('claude-code');

    expect(cmd?.env).not.toHaveProperty('CLAUDE_CONFIG_DIR');
  });

  it('uses an explicit accountRoot instead of the active account, without calling resolveActiveClaudeRoot', async () => {
    vi.mocked(resolveClaudeCliPath).mockReturnValue('/bin/claude');
    vi.mocked(claudeConfigDirEnv).mockReturnValue({ CLAUDE_CONFIG_DIR: '/Users/x/.claude2' });

    const cmd = await resolveLoginCommand('claude-code', { accountRoot: '/Users/x/.claude2' });

    expect(cmd?.env?.CLAUDE_CONFIG_DIR).toBe('/Users/x/.claude2');
    expect(claudeConfigDirEnv).toHaveBeenCalledWith('/Users/x/.claude2');
    expect(resolveActiveClaudeRoot).not.toHaveBeenCalled();
  });
});

describe('delegateRuntimeLogin', () => {
  it('returns an honest not-available state when the CLI cannot be resolved', async () => {
    const result = await delegateRuntimeLogin('codex', {
      resolveCommand: async () => null,
    });
    expect(result).toEqual({ ok: false, error: expect.stringContaining('codex') });
  });

  it('spawns the resolved command and detects completion', async () => {
    // resolveCommand is async, so the spawn (and its listeners) attach a tick
    // later — schedule the exit from the spawn itself so it never races ahead.
    const child = new FakeChild();
    const calls: Array<{ cmd: string; args: string[] }> = [];
    const spawn = ((cmd: string, args: string[]) => {
      calls.push({ cmd, args });
      queueMicrotask(() => child.emit('exit', 0));
      return child;
    }) as unknown as SpawnFn;

    const result = await delegateRuntimeLogin('claude-code', {
      spawn,
      resolveCommand: async () => ({ binary: '/bin/claude', args: ['auth', 'login'] }),
    });
    expect(result).toEqual({ ok: true });
    expect(calls[0]).toEqual({ cmd: '/bin/claude', args: ['auth', 'login'] });
  });

  describe('with an explicit accountRoot', () => {
    beforeEach(() => {
      // resetAllMocks, not clearAllMocks — see the sibling comment on
      // `resolveLoginCommand (claude-code)` above: a bare clear leaves
      // resolveClaudeRootSet's mockReturnValue from a previous test in place.
      vi.resetAllMocks();
    });

    it('rejects a non-claude-code type outright, without consulting known roots or spawning', async () => {
      const resolveCommand = vi.fn();
      const spawn = vi.fn() as unknown as SpawnFn;

      const result = await delegateRuntimeLogin('codex', {
        accountRoot: '/Users/x/.claude',
        resolveCommand,
        spawn,
      });

      expect(result.ok).toBe(false);
      expect(result.error).toContain('codex');
      // The type gate is checked BEFORE the known-roots check, so a root that
      // would otherwise be valid never even reaches resolveClaudeRootSet.
      expect(resolveClaudeRootSet).not.toHaveBeenCalled();
      expect(resolveCommand).not.toHaveBeenCalled();
      expect(spawn).not.toHaveBeenCalled();
    });

    it('rejects a root the known-roots resolver does not recognize, without spawning', async () => {
      vi.mocked(resolveClaudeRootSet).mockReturnValue(['/Users/x/.claude']);
      const resolveCommand = vi.fn();
      const spawn = vi.fn() as unknown as SpawnFn;

      const result = await delegateRuntimeLogin('claude-code', {
        accountRoot: '/etc/passwd',
        resolveCommand,
        spawn,
      });

      expect(result.ok).toBe(false);
      expect(result.error).toBeTruthy();
      expect(resolveCommand).not.toHaveBeenCalled();
      expect(spawn).not.toHaveBeenCalled();
    });

    it('forwards a recognized root to the command resolver', async () => {
      vi.mocked(resolveClaudeRootSet).mockReturnValue(['/Users/x/.claude', '/Users/x/.claude2']);
      const child = new FakeChild();
      // resolveCommand is async, so spawn (and its listeners) attach a tick
      // later — schedule the exit from the spawn itself, same as the sibling
      // "spawns the resolved command" test above, so it never races ahead.
      const calls: SpawnCall[] = [];
      const spawn = ((cmd: string, args: string[], options?: { env?: NodeJS.ProcessEnv }) => {
        calls.push({ cmd, args, options });
        queueMicrotask(() => child.emit('exit', 0));
        return child;
      }) as unknown as SpawnFn;
      const resolveCommand = vi.fn(async () => ({
        binary: '/bin/claude',
        args: ['auth', 'login'],
      }));

      const result = await delegateRuntimeLogin('claude-code', {
        accountRoot: '/Users/x/.claude2',
        resolveCommand,
        spawn,
      });

      expect(result).toEqual({ ok: true });
      expect(resolveCommand).toHaveBeenCalledWith('claude-code', {
        accountRoot: '/Users/x/.claude2',
      });
      expect(calls[0].cmd).toBe('/bin/claude');
    });
  });

  /**
   * A completed sign-in stands the "sign-in stopped working" notice down
   * (DOR-1910).
   *
   * Before this, the ONLY way that notice ended was a later turn that happened
   * to run on the same Claude account — so an operator who signed in, and even
   * checked that Claude answered, could be left with an undismissable banner
   * about a credential they had already fixed, because the session they tested
   * with was bound to a different account.
   */
  describe('reporting the sign-in it just completed', () => {
    beforeEach(() => {
      vi.resetAllMocks();
    });

    it('names the account a claude-code login actually wrote to', async () => {
      vi.mocked(resolveClaudeRootSet).mockReturnValue(['/Users/x/.claude', '/Users/x/.claude2']);
      const child = new FakeChild();
      const spawn = (() => {
        queueMicrotask(() => child.emit('exit', 0));
        return child;
      }) as unknown as SpawnFn;

      await delegateRuntimeLogin('claude-code', {
        accountRoot: '/Users/x/.claude2',
        resolveCommand: async () => ({ binary: '/bin/claude', args: ['auth', 'login'] }),
        spawn,
      });

      expect(noteSigninRepaired).toHaveBeenCalledWith('claude-code', '/Users/x/.claude2');
    });

    it('falls back to the account DorkOS runs new sessions on', async () => {
      // The reported case: Settings carries no account pin, so the login goes to
      // the active root — and that is the account the condition is about.
      vi.mocked(resolveActiveClaudeRoot).mockReturnValue('/Users/x/.claude');
      const child = new FakeChild();
      const spawn = (() => {
        queueMicrotask(() => child.emit('exit', 0));
        return child;
      }) as unknown as SpawnFn;

      await delegateRuntimeLogin('claude-code', {
        resolveCommand: async () => ({ binary: '/bin/claude', args: ['auth', 'login'] }),
        spawn,
      });

      expect(noteSigninRepaired).toHaveBeenCalledWith('claude-code', '/Users/x/.claude');
    });

    it('names no account for a runtime that has none', async () => {
      const child = new FakeChild();
      const spawn = (() => {
        queueMicrotask(() => child.emit('exit', 0));
        return child;
      }) as unknown as SpawnFn;

      await delegateRuntimeLogin('codex', {
        resolveCommand: async () => ({ binary: '/bin/codex', args: ['login'] }),
        spawn,
      });

      expect(noteSigninRepaired).toHaveBeenCalledWith('codex', undefined);
    });

    it('says nothing when the login did not complete', async () => {
      const child = new FakeChild();
      const spawn = (() => {
        queueMicrotask(() => child.emit('exit', 1));
        return child;
      }) as unknown as SpawnFn;

      const result = await delegateRuntimeLogin('codex', {
        resolveCommand: async () => ({ binary: '/bin/codex', args: ['login'] }),
        spawn,
      });

      expect(result.ok).toBe(false);
      expect(noteSigninRepaired).not.toHaveBeenCalled();
    });
  });

  describe('one login at a time (DOR-1651)', () => {
    beforeEach(() => {
      vi.resetAllMocks();
    });

    /** A login that only settles when the returned `finish` is called. */
    function heldLogin() {
      const child = new FakeChild();
      const calls: SpawnCall[] = [];
      const spawn = ((cmd: string, args: string[], options?: { env?: NodeJS.ProcessEnv }) => {
        calls.push({ cmd, args, options });
        return child;
      }) as unknown as SpawnFn;
      return {
        calls,
        spawn,
        resolveCommand: async () => ({ binary: '/bin/claude', args: ['auth', 'login'] }),
        finish: (code = 0) => child.emit('exit', code),
      };
    }

    it('joins a second request for the same account to the attempt already running', async () => {
      // Purpose: there is one vendor CLI and one browser flow. The inline card
      // put a Sign in button on every hydrated auth-error row, times every open
      // tab, so concurrent presses are now ordinary rather than exotic — and two
      // spawns means two browser windows, one of them orphaned.
      const login = heldLogin();

      const first = delegateRuntimeLogin('claude-code', login);
      const second = delegateRuntimeLogin('claude-code', login);
      // Let both reach the latch before anything settles.
      await Promise.resolve();
      login.finish(0);

      expect(await first).toEqual({ ok: true });
      // The joiner gets the SAME outcome, not a second sign-in.
      expect(await second).toEqual({ ok: true });
      expect(login.calls).toHaveLength(1);
    });

    it('refuses a second request for a DIFFERENT account rather than answering for it', async () => {
      // Purpose: sharing the in-flight promise across accounts would report a
      // completed sign-in for an account nobody signed into — the DOR-1652 bug
      // wearing a different hat. One CLI means the honest answer is "not now".
      vi.mocked(resolveClaudeRootSet).mockReturnValue(['/Users/x/.claude', '/Users/x/.claude2']);
      const login = heldLogin();

      const first = delegateRuntimeLogin('claude-code', {
        ...login,
        accountRoot: '/Users/x/.claude',
      });
      await Promise.resolve();
      const second = await delegateRuntimeLogin('claude-code', {
        ...login,
        accountRoot: '/Users/x/.claude2',
      });

      expect(second.ok).toBe(false);
      expect(second.error).toContain('already in progress');
      login.finish(0);
      expect(await first).toEqual({ ok: true });
      expect(login.calls).toHaveLength(1);
    });

    it('releases the latch once a login settles, so the next one can run', async () => {
      // Purpose: a latch that leaks wedges the runtime forever — including
      // after the bounded timeout, which is the case most likely to strand
      // someone who then cannot retry at all.
      const first = heldLogin();
      const running = delegateRuntimeLogin('claude-code', first);
      await Promise.resolve();
      first.finish(1);
      expect((await running).ok).toBe(false);

      const second = heldLogin();
      const next = delegateRuntimeLogin('claude-code', second);
      await Promise.resolve();
      second.finish(0);

      expect(await next).toEqual({ ok: true });
      expect(second.calls).toHaveLength(1);
    });

    it('does not latch one runtime behind another', async () => {
      // Purpose: the constraint is per-CLI. Signing Claude in must not block
      // signing Codex in — they are different binaries and different browsers.
      const claude = heldLogin();
      const codex = heldLogin();

      const claudeRun = delegateRuntimeLogin('claude-code', claude);
      const codexRun = delegateRuntimeLogin('codex', codex);
      await Promise.resolve();
      claude.finish(0);
      codex.finish(0);

      expect(await claudeRun).toEqual({ ok: true });
      expect(await codexRun).toEqual({ ok: true });
      expect(claude.calls).toHaveLength(1);
      expect(codex.calls).toHaveLength(1);
    });
  });
});

describe('resolved login environment boundary', () => {
  afterEach(() => vi.unstubAllEnvs());
  it('preserves the Claude account pin and model credential without unrelated server authority', async () => {
    vi.stubEnv('MCP_API_KEY', 'synthetic-server');
    vi.stubEnv('NANGO_ENCRYPTION_KEY', 'synthetic-encryption');
    vi.stubEnv('ANTHROPIC_API_KEY', 'synthetic-model');
    vi.stubEnv('DO_NOT_TRACK', '1');
    vi.mocked(resolveClaudeCliPath).mockReturnValue('/synthetic/claude');
    vi.mocked(resolveActiveClaudeRoot).mockReturnValue('/synthetic/account');
    vi.mocked(claudeConfigDirEnv).mockReturnValue({ CLAUDE_CONFIG_DIR: '/synthetic/account' });
    const command = await resolveLoginCommand('claude-code');
    const child = new FakeChild();
    const { spawn, calls } = fakeSpawn(child);
    expect(command).not.toBeNull();
    const completion = runDelegatedLogin(command!, { spawn });
    child.emit('exit', 0);
    await expect(completion).resolves.toEqual({ ok: true });
    expect(calls[0].options?.env).toMatchObject({
      CLAUDE_CONFIG_DIR: '/synthetic/account',
      ANTHROPIC_API_KEY: 'synthetic-model',
      DO_NOT_TRACK: '1',
    });
    expect(calls[0].options?.env).not.toHaveProperty('MCP_API_KEY');
    expect(calls[0].options?.env).not.toHaveProperty('NANGO_ENCRYPTION_KEY');
    expect(JSON.stringify(calls[0].args)).not.toContain('synthetic-model');
  });
});
