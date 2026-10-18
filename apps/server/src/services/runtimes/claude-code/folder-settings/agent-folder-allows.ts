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
 *   `mcp__*`) is dropped. An argument pattern inside the parentheses
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

/** The longest rule kept. A real rule is a tool name and a short pattern. */
const MAX_RULE_LENGTH = 512;

/** A folder's allow list, ready to pass, and the hash an approval pins. */
export interface FolderAllowList {
  /** The rules, deduplicated, in the order the files list them. */
  rules: string[];
  /** Rules left out, with the reason, for the log and the approval card. */
  dropped: { rule: string; reason: 'dorkos-tool' | 'wildcard-tool' | 'malformed' }[];
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
  if (!trimmed || trimmed.length > MAX_RULE_LENGTH || /[\r\n\0]/.test(trimmed)) {
    return { ok: false, reason: 'malformed' };
  }
  const open = trimmed.indexOf('(');
  const tool = open === -1 ? trimmed : trimmed.slice(0, open);
  if (!tool || (open !== -1 && !trimmed.endsWith(')'))) return { ok: false, reason: 'malformed' };
  if (tool.includes('*')) return { ok: false, reason: 'wildcard-tool' };
  if (tool.startsWith('mcp__dorkos__') || tool === 'mcp__dorkos') {
    return { ok: false, reason: 'dorkos-tool' };
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
      const parsed: unknown = JSON.parse(
        await fs.readFile(path.join(home, '.claude', name), 'utf8')
      );
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
