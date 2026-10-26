/**
 * A registered agent folder's own allow list, as DorkOS passes it to Claude
 * Code (DOR-3039).
 *
 * Claude Code drops a project's `permissions.allow` in a folder it has not
 * been told to trust, and DorkOS never records that trust. So an agent
 * folder's allow list did nothing under DorkOS, and a run in Don't ask mode
 * was refused every command on it. Its deny rules and hooks were always
 * applied; only allows are dropped, because an allow is a widening.
 *
 * DorkOS now passes that one array itself, through the launch's own flag-layer
 * `settings`, never `allowedTools` (DOR-519). Security's conditions:
 *
 * - **The allow array only.** Nothing else is read from the file: a
 *   `defaultMode`, `apiKeyHelper`, `env`, `hooks` or `additionalDirectories`
 *   in it has no effect through this path.
 * - **Never DorkOS's own tools, and no wildcards.** `mcp__dorkos__*` stays with
 *   DorkOS's gate (`canUseTool`). A rule whose tool name holds a `*` (such as
 *   `mcp__*`) is dropped, and so is a whole built-in tool (`Bash`, `Edit(./**)`)
 *   and a file rule that reaches outside the home (`~`, `//`, `..`).
 * - **The self-grant files stay out of reach.** Whenever a list applies, the
 *   launch also denies file writes to the agent's own `.claude/`, `.mcp.json`
 *   and `.dork/agent.json`, DorkOS's data folder and Claude Code's account
 *   files (`apply-folder-allows.ts`). Deny beats allow, so no approved rule
 *   can rewrite the list, a hook or the approval record. An argument pattern inside the parentheses
 *   (`Bash(scripts/approve:*)`) is kept: that is how a rule names a command.
 * - **The registered home, exactly.** Read from the agent's home, and only
 *   when the turn's working folder IS that home by real path.
 * - **A changed list waits for the person.** {@link allowListHash} is what
 *   their approval pins; the launch passes a list only when its hash matches.
 *
 * @module services/runtimes/claude-code/folder-settings/agent-folder-allows
 */
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

/** The settings files a folder's allow list is read from, in Claude Code's order. */
const FOLDER_SETTINGS_FILES = ['settings.json', 'settings.local.json'] as const;

/**
 * The longest rule kept. A real rule is a tool name and a short pattern, and
 * the approval card shows every kept rule whole: a rule it had to shorten
 * would hide its tail from the person approving it.
 */
export const MAX_RULE_LENGTH = 200;

/** The largest settings file read. A real one is a few kilobytes. */
const MAX_SETTINGS_FILE_BYTES = 64 * 1024;

/**
 * Characters that change how text displays without showing themselves: control
 * and format characters, which include the bidi overrides and zero-width
 * marks. A rule holding one could read on the card as a different rule.
 */
const INVISIBLE_CHARACTERS = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u;

/**
 * A pattern that names nothing narrower than the whole tool: built only of
 * `*`, `/`, `.`, `:` and spaces, so `*`, `:*`, `./**`, `**\/*` and `//**` all
 * mean "everything" (Security review of #3072, M1).
 */
const WHOLE_TOOL_PATTERN = /^[\s*/.:]*$/;

/**
 * A pattern that reaches outside the agent's home: from the home folder
 * (`~`), from the root (`//`), or up a level (a `..` segment). DorkOS's own
 * config and Claude Code's account files live out there, and a rule that can
 * write them is a rule that can grant more rules.
 */
const REACHES_OUT_PATTERN = /^~|^\/\/|(^|[\\/\s])\.\.([\\/\s]|$)/;

/** A folder's allow list, ready to pass, and the hash an approval pins. */
export interface FolderAllowList {
  /** The rules, deduplicated, in the order the files list them. */
  rules: string[];
  /** Rules left out, with the reason, for the log and the approval card. */
  dropped: {
    rule: string;
    reason: 'dorkos-tool' | 'wildcard-tool' | 'whole-tool' | 'outside-home' | 'malformed';
  }[];
  /** sha256 of the kept rules; what a person's approval names. */
  hash: string;
}

/**
 * Whether one allow rule may be passed, and why not when it may not.
 *
 * @param rule - One entry of a folder's `permissions.allow`.
 */
export function judgeAllowRule(
  rule: unknown
):
  { ok: true; rule: string } | { ok: false; reason: FolderAllowList['dropped'][number]['reason'] } {
  if (typeof rule !== 'string') return { ok: false, reason: 'malformed' };
  const trimmed = rule.trim();
  if (!trimmed || trimmed.length > MAX_RULE_LENGTH || INVISIBLE_CHARACTERS.test(trimmed)) {
    return { ok: false, reason: 'malformed' };
  }
  const open = trimmed.indexOf('(');
  const tool = open === -1 ? trimmed : trimmed.slice(0, open);
  if (!tool || (open !== -1 && !trimmed.endsWith(')'))) return { ok: false, reason: 'malformed' };
  if (tool.includes('*')) return { ok: false, reason: 'wildcard-tool' };
  if (tool.startsWith('mcp__dorkos__') || tool === 'mcp__dorkos') {
    return { ok: false, reason: 'dorkos-tool' };
  }
  // A built-in tool with no pattern, or one that matches everything, is the
  // whole tool: `Bash` runs any command and `Edit` writes any file, DorkOS's
  // own config among them. The card would call it "1 command", which it is
  // not, so it is dropped like a wildcard. An MCP tool name is already one tool.
  const pattern = open === -1 ? '' : trimmed.slice(open + 1, -1);
  if (tool.startsWith('mcp__')) return { ok: true, rule: trimmed };
  // Claude Code matches `*` anywhere in a command, so a Bash pattern that
  // starts with one (`*e*`, `*/*`) matches nearly every command.
  if (
    WHOLE_TOOL_PATTERN.test(pattern) ||
    (tool === 'Bash' && pattern.trimStart().startsWith('*'))
  ) {
    return { ok: false, reason: 'whole-tool' };
  }
  if (tool !== 'Bash' && REACHES_OUT_PATTERN.test(pattern.trim())) {
    return { ok: false, reason: 'outside-home' };
  }
  return { ok: true, rule: trimmed };
}

/**
 * The hash a person's approval of an allow list pins.
 *
 * @param rules - The kept rules, in order.
 */
export function allowListHash(rules: readonly string[]): string {
  return createHash('sha256').update(JSON.stringify(rules)).digest('hex');
}

/**
 * Read a registered agent home's allow list. Only `permissions.allow` is read
 * from each file; a missing or unreadable file contributes nothing.
 *
 * @param home - The registered agent home.
 */
export async function readFolderAllowList(home: string): Promise<FolderAllowList> {
  const rules: string[] = [];
  const dropped: FolderAllowList['dropped'] = [];
  for (const name of FOLDER_SETTINGS_FILES) {
    let allow: unknown;
    try {
      const file = path.join(home, '.claude', name);
      // A regular file of a sane size only: a FIFO or a device would hang or
      // flood every launch in this folder.
      const stat = await fs.lstat(file);
      if (!stat.isFile() || stat.size > MAX_SETTINGS_FILE_BYTES) continue;
      const parsed: unknown = JSON.parse(await fs.readFile(file, 'utf8'));
      allow = (parsed as { permissions?: { allow?: unknown } } | null)?.permissions?.allow;
    } catch {
      continue;
    }
    if (!Array.isArray(allow)) continue;
    for (const entry of allow) {
      const verdict = judgeAllowRule(entry);
      if (verdict.ok) {
        if (!rules.includes(verdict.rule)) rules.push(verdict.rule);
      } else {
        dropped.push({ rule: String(entry), reason: verdict.reason });
      }
    }
  }
  return { rules, dropped, hash: allowListHash(rules) };
}

/**
 * Whether a turn's working folder is exactly the registered agent home, by
 * real path: no symlink into it, no worktree beside it, no subfolder.
 *
 * @param cwd - The turn's working folder.
 * @param home - The registered agent home.
 */
export async function isExactlyAgentHome(cwd: string, home: string): Promise<boolean> {
  // The path as given must already be the home: a symlink or a `..` that
  // happens to land on it is a different door, and is refused.
  if (path.resolve(cwd) !== path.resolve(home)) return false;
  try {
    const [a, b] = await Promise.all([fs.realpath(cwd), fs.realpath(home)]);
    return a === b;
  } catch {
    return false;
  }
}
