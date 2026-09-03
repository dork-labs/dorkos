/**
 * The two in-process SDK helpers that run under the D8 env lock: `renameSession`
 * and `forkSession`.
 *
 * Neither takes a config directory, so each is pointed at an account only by the
 * `process.env.CLAUDE_CONFIG_DIR` the lock holds while it runs. These tests read
 * that variable from INSIDE the mocked SDK call — the one place that proves the
 * pin actually reached the helper — and check the account chosen is the session's
 * own, not whichever one is active.
 *
 * What goes wrong without it: a rename writes into the active account, where the
 * session does not exist, so the new title silently goes nowhere; and a fork
 * writes a copy of one client's conversation into another client's account.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  renameSession as sdkRenameSession,
  forkSession as sdkForkSession,
} from '@anthropic-ai/claude-agent-sdk';
import { readManifest } from '@dorkos/shared/manifest';
import { resolveLaunchAccountRoot } from '../claude-config-dir.js';
import { SessionStore } from '../sessions/session-store.js';
import { TranscriptReader } from '../sessions/transcript-reader.js';
import { ClaudeCodeRuntime } from '../claude-code-runtime.js';

/** Every account the config resolvers can see, so the probe order is fixed. */
const ACTIVE = '/staged/claude-active';
/** The paying client's account: where the session's transcript actually lives. */
const ACCOUNT_B = '/staged/claude2';

vi.mock('@anthropic-ai/claude-agent-sdk', () => ({
  renameSession: vi.fn(),
  forkSession: vi.fn(),
  query: vi.fn(),
}));
vi.mock('../claude-config-dir.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../claude-config-dir.js')>()),
  resolveActiveClaudeRoot: () => ACTIVE,
  // A spy rather than a plain arrow: the `accountRootForSession` cases below
  // assert WHICH rung it was asked for (the agent manifest's pinned account).
  resolveLaunchAccountRoot: vi.fn(() => ACTIVE),
}));
vi.mock('@dorkos/shared/manifest', () => ({ readManifest: vi.fn() }));
vi.mock('../../../../lib/logger.js', () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    trace: vi.fn(),
    fatal: vi.fn(),
    withTag: vi.fn().mockReturnThis(),
  },
  initLogger: vi.fn(),
}));
// Only the `renameSession` case (below) needs this: `ClaudeCodeRuntime`
// constructs its own `TranscriptReader` internally with no injection seam, so
// stubbing its account-probe answer means stubbing the class the constructor
// calls `new` on. Declared here (module scope, hoisted) rather than via
// `vi.doMock` inside the test — `vi.doMock` needs `vi.resetModules()` +
// dynamic `import()` to take effect, which forces vitest to re-transform
// `ClaudeCodeRuntime`'s entire dependency graph from scratch INSIDE the
// test's timeout window (measured ~1.4s on an otherwise idle machine; DOR-1139
// timed out at 5s under concurrent-agent load). A static import plus a
// module-scoped mock lets that transform happen once, during file collection,
// off the clock a single `it()` is timed against.
vi.mock('../sessions/transcript-reader.js', () => ({ TranscriptReader: vi.fn() }));

/** A reader stub whose account probe answers with `root` (or nothing). */
function fakeReader(root?: string): TranscriptReader {
  return {
    hasTranscript: vi.fn().mockResolvedValue(root ? { exists: true, root } : { exists: false }),
    getSession: vi.fn().mockResolvedValue({ id: 'forked', title: 't' }),
    invalidate: vi.fn(),
  } as unknown as TranscriptReader;
}

describe('D8 env-lock call sites', () => {
  const ORIGINAL = process.env.CLAUDE_CONFIG_DIR;
  /** What `process.env.CLAUDE_CONFIG_DIR` was while the SDK helper ran. */
  let seenInsideCall: string | undefined;

  beforeEach(() => {
    vi.clearAllMocks();
    seenInsideCall = undefined;
    // The launching terminal's account, deliberately a THIRD value: neither the
    // active account nor the session's, so an unpinned call is unmistakable.
    process.env.CLAUDE_CONFIG_DIR = '/staged/claude-inherited';
    vi.mocked(sdkRenameSession).mockImplementation(async () => {
      seenInsideCall = process.env.CLAUDE_CONFIG_DIR;
    });
    vi.mocked(sdkForkSession).mockImplementation(async () => {
      seenInsideCall = process.env.CLAUDE_CONFIG_DIR;
      return { sessionId: 'forked-session-id' };
    });
  });

  afterEach(() => {
    if (ORIGINAL === undefined) delete process.env.CLAUDE_CONFIG_DIR;
    else process.env.CLAUDE_CONFIG_DIR = ORIGINAL;
    // `vi.clearAllMocks()` (above) clears calls, not implementations — reset
    // explicitly so a mockImplementation set by the `renameSession` case below
    // can never leak into a later test.
    vi.mocked(TranscriptReader).mockReset();
  });

  describe('ClaudeCodeRuntime.accountRootForSession (DOR-1651)', () => {
    /** A runtime whose internal TranscriptReader answers this account probe. */
    function runtimeWithProbe(root?: string) {
      // A `function`, not an arrow — the constructor mock is called with `new`.
      vi.mocked(TranscriptReader).mockImplementation(function () {
        return fakeReader(root);
      });
      return new ClaudeCodeRuntime('/tmp/dorkos-test');
    }

    it('uses the account disk has already bound the session to', async () => {
      // Purpose: a conversation that has run must stay on the account whose
      // subscription paid for it, whichever one happens to be active.
      const runtime = runtimeWithProbe(ACCOUNT_B);

      await expect(runtime.accountRootForSession('s1', '/work')).resolves.toBe(ACCOUNT_B);
      expect(resolveLaunchAccountRoot).not.toHaveBeenCalled();
    });

    it('runs the launch ladder for a first turn that failed before writing a transcript', async () => {
      // Purpose: THE bug this exists for. A session whose first turn failed on
      // a bad credential has no transcript, so nothing has bound it — and an
      // agent pinned to a second account would otherwise re-authenticate the
      // ACTIVE one, report success, and fail again. That is the DOR-1652
      // wrong-account failure one rung down, and it is why the client's own
      // `Session.account` (transcript-derived, absent here) cannot be trusted
      // for this.
      vi.mocked(readManifest).mockResolvedValue({ account: 'account-b' } as never);
      const runtime = runtimeWithProbe(undefined);

      await runtime.accountRootForSession('first-turn', '/work');

      expect(readManifest).toHaveBeenCalledWith('/work');
      expect(resolveLaunchAccountRoot).toHaveBeenCalledWith({ agentAccountId: 'account-b' });
    });

    it('still answers when the agent manifest cannot be read', async () => {
      // Purpose: a missing or malformed manifest means "no pin", never a thrown
      // sign-in. The ladder's own fallback rungs take over.
      vi.mocked(readManifest).mockRejectedValue(new Error('ENOENT'));
      const runtime = runtimeWithProbe(undefined);

      await expect(runtime.accountRootForSession('first-turn', '/work')).resolves.toBe(ACTIVE);
      expect(resolveLaunchAccountRoot).toHaveBeenCalledWith({ agentAccountId: undefined });
    });
  });

  describe('SessionStore.accountRootFor', () => {
    it("prefers a live session's own account", async () => {
      const store = new SessionStore();
      const reader = fakeReader(undefined);
      await store.ensureForMessage('s1', fakeReader(ACCOUNT_B), '/work');

      await expect(store.accountRootFor('s1', reader, '/work')).resolves.toBe(ACCOUNT_B);
      // The live answer is authoritative, so the probe is not consulted at all.
      expect(reader.hasTranscript).not.toHaveBeenCalled();
    });

    it('probes disk for a session this server has never held in memory', async () => {
      const store = new SessionStore();

      await expect(store.accountRootFor('cold', fakeReader(ACCOUNT_B), '/work')).resolves.toBe(
        ACCOUNT_B
      );
    });

    it('falls back to the ACTIVE account when no account holds the session', async () => {
      const store = new SessionStore();

      await expect(store.accountRootFor('nowhere', fakeReader(undefined), '/work')).resolves.toBe(
        ACTIVE
      );
    });
  });

  describe('forkSession', () => {
    it("forks inside the SOURCE session's account, not the active one", async () => {
      const store = new SessionStore();
      const reader = fakeReader(ACCOUNT_B);

      await store.forkSession('/work', 's1', reader);

      expect(seenInsideCall).toBe(ACCOUNT_B);
      // …and the variable is put back afterwards.
      expect(process.env.CLAUDE_CONFIG_DIR).toBe('/staged/claude-inherited');
    });

    it('still restores the variable when the fork fails', async () => {
      const store = new SessionStore();
      vi.mocked(sdkForkSession).mockRejectedValue(new Error('fork exploded'));

      await expect(store.forkSession('/work', 's1', fakeReader(ACCOUNT_B))).resolves.toBeNull();

      expect(process.env.CLAUDE_CONFIG_DIR).toBe('/staged/claude-inherited');
    });
  });

  describe('renameSession', () => {
    it("renames inside the session's own account, not the active one", async () => {
      // Built through the runtime facade because that is where the SDK rename is
      // called; the reader is stubbed so the account probe is deterministic.
      // `ClaudeCodeRuntime` calls `new TranscriptReader()` internally, so the
      // module-scoped mock above stands in and this swaps in the fake return
      // value the same way `SessionStore` tests take a `fakeReader()` argument.
      // A regular `function`, not an arrow: `new TranscriptReader()` invokes
      // this as a constructor, and arrow functions can never be constructors.
      // Returning an object here is what makes `new` yield the fake instead.
      vi.mocked(TranscriptReader).mockImplementation(function () {
        return fakeReader(ACCOUNT_B);
      });
      const runtime = new ClaudeCodeRuntime('/tmp/dorkos-test');

      await runtime.renameSession('s1', 'Acme kickoff', '/work');

      expect(seenInsideCall).toBe(ACCOUNT_B);
      expect(process.env.CLAUDE_CONFIG_DIR).toBe('/staged/claude-inherited');
    });
  });
});
