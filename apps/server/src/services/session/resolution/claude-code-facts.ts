/**
 * What runtime-neutral turn code needs to know about Claude Code's own folders,
 * handed over at startup rather than imported (DOR-4928). Nothing under
 * `services/session/` imports `services/runtimes/`
 * (`eslint-rules/session-runtimes-boundary.js`), so the adapter that owns each
 * answer registers it here, from `startup/register-claude-code-facts.ts`:
 *
 * - which runtime an agent file names, unless the folder-settings pin holds it
 *   back (DOR-3068 M3), for a new session's runtime;
 * - whether an account folder is the DorkOS credits folder, for a chat's usage
 *   pause;
 * - where a Claude Code session's transcript lives, for a carry-over summary's
 *   pointer.
 *
 * Until it is registered, and in a test that registers nothing, every answer is
 * the one that grants nothing: no agent file's runtime is honoured, no folder is
 * the credits folder, and no transcript is known.
 *
 * @module services/session/resolution/claude-code-facts
 */

/** The answers Claude Code's adapter gives turn code. */
interface ClaudeCodeFacts {
  /**
   * The runtime an agent file names, or `undefined` when it names none or its
   * agent-file part is held back (changed since a person's yes, or unreadable).
   *
   * @param manifest - The agent file as read, or `null`.
   * @param home - The agent's home, if any.
   */
  runtimeUnlessHeld(
    manifest: { id?: string; runtime?: string } | null,
    home: string | null | undefined
  ): string | undefined;
  /**
   * Whether a Claude account folder is the DorkOS credits folder.
   *
   * @param root - A Claude config directory.
   */
  isCreditsRoot(root: string): boolean;
  /**
   * Where a Claude Code session's transcript lives, or `null` with no account.
   *
   * @param accountPath - The account folder the session ran in, or `null`.
   * @param cwd - The session's folder.
   * @param sessionId - The session's id.
   */
  transcriptPath(accountPath: string | null, cwd: string, sessionId: string): string | null;
}

/** The answers before anything registers: each one grants nothing. */
const UNREGISTERED: ClaudeCodeFacts = {
  runtimeUnlessHeld: () => undefined,
  isCreditsRoot: () => false,
  transcriptPath: () => null,
};

let registered: ClaudeCodeFacts = UNREGISTERED;

/**
 * Register Claude Code's answers. Called once at startup, before any runtime
 * registers.
 *
 * @param facts - The adapter's answers.
 */
export function setClaudeCodeFacts(facts: ClaudeCodeFacts): void {
  registered = facts;
}

/** Claude Code's answers as registered, or the ones that grant nothing. */
export function claudeCodeFacts(): ClaudeCodeFacts {
  return registered;
}
