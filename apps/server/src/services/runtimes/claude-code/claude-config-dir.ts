/**
 * Resolves the Claude Agent SDK's config roots — the directories holding
 * `projects/` (JSONL transcripts), `todos/`, and other SDK-managed state.
 *
 * A "Claude Code account" IS one of these directories: it carries that account's
 * transcripts and its own sign-in, which is why pointing the SDK at a different
 * one changes both the history DorkOS can see and the subscription the work bills
 * to. An operator running one account per client therefore runs several of these
 * directories, and this module is the single place that decides which one is
 * active and which ones exist (spec `claude-code-accounts`).
 *
 * The SDK's own subprocess resolves this as `CLAUDE_CONFIG_DIR ?? ~/.claude`
 * (verified against `@anthropic-ai/claude-agent-sdk`'s bundled `sdk.mjs`: the
 * config-dir accessor is `process.env.CLAUDE_CONFIG_DIR ?? path.join(homedir(),
 * ".claude")`). DorkOS reads transcripts written by that same subprocess, so
 * every read site MUST resolve the identical directory — a hardcoded
 * `~/.claude` silently split-brains the moment a user (or an agent launched
 * from inside a Claude Code session) sets `CLAUDE_CONFIG_DIR`: the SDK writes
 * one place, DorkOS reads another, and the session 404s despite having run,
 * billed, and streamed successfully (DOR-250).
 *
 * `runtimes.claudeCode.activeAccount` sits IN FRONT of that env var rather than
 * behind it, on purpose: inheriting whichever directory the launching terminal
 * exported is exactly the non-determinism this feature removes. With the field at
 * its `null` default the chain is byte-for-byte the SDK's own.
 *
 * `os.homedir()` is banned everywhere else in `apps/server/src/` (see
 * `.claude/rules/dork-home.md`), and this file is one of the three carve-outs —
 * exempt from the CALL ban **by filename**, so a sibling module may not call it
 * either. Everything that needs the real `~/.claude` lives here for that reason.
 * The IMPORT ban still reaches this file, so the import must stay spelled
 * `import os from 'os'`; `import { homedir }` here is a lint error.
 *
 * @module services/runtimes/claude-code/claude-config-dir
 */
import fs from 'fs';
import path from 'path';
import os from 'os';
import type { UserConfig } from '@dorkos/shared/config-schema';
import type { ServerConfig } from '@dorkos/shared/schemas';
import { logger } from '../../../lib/logger.js';
import { configManager } from '../../core/config-manager.js';

/** Minimal read surface of the config manager (injectable for tests). */
type ConfigReader = { get<K extends keyof UserConfig>(key: K): UserConfig[K] };

/**
 * The Claude root the SDK subprocess would pick on its own, with no DorkOS
 * config in the picture: `$CLAUDE_CONFIG_DIR`, else `~/.claude`.
 */
function inheritedClaudeRoot(): string {
  return process.env.CLAUDE_CONFIG_DIR ?? path.join(os.homedir(), '.claude');
}

/**
 * Read `runtimes.claudeCode` without ever throwing.
 *
 * Config resolution is on the transcript read path, and the singleton is
 * undefined before `initConfigManager()` runs (a unit test, an early boot step).
 * Failing there must degrade to the inherited default rather than break a read,
 * so every failure is a debug line and an empty answer.
 */
function readClaudeCodeConfig(config: ConfigReader): {
  activeAccount: string | null;
  accounts: readonly { path: string; label: string | null }[];
} {
  try {
    const claudeCode = config.get('runtimes')?.claudeCode;
    return {
      activeAccount: claudeCode?.activeAccount ?? null,
      accounts: claudeCode?.accounts ?? [],
    };
  } catch (err) {
    logger.debug('[claude-config-dir] Claude account config unavailable', { err: String(err) });
    return { activeAccount: null, accounts: [] };
  }
}

/**
 * Whether a directory currently qualifies as a Claude account.
 *
 * Structural, never credential-based (spec D4): an account is a directory that
 * exists and holds a `projects/` subdirectory. That single test cleanly separates
 * real accounts from neighbours like `~/.claude-worktrees` and `~/.claudekit`,
 * which have no `projects/`. A `statSync` that throws answers the
 * does-not-exist case at the same time.
 *
 * Claude Code names its macOS Keychain entry after a hash of the config
 * directory, which is _why_ changing the directory changes the billing identity —
 * but that is observed behavior of one release and macOS-only, so nothing here
 * depends on it. An authentication failure surfaces as a runtime error, which is
 * honest, rather than as a pre-flight guess.
 */
function isClaudeAccountRoot(dir: string): boolean {
  try {
    return fs.statSync(path.join(dir, 'projects')).isDirectory();
  } catch {
    return false;
  }
}

/**
 * Resolve the Claude root a NEW session runs and bills on.
 *
 * `runtimes.claudeCode.activeAccount` first, then the SDK's own chain
 * (`$CLAUDE_CONFIG_DIR`, else `~/.claude`). Never throws: an unreadable config
 * degrades to the inherited default.
 *
 * @param config - Config reader (defaults to the module singleton).
 * @returns The absolute Claude config directory to run in.
 */
export function resolveActiveClaudeRoot(config: ConfigReader = configManager): string {
  return readClaudeCodeConfig(config).activeAccount ?? inheritedClaudeRoot();
}

/**
 * Resolve every Claude root DorkOS should enumerate — what listing and search
 * read across, as opposed to the single root a new session runs in.
 *
 * The union is the active root, `$CLAUDE_CONFIG_DIR` when set, `~/.claude`, and
 * every registered account, deduplicated and filtered to the directories that
 * actually qualify ({@link isClaudeAccountRoot}). Two parts of that are load-bearing:
 *
 * - **Choosing an active account ADDS it to the set.** Otherwise selecting
 *   `~/.claude2` would move new work there while listing still covered only the
 *   old root, and a short list is indistinguishable from a complete one.
 * - **`~/.claude` stays in unconditionally**, even when another account is
 *   active, because the SDK may already have written there and dropping it hides
 *   history.
 *
 * The active root comes first and the rest keep their declaration order, so the
 * result is deterministic. Never throws; an unreadable config narrows the answer
 * rather than failing it. A root that qualifies but cannot be READ is not this
 * function's problem — the caller reports it as a warning and contributes zero
 * sessions.
 *
 * @param config - Config reader (defaults to the module singleton).
 * @returns Qualifying Claude roots, active first, each named once. Possibly empty
 *   on a machine where Claude Code has never run.
 */
export function resolveClaudeRootSet(config: ConfigReader = configManager): string[] {
  const { accounts } = readClaudeCodeConfig(config);
  const candidates = [
    resolveActiveClaudeRoot(config),
    ...(process.env.CLAUDE_CONFIG_DIR ? [process.env.CLAUDE_CONFIG_DIR] : []),
    path.join(os.homedir(), '.claude'),
    ...accounts.map((account) => account.path),
  ];

  const seen = new Set<string>();
  const roots: string[] = [];
  for (const candidate of candidates) {
    // Dedupe on the resolved path so `~/.claude` and `~/.claude/` are one root,
    // but emit the candidate as written. The active root is first, so its
    // spelling is the one that survives.
    const key = path.resolve(candidate);
    if (seen.has(key)) continue;
    seen.add(key);
    if (isClaudeAccountRoot(candidate)) roots.push(candidate);
  }
  return roots;
}

/**
 * Describe the Claude account state for `GET /api/config` — where a new session
 * will run, whether that was chosen or inherited, and which registered accounts
 * DorkOS can currently find.
 *
 * The resolved path has to come from the server: the cockpit cannot see the
 * server process's `CLAUDE_CONFIG_DIR`, so without this it could only show an
 * empty field where the effective default belongs.
 *
 * The return type is the wire contract itself rather than a restatement of it, so
 * this function and `ServerConfigSchema` cannot drift apart.
 *
 * @param config - Config reader (defaults to the module singleton).
 * @returns The `claudeCode` block of the server config response.
 */
export function describeClaudeCodeAccounts(
  config: ConfigReader = configManager
): NonNullable<ServerConfig['claudeCode']> {
  const { activeAccount, accounts } = readClaudeCodeConfig(config);
  return {
    resolvedAccount: activeAccount ?? inheritedClaudeRoot(),
    inherited: activeAccount === null,
    accounts: accounts.map((account) => ({
      path: account.path,
      label: account.label,
      // NOT `exists`: this is D4's structural check, so a directory that is
      // really there but holds no `projects/` reports false. Naming it `exists`
      // would read as `fs.existsSync` to any UI and mislabel that case.
      isAccountRoot: isClaudeAccountRoot(account.path),
    })),
  };
}
