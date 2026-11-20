/**
 * The exact commands an agent may put on its own one-shot task without a
 * person (DOR-4315). They land in the task's `approvedAllow`, so a Don't ask
 * run of that task runs them without asking, through the same per-launch path
 * a person's approved rules take (DOR-3637).
 *
 * Only one shape is accepted, narrower than what a person may approve on a
 * card (`@dorkos/shared/permission-rules`), because no person reads it first:
 *
 * - **A Bash command, nothing else.** `Bash(<program> <args>)`. A bare tool, a
 *   file rule or an MCP tool is refused: the list may name only what Security
 *   can read whole.
 * - **Exact.** No `*`, `?`, `[`, `{` and no `:*` prefix form, so the rule is
 *   one command line and no other.
 * - **No shell.** None of `;` `|` `&` `$` `` ` `` `<` `>` `(` `)` `\` or quotes:
 *   the line can't chain, substitute, redirect or quote its way into a second
 *   command.
 * - **An absolute program that runs no other program, and no `..`.** The
 *   program is named by its full path, and it is pinned when the list is set
 *   (`allow-list-pins.ts`). A shell, a language runtime or a wrapper such as
 *   `timeout` or `git` would run something nobody pinned, so it is refused here
 *   by name and again by its real path when it is pinned.
 * - **Plain text.** One space between words, no control or format characters
 *   (a bidi override could make it read as another command), at most
 *   {@link MAX_TASK_ALLOW_RULE_LENGTH} characters and
 *   {@link MAX_TASK_ALLOW_ENTRIES} entries.
 *
 * A list is all or nothing: one entry out of shape refuses the whole change, so
 * the agent learns what was wrong rather than running with less than it asked.
 *
 * @module services/tasks/allow-list/task-allow-list
 */
import { isSpecificPermissionRule } from '@dorkos/shared/permission-rules';
import { runsAnotherProgram } from './allow-list-pins.js';

/** The longest entry kept, the same bound as an agent folder's rules. */
export const MAX_TASK_ALLOW_RULE_LENGTH = 200;

/** The most entries one task's list may hold. */
export const MAX_TASK_ALLOW_ENTRIES = 20;

/** Why an entry is not an exact command. */
export type TaskAllowRefusal =
  | 'malformed'
  | 'not-a-command'
  | 'wildcard'
  | 'shell-character'
  | 'not-absolute'
  | 'outside-path'
  | 'interpreter';

/**
 * Control, format and separator characters, which display as nothing or as a
 * plain space: only U+0020 may separate words, so a non-breaking space in `/x --flag` can’t read
 * as a flag while it runs a file named `/x --flag`.
 */
const INVISIBLE = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]|(?! )\p{Zs}/u;
/** Characters that make a rule match more than one command line. */
const WILDCARD = /[*?[\]{}]/;
/** Characters the shell reads as more than a word. */
const SHELL = /[;|&$`<>()\\'"]/;
/** `Bash(` … `)`, and what is between. */
const BASH_RULE = /^Bash\((.+)\)$/;

/**
 * Whether one entry is an exact command, and why not when it isn't.
 *
 * @param entry - One proposed allow-list entry.
 */
export function judgeTaskAllowEntry(
  entry: unknown
): { ok: true; rule: string } | { ok: false; reason: TaskAllowRefusal } {
  if (typeof entry !== 'string') return { ok: false, reason: 'malformed' };
  const rule = entry.trim();
  if (!rule || rule.length > MAX_TASK_ALLOW_RULE_LENGTH || INVISIBLE.test(rule)) {
    return { ok: false, reason: 'malformed' };
  }
  const command = BASH_RULE.exec(rule)?.[1];
  if (command === undefined || command.trim() === '') return { ok: false, reason: 'not-a-command' };
  if (WILDCARD.test(command)) return { ok: false, reason: 'wildcard' };
  if (SHELL.test(command)) return { ok: false, reason: 'shell-character' };
  const words = command.split(' ');
  if (words.some((word) => word === '')) return { ok: false, reason: 'malformed' };
  if (!words[0]!.startsWith('/')) return { ok: false, reason: 'not-absolute' };
  if (words.some((word) => word.split('/').includes('..'))) {
    return { ok: false, reason: 'outside-path' };
  }
  if (runsAnotherProgram(words[0]!)) return { ok: false, reason: 'interpreter' };
  // The card's own bar too, so this list is never wider than a person's.
  if (!isSpecificPermissionRule(rule)) return { ok: false, reason: 'malformed' };
  return { ok: true, rule };
}

/**
 * Judge a whole proposed list: kept in order without repeats when every entry
 * is exact, refused whole (naming each bad entry) when one is not.
 *
 * @param entries - The proposed list.
 */
export function judgeTaskAllowList(
  entries: unknown
):
  | { ok: true; rules: string[] }
  | { ok: false; refused: { rule: string; reason: TaskAllowRefusal | 'too-many' }[] } {
  if (!Array.isArray(entries)) {
    return { ok: false, refused: [{ rule: String(entries), reason: 'malformed' }] };
  }
  const rules: string[] = [];
  const refused: { rule: string; reason: TaskAllowRefusal | 'too-many' }[] = [];
  for (const entry of entries) {
    const verdict = judgeTaskAllowEntry(entry);
    if (!verdict.ok) refused.push({ rule: String(entry), reason: verdict.reason });
    else if (!rules.includes(verdict.rule)) rules.push(verdict.rule);
  }
  if (refused.length > 0) return { ok: false, refused };
  if (rules.length > MAX_TASK_ALLOW_ENTRIES) {
    return { ok: false, refused: [{ rule: `${rules.length} entries`, reason: 'too-many' }] };
  }
  return { ok: true, rules };
}

/**
 * What a change to a list adds and removes; order alone is no change.
 *
 * @param before - The list as stored.
 * @param after - The list as proposed.
 */
export function allowListChange(
  before: readonly string[],
  after: readonly string[]
): { added: string[]; removed: string[] } {
  return {
    added: after.filter((rule) => !before.includes(rule)),
    removed: before.filter((rule) => !after.includes(rule)),
  };
}
