/**
 * A turn's folder grants, spelled the way the Claude Code CLI reads them (spec
 * `agent-home-desk` §4.2).
 *
 * ## Why settings, not `Options.additionalDirectories`
 *
 * The SDK option becomes `--add-dir`, which also loads the granted folder's
 * `.claude/skills` (and its `CLAUDE.md` when
 * `CLAUDE_CODE_ADDITIONAL_DIRECTORIES_CLAUDE_MD` is set). A room's files are
 * written by other people and other agents, so neither may reach an agent as
 * instructions (invariant I11). `settings.permissions.additionalDirectories`
 * grants file-tool access and loads neither.
 *
 * ## What was run, not reasoned (2026-09-26, SDK 0.3.280, bundled CLI 2.1.280)
 *
 * Live turns on the operator's own sign-in, one per case, each against a
 * control without the grant (DOR-2408):
 *
 * - `default`: `Read` inside a `write` grant raised no `canUseTool` call (the
 *   control raised one).
 * - `acceptEdits`: `Edit` inside a `write` grant raised no `canUseTool` call and
 *   changed the file (the control raised calls for `Read` and `Edit`).
 * - `Edit` and `Write` inside a `read` grant were refused ("denied by your
 *   permission settings") under BOTH `acceptEdits` and `bypassPermissions`,
 *   with a `canUseTool` that would have allowed anything; the same `Edit` under
 *   `bypassPermissions` with no grant succeeded.
 * - A `.claude/skills/probe/SKILL.md` inside a grant was absent from the
 *   session's reported skills; the same folder passed as `--add-dir` loaded it.
 * - A `CLAUDE.md` inside a grant was not loaded, even with
 *   `CLAUDE_CODE_ADDITIONAL_DIRECTORIES_CLAUDE_MD=1`; the same folder as
 *   `--add-dir` with that variable loaded it.
 *
 * Bash is not restricted by any of this: a shell command writes wherever the
 * permission mode lets it.
 *
 * @module services/runtimes/claude-code/messaging/directory-grants
 */
import { realpathSync } from 'node:fs';
import path from 'node:path';
import type { Options } from '@anthropic-ai/claude-agent-sdk';
import type { DirectoryGrant } from '@dorkos/shared/agent-runtime';
import { assertValidDirectoryGrants, DirectoryGrantError } from '@dorkos/shared/directory-grants';

/**
 * Makes `--add-dir` folders load their `CLAUDE.md`. Never passed to a turn: a
 * granted folder's instructions must not reach the agent (I11), and the gate
 * above showed the settings form ignores it anyway, so dropping it costs nothing
 * and keeps a later switch to `--add-dir` from quietly turning it on.
 */
export const GRANT_CLAUDE_MD_ENV_VAR = 'CLAUDE_CODE_ADDITIONAL_DIRECTORIES_CLAUDE_MD';

/** The file tools a `read` grant refuses. */
const WRITE_TOOLS = ['Edit', 'Write', 'NotebookEdit'] as const;

/**
 * Glob metacharacters in a rule path. Claude Code reads the path inside a rule
 * as a glob, so a folder literally named `R [x]` makes the rule
 * `Edit(//…/R [x]/**)` match `R x` instead and the real folder fails OPEN.
 * Run live against CLI 2.1.280 (DOR-2408 review): unescaped, a `read` grant on
 * `R [x] (y)` let `Write` through under `bypassPermissions` and `acceptEdits`;
 * with these escaped, `[ ]`, `{ }`, `*` and `!` in a folder name were all
 * refused. Spaces and parentheses need nothing, balanced or not: read grants
 * named `R)`, `R(`, `R) x`, `(R` and `R))` were all refused under both
 * modes while a sibling `write` grant stayed writable (DOR-2408 follow-up).
 */
const GLOB_METACHARACTERS = /[[\]*{}!]/g;

/**
 * Characters no escaping was seen to make safe, so a `read` grant naming one
 * is refused rather than handed over as a rule that may fail open. Run live:
 * an escaped `\?` still let `Write` into `R ?q`; a folder with a backslash
 * could not be tested at all (the CLI refused the write for a reason of its
 * own). Control characters are refused because a rule is one line of text.
 * A `write` grant needs no rule, so these limit only `read` grants.
 */
// eslint-disable-next-line no-control-regex -- matching control characters is the point
const UNSAFE_IN_RULE = /[?\\\u0000-\u001f\u007f]/;

/**
 * A folder name ending in whitespace (a space, a non-breaking space, …): the
 * CLI trims the rule, so it names a folder without the space and the real one
 * fails open — run live in the DOR-2408 re-review, `…/R ok ` let `Write`
 * through under `bypassPermissions`.
 */
const TRAILING_WHITESPACE = /\s$/u;

/** Whether Claude Code's rule syntax can name `folder` exactly. */
function ruleCanName(folder: string): boolean {
  const { body } = splitRulePath(folder);
  return !UNSAFE_IN_RULE.test(body) && !TRAILING_WHITESPACE.test(body);
}

/**
 * The absolute-path rule root for a folder, escaped. Claude Code reads a rule
 * path with ONE leading slash as relative to the project and with TWO as
 * absolute, so `/abs/path` becomes `//abs/path`; a single slash would fail
 * open. A Windows drive path is written in the POSIX form the rule syntax
 * documents (`C:\a\b` → `//c/a/b`) — reasoned from the docs, not run on
 * Windows.
 */
function ruleRoot(folder: string): string {
  const { drive, body } = splitRulePath(folder);
  const escaped = body.replace(GLOB_METACHARACTERS, (c) => `\\${c}`);
  return drive ? `//${drive}/${escaped}` : `/${escaped}`;
}

/** A folder's drive letter (Windows) and the rest of it with `/` separators. */
function splitRulePath(folder: string): { drive?: string; body: string } {
  const drive = /^([A-Za-z]):[\\/](.*)$/.exec(folder);
  return drive
    ? { drive: drive[1]!.toLowerCase(), body: drive[2]!.replace(/\\/g, '/') }
    : { body: folder };
}

/** The deny rules that make `folder` read-only for file tools. */
function readOnlyRules(folder: string): string[] {
  return WRITE_TOOLS.map((tool) => `${tool}(${ruleRoot(folder)}/**)`);
}

/** Every file tool a write-deny rule must name: `MultiEdit` too, for older CLIs. */
const ALL_WRITE_TOOLS = ['Edit', 'Write', 'MultiEdit', 'NotebookEdit'] as const;

/**
 * Deny rules that stop every file tool writing `target`: the folder and all
 * under it, or the one file. `undefined` when the path has a character no rule
 * can match exactly, so a caller can fail closed rather than pass a rule that
 * might match nothing.
 *
 * @param target - An absolute folder or file path.
 * @param kind - A folder and all under it (`/**` is appended), or the one file.
 */
export function writeDenyRules(target: string, kind: 'folder' | 'file'): string[] | undefined {
  const root = rulePath(target);
  if (root === undefined) return undefined;
  return ALL_WRITE_TOOLS.map((tool) => `${tool}(${root}${kind === 'folder' ? '/**' : ''})`);
}

/**
 * An absolute path as a rule spells it, escaped, with no trailing slash — or
 * `undefined` when no rule can name it exactly (see {@link writeDenyRules}).
 *
 * @param target - An absolute path.
 */
export function rulePath(target: string): string | undefined {
  if (!ruleCanName(target)) return undefined;
  return ruleRoot(target.replace(/[\\/]+$/, ''));
}

/** The slice of Claude Code settings this module writes. */
interface PermissionSettings {
  additionalDirectories?: string[];
  deny?: string[];
  [key: string]: unknown;
}

/**
 * Hand this turn's grants to the launch: merged into the `settings` object the
 * launch already carries (never replacing `fastMode` or anything else there),
 * and the `CLAUDE.md` variable removed from its environment.
 *
 * @param sdkOptions - The launch options, mutated in place.
 * @param grants - The turn's grants; absent means none.
 * @param cwd - The directory the turn runs in, for validation.
 * @throws DirectoryGrantError when the set is invalid — before anything launches.
 */
export function applyDirectoryGrants(
  sdkOptions: Options,
  grants: readonly DirectoryGrant[] | undefined,
  cwd: string
): void {
  if (sdkOptions.env && GRANT_CLAUDE_MD_ENV_VAR in sdkOptions.env) {
    const { [GRANT_CLAUDE_MD_ENV_VAR]: _dropped, ...rest } = sdkOptions.env;
    sdkOptions.env = rest;
  }
  if (!grants || grants.length === 0) return;
  assertValidDirectoryGrants(grants, cwd);
  for (const grant of grants) {
    // Fail closed, in words the person reading the failed turn can act on:
    // the grant comes from where DorkOS keeps its data, so that is what moves.
    if (grant.access === 'read' && !ruleCanName(grant.path)) {
      throw new DirectoryGrantError(
        `Claude Code can't keep the folder "${grant.path}" read-only, because its name has a character ` +
          `its safety rules can't match: a question mark, a backslash, a hidden control character, ` +
          `or a space at the very end. So this turn was not started. Rename or move the folder ` +
          `(usually your DorkOS data folder) to a path without those characters, then try again.`
      );
    }
  }

  const base =
    typeof sdkOptions.settings === 'object' && sdkOptions.settings !== null
      ? sdkOptions.settings
      : {};
  const permissions = ((base as { permissions?: PermissionSettings }).permissions ??
    {}) as PermissionSettings;
  sdkOptions.settings = {
    ...base,
    permissions: {
      ...permissions,
      additionalDirectories: [
        ...(permissions.additionalDirectories ?? []),
        ...grants.map((grant) => grant.path),
      ],
      deny: [
        ...(permissions.deny ?? []),
        ...grants.filter((grant) => grant.access === 'read').flatMap((g) => readOnlyRules(g.path)),
      ],
    },
  } as Options['settings'];
}

/**
 * The folders under the data directory that only a person may change, never an
 * agent's file tools:
 *
 * - `permissions/` holds the permission levels a person set for agents (the
 *   floor `person-set-agent-permissions.json`, DOR-3107). An agent that could
 *   rewrite it could raise its own level.
 * - `session-relay/` holds the pins that say which hub and which keys this
 *   computer trusts (and, with B4, `approval-keys.json`).
 * - `extension-snapshots/` holds the approved files an extension runs from,
 *   and `cache/extensions/` the bundles built from them (DOR-3068). An agent
 *   that could rewrite either could run code nobody approved. Both are also
 *   checked by content before use; this keeps the file tools out entirely.
 *
 * Bash is not covered, as the module note says: a turn with a shell it was not
 * asked about is outside what file rules can hold.
 */
export const PERSON_ONLY_DATA_FOLDERS = [
  'permissions',
  'session-relay',
  'extension-snapshots',
  'cache/extensions',
] as const;

/**
 * The files directly in the data directory only a person may change: the
 * config (`config.json`, its backups and conf's temp files beside it, so
 * `config.json*`) and the timestamped backups. The config holds every
 * extension approval and every other `operator-only` setting (DOR-3068); an
 * agent that could write it with a file tool could approve its own code.
 */
export const PERSON_ONLY_DATA_FILES = ['config.json*', 'config-*.json.bak'] as const;

/**
 * A Windows drive path seen on a POSIX host (tests, mostly), which
 * `path.resolve` would mangle into a relative one. Taken as written.
 */
function isForeignWindowsPath(target: string): boolean {
  return process.platform !== 'win32' && /^[A-Za-z]:[\\/]/.test(target);
}

/** The real path of `target`, or `undefined` when it does not exist yet. */
function realpathOrUndefined(target: string): string | undefined {
  try {
    return realpathSync.native(target);
  } catch {
    return undefined;
  }
}

/**
 * Every spelling one person-only folder can be reached by, each a rule of its
 * own: the absolute path, the path through the data folder's real location,
 * and the folder's own real location. A relative `DORK_HOME`, a symlinked
 * `~/.dork`, or a symlinked `permissions/` would otherwise yield a rule that
 * names a path the file tools never see.
 */
function namesOf(dorkHome: string, name: string): string[] {
  const foreign = isForeignWindowsPath(dorkHome);
  const home = (foreign ? dorkHome : path.resolve(dorkHome)).replace(/[\\/]+$/, '');
  const realHome = foreign ? undefined : realpathOrUndefined(home);
  const names = [`${home}/${name}`];
  if (realHome) {
    names.push(`${realHome}/${name}`);
    const realFolder = realpathOrUndefined(`${realHome}/${name}`);
    if (realFolder) names.push(realFolder);
  }
  return names;
}

/**
 * Deny every turn's file tools the {@link PERSON_ONLY_DATA_FOLDERS}, merged into
 * the launch's settings beside any grant rules. Whatever the permission mode:
 * a deny rule holds under `bypassPermissions` too (see the module note).
 *
 * @param sdkOptions - The launch options, mutated in place.
 * @param dorkHome - The data directory.
 * @throws DirectoryGrantError when the data directory's path can't be named
 *   exactly in a rule — failing closed, as a `read` grant does.
 */
export function applyPersonOnlyDataDeny(sdkOptions: Options, dorkHome: string): void {
  const folders = [...new Set(PERSON_ONLY_DATA_FOLDERS.flatMap((name) => namesOf(dorkHome, name)))];
  if (!folders.every(ruleCanName)) {
    throw new DirectoryGrantError(
      `Claude Code can't keep DorkOS's own settings folder "${dorkHome}" safe from agents, because ` +
        `its name has a character its safety rules can't match: a question mark, a backslash, a ` +
        `hidden control character, or a space at the very end. So this turn was not started. ` +
        `Move your DorkOS data folder to a path without those characters, then try again.`
    );
  }
  const base =
    typeof sdkOptions.settings === 'object' && sdkOptions.settings !== null
      ? sdkOptions.settings
      : {};
  const permissions = ((base as { permissions?: PermissionSettings }).permissions ??
    {}) as PermissionSettings;
  sdkOptions.settings = {
    ...base,
    permissions: {
      ...permissions,
      deny: [
        ...(permissions.deny ?? []),
        ...folders.flatMap(readOnlyRules),
        ...personOnlyFileRules(dorkHome),
      ],
    },
  } as Options['settings'];
}

/**
 * Write-deny rules for {@link PERSON_ONLY_DATA_FILES}, through every spelling
 * of the data directory (as given, and its real path). The file name keeps
 * its `*` as a glob; only the folder part is escaped.
 *
 * @param dorkHome - The data directory.
 */
export function personOnlyFileRules(dorkHome: string): string[] {
  const foreign = isForeignWindowsPath(dorkHome);
  const home = (foreign ? dorkHome : path.resolve(dorkHome)).replace(/[\\/]+$/, '');
  const real = foreign ? undefined : realpathOrUndefined(home);
  const rules = new Set<string>();
  for (const spelling of new Set([home, ...(real ? [real] : [])])) {
    const root = rulePath(spelling);
    if (root === undefined) continue;
    for (const file of PERSON_ONLY_DATA_FILES) {
      for (const tool of ALL_WRITE_TOOLS) rules.add(`${tool}(${root}/${file})`);
    }
  }
  return [...rules];
}

/**
 * The grants a launch's settings carry, read back from the rules
 * {@link applyDirectoryGrants} wrote — the launch fingerprint's input, and what
 * the conformance suite reads off a launched process. A folder is `read` when
 * its `Edit` deny rule is present.
 *
 * @param settings - A launch's `Options.settings`.
 */
export function grantsFromSettings(settings: Options['settings']): DirectoryGrant[] {
  if (typeof settings !== 'object' || settings === null) return [];
  const permissions = (settings as { permissions?: PermissionSettings }).permissions;
  const deny = new Set(permissions?.deny ?? []);
  return (permissions?.additionalDirectories ?? []).map((folder) => ({
    path: folder,
    access: deny.has(readOnlyRules(folder)[0]!) ? 'read' : 'write',
  }));
}
