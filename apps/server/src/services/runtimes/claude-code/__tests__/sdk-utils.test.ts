import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { resolveClaudeCliPath, createIdlePrompt, createHeldUserPrompt } from '../sdk/sdk-utils.js';

// Mutable holder so each test can steer the three resolution primitives.
// `exists` accepts either a flat boolean (every path exists / none do) or a
// per-path predicate — the env-override tests need to say "the override path
// is missing but the bundled one exists", which a single boolean can't express.
const h = vi.hoisted(() => ({
  resolve: ((_s: string): string => {
    throw new Error('not found');
  }) as (s: string) => string,
  exists: true as boolean | ((path: string) => boolean),
  which: null as string | null,
}));

vi.mock('node:module', () => ({
  createRequire: () => ({ resolve: (s: string) => h.resolve(s) }),
}));

vi.mock('node:fs', () => ({
  existsSync: (path: string) => (typeof h.exists === 'function' ? h.exists(path) : h.exists),
}));

/** Env var the packaged desktop app sets to an explicit `claude` binary path. */
const CLI_PATH_ENV = 'DORKOS_CLAUDE_CLI_PATH';

vi.mock('node:child_process', () => ({
  execFileSync: () => {
    if (h.which === null) throw new Error('not on PATH');
    return h.which;
  },
}));

describe('resolveClaudeCliPath — Hybrid native-binary resolution', () => {
  // Capture and clear the override env var so no test's setting can leak into
  // the next (or into the pre-existing cases, which assume it is unset).
  let savedEnv: string | undefined;
  beforeEach(() => {
    savedEnv = process.env[CLI_PATH_ENV];
    delete process.env[CLI_PATH_ENV];
    h.resolve = () => {
      throw new Error('not found');
    };
    h.exists = true;
    h.which = null;
  });
  afterEach(() => {
    if (savedEnv === undefined) delete process.env[CLI_PATH_ENV];
    else process.env[CLI_PATH_ENV] = savedEnv;
  });

  // Purpose: the packaged desktop app hands the server an explicit binary path
  // (require.resolve can't reach the SDK's optional dep there) — it must win
  // over the SDK's own bundled resolution, even when that would also succeed.
  it('prefers the DORKOS_CLAUDE_CLI_PATH override over the bundled binary when the file exists', () => {
    process.env[CLI_PATH_ENV] = '/opt/dorkos/claude';
    h.exists = () => true; // both the override and the bundled path "exist"
    h.resolve = () => '/pkgs/claude-agent-sdk/claude'; // present, but must be ignored
    h.which = '/usr/local/bin/claude'; // present, but must be ignored

    expect(resolveClaudeCliPath()).toBe('/opt/dorkos/claude');
  });

  // Purpose: an override that points at a missing file is not trusted — the
  // existing bundled→PATH→undefined order must resume unchanged.
  it('falls through to the bundled binary when the override path does not exist', () => {
    process.env[CLI_PATH_ENV] = '/opt/dorkos/claude';
    h.exists = (p) => p !== '/opt/dorkos/claude'; // override missing, bundled present
    h.resolve = () => '/pkgs/claude-agent-sdk/claude';
    h.which = null;

    expect(resolveClaudeCliPath()).toBe('/pkgs/claude-agent-sdk/claude');
  });

  // Purpose: a missing override must not mask the terminal `undefined` — the
  // whole order still resolves exactly as it would without the env var set.
  it('with the override missing and nothing else resolvable, returns undefined', () => {
    process.env[CLI_PATH_ENV] = '/opt/dorkos/claude';
    h.exists = () => false; // override missing; bundled resolve throws below
    h.resolve = () => {
      throw new Error('not found');
    };
    h.which = null;

    expect(resolveClaudeCliPath()).toBeUndefined();
  });

  // Purpose: with the override unset (the dev/CLI default), resolution is
  // byte-for-byte the prior behavior — the bundled binary still wins.
  it('ignores an unset override and resolves exactly as before (bundled wins)', () => {
    // beforeEach already deletes the env var.
    h.resolve = () => '/pkgs/claude-agent-sdk/claude';
    h.which = '/usr/local/bin/claude';

    expect(resolveClaudeCliPath()).toBe('/pkgs/claude-agent-sdk/claude');
  });

  // Purpose: prefer the SDK's version-matched bundled binary over an unrelated global install
  it('prefers the bundled native binary when installed', () => {
    h.resolve = (s) => {
      expect(s).toMatch(/^@anthropic-ai\/claude-agent-sdk-.+\/claude(\.exe)?$/);
      return '/pkgs/claude-agent-sdk/claude';
    };
    h.which = '/usr/local/bin/claude'; // present, but must be ignored in favor of the bundled binary

    expect(resolveClaudeCliPath()).toBe('/pkgs/claude-agent-sdk/claude');
  });

  // Purpose: stay working when the optional native-binary dep failed to install
  it('falls back to a PATH `claude` when the bundled binary is absent', () => {
    h.resolve = () => {
      throw new Error('optional dependency not installed');
    };
    h.which = '/usr/local/bin/claude\n'; // raw `which`/`where` output with trailing newline

    expect(resolveClaudeCliPath()).toBe('/usr/local/bin/claude');
  });

  // Purpose: signal "nothing usable" so the dependency check + SDK error can guide the user
  it('returns undefined when neither the bundled binary nor a PATH claude resolve', () => {
    h.resolve = () => {
      throw new Error('not found');
    };
    h.which = null; // execFileSync throws

    expect(resolveClaudeCliPath()).toBeUndefined();
  });

  // Purpose: a resolvable specifier whose file is missing is treated as absent
  it('treats a resolved-but-missing bundled path as absent', () => {
    h.resolve = () => '/pkgs/claude-agent-sdk/claude';
    h.exists = false;
    h.which = null;

    expect(resolveClaudeCliPath()).toBeUndefined();
  });
});

describe('createIdlePrompt — no-turn command probe', () => {
  // Purpose: the probe must NOT enqueue a user turn — it only holds the stream
  // open so the SDK can answer control requests, then completes on close().
  it('yields no user message and completes once close() is called', async () => {
    const { prompt, close } = createIdlePrompt();
    const pull = prompt.next();
    close();
    await expect(pull).resolves.toEqual({ value: undefined, done: true });
  });

  // Purpose: `finally { close() }` may fire after an earlier close — must not throw.
  it('close() is idempotent', async () => {
    const { prompt, close } = createIdlePrompt();
    close();
    close();
    await expect(prompt.next()).resolves.toEqual({ value: undefined, done: true });
  });
});

describe('createHeldUserPrompt — held single-message stream', () => {
  // Purpose: the held prompt (shared core with createIdlePrompt) must still yield
  // exactly one user message before holding the stream open until close().
  it('yields the user message, then completes once close() is called', async () => {
    const { prompt, close } = createHeldUserPrompt('hello');

    const first = await prompt.next();
    expect(first.done).toBe(false);
    expect(first.value).toEqual({
      type: 'user',
      message: { role: 'user', content: 'hello' },
      parent_tool_use_id: null,
      session_id: '',
    });

    // The stream is held open past the message until close() releases it.
    const pull = prompt.next();
    close();
    await expect(pull).resolves.toEqual({ value: undefined, done: true });
  });
});
