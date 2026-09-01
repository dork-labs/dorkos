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
 * `runtimes.claudeCode.defaultAccount` sits IN FRONT of that env var rather than
 * behind it, on purpose: inheriting whichever directory the launching terminal
 * exported is exactly the non-determinism this feature removes. With the field at
 * its `null` default the chain is byte-for-byte the SDK's own.
 *
 * `os.homedir()` is banned everywhere else in `apps/server/src/` (see
 * `.claude/rules/dork-home.md`), and this file is one of the four carve-outs —
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
import type { ClaudeCodeAccount, UserConfig } from '@dorkos/shared/config-schema';
import { readClaudeAccountSettings } from '@dorkos/shared/config-schema';
import type { ServerConfig } from '@dorkos/shared/schemas';
import { logger } from '../../../lib/logger.js';
import { configManager } from '../../core/config-manager.js';
import { ambientClaudeConfigDir } from './claude-config-env-lock.js';

/** Minimal read surface of the config manager (injectable for tests). */
type ConfigReader = { get<K extends keyof UserConfig>(key: K): UserConfig[K] };

/**
 * The Claude root the SDK subprocess would pick on its own, with no DorkOS
 * config in the picture: `$CLAUDE_CONFIG_DIR`, else `~/.claude`.
 *
 * Reads the variable through {@link ambientClaudeConfigDir} rather than directly,
 * so a rename or fork holding the D8 env lock cannot make this answer its
 * transient value and send a brand-new session to another client's account.
 */
function inheritedClaudeRoot(): string {
  return ambientClaudeConfigDir() ?? path.join(os.homedir(), '.claude');
}

/**
 * Read `runtimes.claudeCode` without ever throwing.
 *
 * Config resolution is on the transcript read path, and the singleton is
 * undefined before `initConfigManager()` runs (a unit test, an early boot step).
 * Failing there must degrade to the inherited default rather than break a read,
 * so every failure is a debug line and an empty answer.
 *
 * That empty answer is reported as `unavailable` rather than left to look like a
 * registry with nothing in it. The two are indistinguishable in the data and
 * mean opposite things: an empty registry says an agent's account reference
 * names nothing, while a failed read says nobody knows what it names. A caller
 * that conflated them would light every account-carrying agent in the fleet
 * amber for the length of an outage.
 */
function readClaudeCodeConfig(config: ConfigReader): {
  defaultAccount: string | null;
  accounts: readonly ClaudeCodeAccount[];
  /** True when `accounts` is empty because the read failed, not because it is. */
  unavailable: boolean;
} {
  try {
    // Through the healing read, NOT straight off the store. `configManager.get`
    // hands back what conf stored — raw JSON, never a Zod parse — so this is the
    // one place that can give every reader below it the migrated shape on an
    // install the `'0.65.0'` migration has not reached (a dev tree never does).
    //
    // Both heals matter here and they fail differently. Without the rename, a
    // stored `activeAccount` is invisible and new work bills whatever the shell
    // pointed at. Without the ids, every row is unreferenceable and the ladder's
    // top two rungs are inert — a hint matched by an id no stored row carries.
    // Neither is a schema concern: `UserConfigSchema` is right either way, and
    // nothing on this path consults it.
    return { ...readClaudeAccountSettings(config.get('runtimes')?.claudeCode), unavailable: false };
  } catch (err) {
    logger.debug('[claude-config-dir] Claude account config unavailable', { err: String(err) });
    return { defaultAccount: null, accounts: [], unavailable: true };
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
 * Resolve the Claude root a new session runs and bills on when nothing more
 * specific names one — the bottom two rungs of the ladder.
 *
 * `runtimes.claudeCode.defaultAccount` first, then the SDK's own chain
 * (`$CLAUDE_CONFIG_DIR`, else `~/.claude`). Never throws: an unreadable config
 * degrades to the inherited default.
 *
 * Launch sites want {@link resolveLaunchAccountRoot}, which runs the whole
 * ladder. This is still the right answer for every READ site (listing, search,
 * transcript roots), which asks where work goes by default rather than where one
 * particular launch is going.
 *
 * @param config - Config reader (defaults to the module singleton).
 * @returns The absolute Claude config directory to run in.
 */
export function resolveActiveClaudeRoot(config: ConfigReader = configManager): string {
  return readClaudeCodeConfig(config).defaultAccount ?? inheritedClaudeRoot();
}

/**
 * Resolve the Claude root ONE launch runs and bills on, through the full ladder
 * (ADR 260821-205323):
 *
 * 1. `hintId` — the account a person picked for this session before sending.
 * 2. `agentAccountId` — the account this agent's manifest pins it to.
 * 3. `runtimes.claudeCode.defaultAccount` — the operator's server-wide default.
 * 4. The environment (`$CLAUDE_CONFIG_DIR`, else `~/.claude`).
 *
 * **A launch never fails on a bad account reference.** An id that no longer
 * names a registered account — the operator removed it, an agent manifest was
 * hand-edited, a client cached a stale list — logs a warning and falls through
 * to the next rung. The alternative is refusing to run a session over a setting,
 * which is a worse answer than billing the default and saying so.
 *
 * Call this only where a session's account is not already decided: the result
 * feeds {@link claudeConfigDirEnv}, and once a transcript exists on disk THAT is
 * the session's account forever (ADR 260801-204127). `launch-resolver.ts` keeps
 * the `session.accountRoot ??` guard in front of this call for that reason.
 *
 * @param opts - The ladder's inputs.
 * @param opts.hintId - Registry id from this send's launch hint, if any.
 * @param opts.agentAccountId - Registry id from the agent's manifest, if any.
 * @param opts.config - Config reader (defaults to the module singleton).
 * @returns The absolute Claude config directory this launch must use.
 */
export function resolveLaunchAccountRoot(
  opts: {
    hintId?: string | undefined;
    agentAccountId?: string | undefined;
    config?: ConfigReader;
  } = {}
): string {
  const config = opts.config ?? configManager;
  const { accounts } = readClaudeCodeConfig(config);

  for (const [source, id] of [
    ['session hint', opts.hintId],
    ['agent manifest', opts.agentAccountId],
  ] as const) {
    // The empty guard is what keeps `undefined === undefined` from matching. A
    // registry the `'0.65.0'` migration has not reached carries rows with NO
    // id, so `find(a => a.id === id)` with an absent `id` on both sides would
    // return the first row and bill an account nobody named.
    if (!id) continue;
    const match = accounts.find((account) => account.id === id);
    if (match) return match.path;
    logger.warn('[claude-config-dir] account id is not registered; falling through', {
      source,
      id,
    });
  }

  return resolveActiveClaudeRoot(config);
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
  const inherited = ambientClaudeConfigDir();
  const candidates = [
    resolveActiveClaudeRoot(config),
    ...(inherited ? [inherited] : []),
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
 * The `CLAUDE_CONFIG_DIR` entry that pins a spawned SDK subprocess to `root`.
 *
 * Spread this into `sdkOptions.env` at every spawn site. The entry is ALWAYS
 * present, so the subprocess's account is decided here and never inherited from
 * `process.env` — which is what makes the D8 env lock in
 * `claude-config-env-lock.ts` safe: a query spawning while a rename holds the
 * lock cannot pick up its transient mutation.
 *
 * ## Why the value can be `undefined`, and why that is not a loophole
 *
 * When `root` is the SDK's own default (`~/.claude`), "unset" is normally the
 * faithful spelling of that account — and spelling it out instead would change
 * behavior rather than pin it. Claude Code derives its macOS Keychain entry name
 * as `Claude Code-credentials[-<8 hex of sha256(configDir)>]`, and it takes the
 * UNSUFFIXED branch exactly when `CLAUDE_CONFIG_DIR` is unset — verified in the
 * SDK's bundled `sdk.mjs` and confirmed against a real machine, where
 * `~/.claude`'s entry is the unsuffixed one and the suffixed spelling does not
 * exist. So writing `CLAUDE_CONFIG_DIR=~/.claude` points the CLI at a Keychain
 * entry that was never created, and sign-in fails.
 *
 * `undefined` reaches the subprocess as a genuinely absent variable: Node's
 * `child_process` skips `undefined` values when it builds the child's
 * environment, so this both overrides an inherited value and removes it. That is
 * what lets absence still satisfy acceptance criterion 3 — an explicit account
 * choice overrides an inherited `CLAUDE_CONFIG_DIR`, including by erasing it.
 *
 * ## The one exception, which looks redundant and is not
 *
 * `ambientNamesRoot` keeps the pin EXPLICIT when the launching environment
 * already named `~/.claude` itself. An operator who always exports
 * `CLAUDE_CONFIG_DIR=~/.claude` authenticated under that regime, so their
 * SUFFIXED entry is the one that exists and naming the path is right for them.
 * Absence is right on every OTHER route to `~/.claude`: nothing set at all, or an
 * inherited variable naming a DIFFERENT account that the operator has just
 * overridden by selecting the default. Do not collapse this to "the ambient
 * value is unset" — that conflates which Keychain BRANCH Claude Code takes with
 * whether the name for the WANTED account exists, and it breaks sign-in for
 * anyone who selects `~/.claude` from a shell pointing somewhere else.
 *
 * @param root - The absolute Claude config directory this subprocess must use.
 * @returns A one-entry env fragment to spread AFTER `...process.env`.
 */
export function claudeConfigDirEnv(root: string): { CLAUDE_CONFIG_DIR: string | undefined } {
  const ambient = ambientClaudeConfigDir();
  const isDefaultRoot = path.resolve(root) === path.resolve(path.join(os.homedir(), '.claude'));
  const ambientNamesRoot = ambient !== undefined && path.resolve(ambient) === path.resolve(root);
  return { CLAUDE_CONFIG_DIR: isDefaultRoot && !ambientNamesRoot ? undefined : root };
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
  const { defaultAccount, accounts, unavailable } = readClaudeCodeConfig(config);
  return {
    resolvedAccount: defaultAccount ?? inheritedClaudeRoot(),
    inherited: defaultAccount === null,
    // Sent only when it is true, so an ordinary response carries no extra key
    // and a client that never learned about this field reads the same wire it
    // always did. What it buys the client is the difference between "your
    // account is not registered" and "nobody can say" — see
    // `readClaudeCodeConfig`.
    ...(unavailable ? { accountsUnavailable: true } : {}),
    accounts: accounts.map((account) => ({
      // The id agents and launch hints reference this account by. Never `null`
      // for a REGISTERED account, including on a config the migration has not
      // reached — `readClaudeCodeConfig` heals the id in. `null` on the wire is
      // reserved for a row a caller synthesizes to describe an unregistered
      // root, which nothing can point at (`ServerConfigSchema.claudeCode`).
      id: account.id,
      path: account.path,
      label: account.label,
      // NOT `exists`: this is D4's structural check, so a directory that is
      // really there but holds no `projects/` reports false. Naming it `exists`
      // would read as `fs.existsSync` to any UI and mislabel that case.
      isAccountRoot: isClaudeAccountRoot(account.path),
    })),
  };
}
