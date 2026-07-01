import { describe, it, expect, beforeEach, vi } from 'vitest';
import { resolveClaudeCliPath, createIdlePrompt } from '../sdk/sdk-utils.js';

// Mutable holder so each test can steer the three resolution primitives.
const h = vi.hoisted(() => ({
  resolve: ((_s: string): string => {
    throw new Error('not found');
  }) as (s: string) => string,
  exists: true,
  which: null as string | null,
}));

vi.mock('node:module', () => ({
  createRequire: () => ({ resolve: (s: string) => h.resolve(s) }),
}));

vi.mock('node:fs', () => ({
  existsSync: () => h.exists,
}));

vi.mock('node:child_process', () => ({
  execFileSync: () => {
    if (h.which === null) throw new Error('not on PATH');
    return h.which;
  },
}));

describe('resolveClaudeCliPath — Hybrid native-binary resolution', () => {
  beforeEach(() => {
    h.resolve = () => {
      throw new Error('not found');
    };
    h.exists = true;
    h.which = null;
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
