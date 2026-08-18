import { describe, it, expect, vi, beforeEach, afterEach, type MockInstance } from 'vitest';

// Steer the resolution primitives per test. `exists` is a PREDICATE because the
// CLI now walks the server's own ladder (env override → bundled → provisioned →
// PATH), and a test has to be able to say which of those rungs is present.
const h = vi.hoisted(() => ({
  resolve: ((_s: string): string => {
    throw new Error('not found');
  }) as (s: string) => string,
  exists: ((_p: string) => true) as (path: string) => boolean,
  which: null as string | null,
  versionOk: true,
}));

vi.mock('node:module', () => ({
  createRequire: () => ({ resolve: (s: string) => h.resolve(s) }),
}));

vi.mock('node:fs', () => ({
  existsSync: (p: string) => h.exists(p),
}));

/** Where a one-click install writes; absent unless a test says otherwise. */
const PROVISIONED = '/runtimes/claude-code/';

/** A host that has never run the one-click install. */
const nothingProvisioned = (p: string): boolean => !p.includes(PROVISIONED);

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
  let mockConsoleWarn: MockInstance<typeof console.warn>;

  beforeEach(() => {
    vi.clearAllMocks();
    h.resolve = () => {
      throw new Error('not found');
    };
    h.exists = nothingProvisioned;
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
    h.versionOk = false; // `--version` throws

    expect(checkClaude()).toBe(false);
  });

  // Purpose (DOR-1334 review): the CLI used to carry its OWN copy of the
  // resolution ladder, which never learned about the one-click install — so
  // `dorkos` start-up and `dorkos doctor` warned "not found" about a binary the
  // server would have spawned happily. It walks the server's ladder now.
  it('finds a provisioned install, which the CLI-local ladder never could', () => {
    h.resolve = () => {
      throw new Error('optional dep not installed');
    };
    h.which = null;
    h.exists = (p) => p.includes(PROVISIONED);

    expect(checkClaude()).toBe(true);
    expect(mockConsoleWarn).not.toHaveBeenCalled();
  });
});
