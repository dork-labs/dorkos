/**
 * Naming for Claude Code accounts — the Claude config directories DorkOS runs
 * work on (spec `claude-code-accounts`).
 *
 * An account's identity is its absolute path, which is the wrong thing to show a
 * person: `/Users/you/.claude2` does not say which client the work bills to, and
 * it is far too long for a list row. This module is the single place that turns a
 * path into something readable, so the sidebar badge, the status-bar switcher,
 * and the settings card all name the same account the same way.
 *
 * @module shared/lib/claude-accounts
 */

/** A registered account as `GET /api/config` reports it. */
export interface ClaudeAccountRef {
  /** Absolute path of the account's Claude config directory. */
  path: string;
  /** What the operator calls this account, or `null` when unnamed. */
  label: string | null;
}

/**
 * The shortest honest name for an account.
 *
 * The operator's label wins, because "Acme Corp" is the answer to the question
 * they are actually asking. With no label the folder name stands in
 * (`/Users/you/.claude2` reads as `.claude2`) — recognizable, and short enough
 * for a badge in a list row, where a full absolute path would swamp the title
 * next to it.
 *
 * @param path - Absolute path of the account directory.
 * @param accounts - Registered accounts to look the label up in.
 * @returns The label, else the folder name, else the path unchanged.
 */
export function claudeAccountName(path: string, accounts: readonly ClaudeAccountRef[]): string {
  const label = accounts.find((account) => account.path === path)?.label;
  if (label) return label;
  return folderName(path);
}

/**
 * The accounts a picker must offer: the registered ones, plus the account
 * currently in use when nobody registered it.
 *
 * That last case is ordinary rather than exotic — `activeAccount` can be set by
 * hand in `~/.dork/config.json` (the configuration guide shows exactly that), and
 * the server honors it whether or not it is on the roster. A picker built from
 * the roster alone would then have no option matching the current value and would
 * render blank, which is the one thing this control must never do.
 *
 * @param accounts - Registered accounts.
 * @param inUse - The account in use, or `undefined`/`null` when it is inherited.
 * @returns The registered accounts, with `inUse` appended if it is missing.
 */
export function claudeAccountOptions(
  accounts: readonly ClaudeAccountRef[],
  inUse: string | undefined | null
): ClaudeAccountRef[] {
  const options = accounts.map((account) => ({ path: account.path, label: account.label }));
  if (inUse && !options.some((option) => option.path === inUse)) {
    options.push({ path: inUse, label: null });
  }
  return options;
}

/**
 * Last path segment, ignoring a trailing slash. Returns the input unchanged when
 * it has no segment to take (`'/'`, `''`).
 */
function folderName(path: string): string {
  const segments = path.split('/').filter(Boolean);
  return segments.length > 0 ? segments[segments.length - 1]! : path;
}
