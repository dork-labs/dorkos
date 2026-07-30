/**
 * The D8 env lock: the only writer of `process.env.CLAUDE_CONFIG_DIR`.
 *
 * Three properties, each with a concrete failure it prevents:
 *
 * - **It serializes.** Two renames on different accounts overlapping would
 *   interleave their save/restore and leave the variable naming the wrong
 *   account for whatever runs next. Proven by starting both before either
 *   finishes and reading what each one SAW inside its own section.
 * - **It restores, including ABSENCE.** Leaving an empty string behind where
 *   nothing was set changes the SDK's answer (and, on macOS, the Keychain entry
 *   Claude Code derives from it) for the rest of the process.
 * - **It conceals the mutation from DorkOS's own resolvers.**
 *   `resolveActiveClaudeRoot()` falls back to this variable when no account is
 *   chosen, so a rename holding the lock must not be able to make a brand-new
 *   session resolve to the renamed session's account.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { ambientClaudeConfigDir, withClaudeConfigDir } from '../claude-config-env-lock.js';
import { resolveActiveClaudeRoot } from '../claude-config-dir.js';

vi.mock('../../../../lib/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

/** A config reader standing in for the config manager, with no account chosen. */
const NO_ACCOUNT_CHOSEN = {
  get: () => undefined,
} as unknown as Parameters<typeof resolveActiveClaudeRoot>[0];

/** A promise plus its resolver, so a test can hold a critical section open. */
function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

describe('withClaudeConfigDir', () => {
  const ORIGINAL = process.env.CLAUDE_CONFIG_DIR;

  beforeEach(() => {
    delete process.env.CLAUDE_CONFIG_DIR;
  });

  afterEach(() => {
    if (ORIGINAL === undefined) delete process.env.CLAUDE_CONFIG_DIR;
    else process.env.CLAUDE_CONFIG_DIR = ORIGINAL;
  });

  it('points the variable at the account for the duration of the call', async () => {
    const seen = await withClaudeConfigDir('/staged/claude2', async () =>
      Promise.resolve(process.env.CLAUDE_CONFIG_DIR)
    );

    expect(seen).toBe('/staged/claude2');
  });

  it('restores an ABSENT variable by deleting the key, not by emptying it', async () => {
    await withClaudeConfigDir('/staged/claude2', async () => Promise.resolve());

    expect('CLAUDE_CONFIG_DIR' in process.env).toBe(false);
  });

  it('restores a previously SET variable to its exact value', async () => {
    process.env.CLAUDE_CONFIG_DIR = '/staged/claude-inherited';

    await withClaudeConfigDir('/staged/claude2', async () => Promise.resolve());

    expect(process.env.CLAUDE_CONFIG_DIR).toBe('/staged/claude-inherited');
  });

  it('restores even when the wrapped call throws, and passes the failure through', async () => {
    process.env.CLAUDE_CONFIG_DIR = '/staged/claude-inherited';

    await expect(
      withClaudeConfigDir('/staged/claude2', async () => {
        throw new Error('rename failed');
      })
    ).rejects.toThrow('rename failed');
    expect(process.env.CLAUDE_CONFIG_DIR).toBe('/staged/claude-inherited');
  });

  it('serializes overlapping callers — neither ever sees the other account', async () => {
    // Both are STARTED before either finishes, which is the only arrangement that
    // can catch a non-serializing implementation. Without the queue, the second
    // call would overwrite the variable while the first is still inside its
    // section, and `firstSaw` would read the second account.
    const firstHeld = deferred();
    const order: string[] = [];
    let firstSaw: string | undefined;
    let secondSaw: string | undefined;

    const first = withClaudeConfigDir('/staged/claude-A', async () => {
      order.push('A:enter');
      await firstHeld.promise;
      firstSaw = process.env.CLAUDE_CONFIG_DIR;
      order.push('A:exit');
    });
    const second = withClaudeConfigDir('/staged/claude-B', async () => {
      order.push('B:enter');
      secondSaw = process.env.CLAUDE_CONFIG_DIR;
      order.push('B:exit');
      return Promise.resolve();
    });

    firstHeld.resolve();
    await Promise.all([first, second]);

    expect(firstSaw).toBe('/staged/claude-A');
    expect(secondSaw).toBe('/staged/claude-B');
    expect(order).toEqual(['A:enter', 'A:exit', 'B:enter', 'B:exit']);
    expect('CLAUDE_CONFIG_DIR' in process.env).toBe(false);
  });

  it('does not deadlock later callers when one caller fails', async () => {
    // The queue chains on SETTLEMENT, not on the value. A rejected link that
    // later callers awaited as a value would strand every later rename and fork.
    const failing = withClaudeConfigDir('/staged/claude-A', async () => {
      throw new Error('boom');
    });
    const after = withClaudeConfigDir('/staged/claude-B', async () =>
      Promise.resolve(process.env.CLAUDE_CONFIG_DIR)
    );

    await expect(failing).rejects.toThrow('boom');
    await expect(after).resolves.toBe('/staged/claude-B');
  });

  it('hides the mutation from the active-account resolver while it is held', async () => {
    // The money case. With no account chosen, `resolveActiveClaudeRoot()` falls
    // back to `$CLAUDE_CONFIG_DIR`. A turn spawning for a brand-new session
    // during a rename must resolve the account the OPERATOR is on, not the one
    // being renamed.
    process.env.CLAUDE_CONFIG_DIR = '/staged/claude-inherited';

    const duringHold = await withClaudeConfigDir('/staged/claude-being-renamed', async () =>
      Promise.resolve({
        ambient: ambientClaudeConfigDir(),
        active: resolveActiveClaudeRoot(NO_ACCOUNT_CHOSEN),
      })
    );

    expect(duringHold).toEqual({
      ambient: '/staged/claude-inherited',
      active: '/staged/claude-inherited',
    });
    // …and once released the concealment stops: the real variable is the answer.
    expect(ambientClaudeConfigDir()).toBe('/staged/claude-inherited');
  });

  it('reports an absent ambient variable as absent, held or not', async () => {
    const duringHold = await withClaudeConfigDir('/staged/claude2', async () =>
      Promise.resolve(ambientClaudeConfigDir())
    );

    expect(duringHold).toBeUndefined();
    expect(ambientClaudeConfigDir()).toBeUndefined();
  });
});
