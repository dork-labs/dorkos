/**
 * Find the shell commands a skill's or command's text runs when it is used
 * (DOR-2327).
 *
 * Two programs run commands written into that text, before the model sees it:
 *
 * - **Claude Code** renders a skill (`SKILL.md`) or command (`commands/*.md`)
 *   when it is used: `` !`cmd` `` runs when the `!` starts a line or follows
 *   whitespace, and a fenced block whose info string is exactly `!` runs as one
 *   script. Plugin skills are covered like any other; only synced claude.ai
 *   skills are exempt (https://code.claude.com/docs/en/skills.md, checked
 *   2026-09-24). DorkOS's Claude Code sessions load plugins through the same
 *   engine, so this is DorkOS's own runtime too.
 * - **OpenCode** runs `` !`cmd` `` in a command template, matched ANYWHERE by
 *   `/!`([^`]+)`/g` (`packages/opencode/src/session/prompt.ts`, checked at
 *   `6df0d5d`), and Harness Sync copies every plugin command's body into an
 *   `.opencode/commands/` wrapper. OpenCode does not render skills.
 *
 * Codex has no such syntax (its core was searched at `dbb875d`), and a
 * scheduled task's body is sent as a plain prompt, which renders nothing.
 *
 * So this reads the UNION of what either would run, and leans wide where the
 * Claude Code docs are silent (a double-backtick span, a tilde fence, an
 * indented or longer fence, a command inside another code block): a line on
 * the install card for a command that would not have run is a small cost, and
 * a command that runs without having been shown is the bug.
 *
 * @module skills/shell-commands
 */

/** One command a skill's text runs, verbatim. */
export interface SkillShellCommand {
  /** `inline` for `` !`cmd` ``, `block` for a fenced block whose info string is `!`. */
  form: 'inline' | 'block';
  /** The command exactly as written: a block's lines joined, an inline span's text. */
  command: string;
}

/** A fence that opens a `!` block: up to 3 spaces, 3+ backticks or tildes, info string `!`. */
const OPENING_FENCE = /^ {0,3}(`{3,}|~{3,})[ \t]*![ \t]*$/;

/** Any fence line: up to 3 spaces, then 3+ backticks or tildes, then only whitespace. */
const CLOSING_FENCE = /^ {0,3}(`{3,}|~{3,})[ \t]*$/;

/** Every `` !`…` `` in `text`, with where it starts. */
function inlineCommands(text: string): { at: number; found: SkillShellCommand }[] {
  const out: { at: number; found: SkillShellCommand }[] = [];
  let i = text.indexOf('!`');
  while (i !== -1) {
    const open = i + 1;
    let run = 0;
    while (text[open + run] === '`') run++;
    const fence = '`'.repeat(run);
    // One backtick: OpenCode's rule exactly, the span ends at the next
    // backtick. Longer: a Markdown code span, which ends at the next run of
    // exactly as many backticks and so may hold a shorter run.
    let close = text.indexOf(fence, open + run);
    while (run > 1 && close !== -1 && (text[close - 1] === '`' || text[close + run] === '`')) {
      close = text.indexOf(fence, close + 1);
    }
    // A span is never empty: the backticks after `!` are all counted into the
    // opening run, so the first closing run can only come after some text.
    if (close !== -1) {
      out.push({ at: i, found: { form: 'inline', command: text.slice(open + run, close) } });
      i = text.indexOf('!`', close + run);
    } else {
      i = text.indexOf('!`', open + run);
    }
  }
  return out;
}

/** Every fenced block whose info string is `!`, with where it starts. */
function blockCommands(text: string): { at: number; found: SkillShellCommand }[] {
  const out: { at: number; found: SkillShellCommand }[] = [];
  const lines = text.split('\n');
  // A file ending in a newline has no extra empty last line.
  if (text.endsWith('\n')) lines.pop();
  let offset = 0;
  let open: { at: number; char: string; length: number; body: string[] } | null = null;
  for (const line of lines) {
    if (open) {
      const fence = CLOSING_FENCE.exec(line)?.[1];
      if (fence && fence[0] === open.char && fence.length >= open.length) {
        out.push({ at: open.at, found: { form: 'block', command: open.body.join('\n') } });
        open = null;
      } else {
        open.body.push(line);
      }
    } else {
      const fence = OPENING_FENCE.exec(line)?.[1];
      if (fence) open = { at: offset, char: fence[0], length: fence.length, body: [] };
    }
    offset += line.length + 1;
  }
  // An unclosed block runs to the end of the file, as Markdown reads it.
  if (open) out.push({ at: open.at, found: { form: 'block', command: open.body.join('\n') } });
  return out;
}

/**
 * Every shell command a skill's or command's text would run when it is used,
 * in the order they appear.
 *
 * @param text - The whole file, frontmatter included: a frontmatter split that
 *   differs from Claude Code's must not hide a command.
 * @returns The commands, verbatim, in document order.
 */
export function findSkillShellCommands(text: string): SkillShellCommand[] {
  return [...inlineCommands(text), ...blockCommands(text)]
    .sort((a, b) => a.at - b.at)
    .map((entry) => entry.found);
}
