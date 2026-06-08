import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Steer the three resolution primitives per test.
const h = vi.hoisted(() => ({
  resolve: ((_s: string): string => {
    throw new Error('not found');
  }) as (s: string) => string,
  exists: true,
  which: null as string | null,
  versionOk: true,
}));

vi.mock('node:module', () => ({
  createRequire: () => ({ resolve: (s: string) => h.resolve(s) }),
}));

vi.mock('node:fs', () => ({
  existsSync: () => h.exists,
}));

vi.mock('node:child_process', () => ({
  execFileSync: (_cmd: string, args: string[]) => {
    if (args?.[0] === '--version') {
      if (!h.versionOk) throw new Error('failed to launch');
      return Buffer.from('2.1.168 (Claude Code)');
    }
    // `which` / `where` claude
    if (h.which === null) throw new Error('not on PATH');
    return h.which;
  },
}));

// Must import after mock setup
const { checkClaude } = await import('../check-claude.js');

describe('checkClaude', () => {
  let mockConsoleWarn: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.clearAllMocks();
    h.resolve = () => {
      throw new Error('not found');
    };
    h.exists = true;
    h.which = null;
    h.versionOk = true;
    mockConsoleWarn = vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    mockConsoleWarn.mockRestore();
  });

  it('returns true when the SDK bundled native binary is present', () => {
    h.resolve = () => '/pkgs/claude-agent-sdk/claude';
    h.which = null; // not on PATH, but the bundled binary is enough

    expect(checkClaude()).toBe(true);
    expect(mockConsoleWarn).not.toHaveBeenCalled();
  });

  it('returns true when only a PATH `claude` is available', () => {
    h.resolve = () => {
      throw new Error('optional dep not installed');
    };
    h.which = '/usr/local/bin/claude\n';

    expect(checkClaude()).toBe(true);
    expect(mockConsoleWarn).not.toHaveBeenCalled();
  });

  it('returns false and warns when no binary is found', () => {
    h.resolve = () => {
      throw new Error('not found');
    };
    h.which = null;

    expect(checkClaude()).toBe(false);
  });

  it('prints install instructions when no binary is found', () => {
    const output = (() => {
      checkClaude();
      return mockConsoleWarn.mock.calls.map((c) => c[0]).join('\n');
    })();

    expect(output).toContain('Claude Code CLI not found');
    expect(output).toContain('Install it with');
  });

  it('returns false when a binary resolves but fails to launch', () => {
    h.resolve = () => '/pkgs/claude-agent-sdk/claude';
    h.exists = true;
    h.versionOk = false; // `--version` throws

    expect(checkClaude()).toBe(false);
  });
});
