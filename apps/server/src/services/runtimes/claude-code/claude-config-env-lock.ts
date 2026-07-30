/**
 * The one place `process.env.CLAUDE_CONFIG_DIR` is ever WRITTEN, and the reason
 * that is survivable (spec `claude-code-accounts` D8).
 *
 * Three Claude Agent SDK helpers run IN-PROCESS — `renameSession`,
 * `forkSession`, `getSessionInfo` — so `sdkOptions.env` never reaches them, and
 * their option types expose only `dir?` / `sessionStore?`: no config dir, no
 * env. The SDK resolves its config root as
 * `memoize(() => process.env.CLAUDE_CONFIG_DIR ?? ~/.claude, () => process.env.CLAUDE_CONFIG_DIR)`
 * — memoized, but KEYED on the variable, so mutating the variable does take
 * effect. It is also the only lever there is.
 *
 * That lever is process-global, which is why it lives behind this module rather
 * than at the call sites:
 *
 * - **One writer at a time.** Every caller queues on {@link withClaudeConfigDir},
 *   so two concurrent renames on different accounts cannot interleave their
 *   save/restore and leave the variable pointing at the wrong account.
 * - **The previous value comes back, including its ABSENCE.** Restoring an unset
 *   variable to the empty string would silently change the SDK's answer (and, on
 *   macOS, the Keychain entry Claude Code derives from it), so the unset case is
 *   restored by deleting the key.
 * - **The mutation is concealed from DorkOS's own resolvers.**
 *   {@link ambientClaudeConfigDir} reports the value from OUTSIDE the critical
 *   section, so `resolveActiveClaudeRoot()` — which falls back to this variable
 *   when no account is chosen — cannot read a rename's transient value and send
 *   a brand-new session to the wrong account.
 *
 * ## Why only rename and fork use it, and what it costs
 *
 * Both are rare, explicitly user-initiated, and never on a hot path. The third
 * helper, `getSessionInfo` (the SDK-persisted custom title), sits on the
 * session-LISTING path and is deliberately NOT wrapped — see `resolveSdkTitle`
 * in `sessions/transcript-reader.ts` for that bounded degradation.
 *
 * The residual cost, stated rather than hidden: for the duration of a rename or
 * a fork, any OTHER subprocess this server spawns that inherits `process.env`
 * verbatim sees the pinned account. Every SDK query spawned here is immune
 * because it spells `CLAUDE_CONFIG_DIR` out explicitly
 * ({@link claudeConfigDirEnv}, wired in `messaging/message-sender.ts` and the
 * command-warm probe) — that explicitness and this lock are load-bearing for
 * each other and must not be separated.
 *
 * @module services/runtimes/claude-code/claude-config-env-lock
 */
import { logger } from '../../../lib/logger.js';

/**
 * The value held across the critical section, or `undefined` when no caller is
 * inside one. Present means "the variable is currently a lie"; `previous` is the
 * truth {@link ambientClaudeConfigDir} answers with meanwhile.
 */
let held: { previous: string | undefined } | undefined;

/** Tail of the serialization queue. Settled promises only — never rejected. */
let queue: Promise<void> = Promise.resolve();

/**
 * The ambient `CLAUDE_CONFIG_DIR` — what the launching environment set, ignoring
 * a mutation {@link withClaudeConfigDir} is holding.
 *
 * Read this instead of `process.env.CLAUDE_CONFIG_DIR` anywhere the answer feeds
 * a DECISION about which account to use. Code running INSIDE the critical
 * section (the wrapped SDK helper) wants the mutated value and gets it from the
 * variable itself, as the SDK does.
 *
 * @returns The launching environment's value, or undefined when it set none.
 */
export function ambientClaudeConfigDir(): string | undefined {
  // eslint-disable-next-line no-restricted-syntax -- CLAUDE_CONFIG_DIR is the Claude Agent SDK's own variable, not a DorkOS setting env.ts models (same carve-out as claude-config-dir.ts)
  return held ? held.previous : process.env.CLAUDE_CONFIG_DIR;
}

/**
 * Run `fn` with the SDK's config root pinned to `root`, serialized against every
 * other user of this lock, and restore the previous value afterwards.
 *
 * @param root - Absolute Claude config directory the SDK helper must act in.
 *   Resolve it BEFORE calling (`session.accountRoot ?? resolveActiveClaudeRoot()`);
 *   an unknown account means the active one, never an error.
 * @param fn - The in-process SDK call. Its result — or its rejection — is passed
 *   straight through; a rejection never poisons the queue for later callers.
 * @returns Whatever `fn` resolves to.
 */
export async function withClaudeConfigDir<T>(root: string, fn: () => Promise<T>): Promise<T> {
  const run = queue.then(async () => {
    /* eslint-disable no-restricted-syntax -- see ambientClaudeConfigDir: this module is the single writer of the SDK's own CLAUDE_CONFIG_DIR */
    const previous = process.env.CLAUDE_CONFIG_DIR;
    held = { previous };
    process.env.CLAUDE_CONFIG_DIR = root;
    try {
      return await fn();
    } finally {
      // Restore ABSENCE as absence: an unset variable and an empty one are
      // different answers to the SDK (and to Claude Code's Keychain naming).
      if (previous === undefined) delete process.env.CLAUDE_CONFIG_DIR;
      else process.env.CLAUDE_CONFIG_DIR = previous;
      held = undefined;
      logger.debug('[claude-config-env-lock] released', { root });
    }
    /* eslint-enable no-restricted-syntax */
  });
  // The next waiter chains on this run's SETTLEMENT, not its value, so one
  // failing rename cannot deadlock every later rename and fork.
  queue = run.then(
    () => undefined,
    () => undefined
  );
  return run;
}
