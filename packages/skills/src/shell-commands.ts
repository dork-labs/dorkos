/**
 * Find the shell commands a skill's or command's text runs when it is used
 * (DOR-2327).
 *
 * Two programs run commands written into that text, before the model sees it.
 * Their own patterns, copied from their source, are the floor this reader
 * must never fall below:
 *
 * - **Claude Code** renders a skill (`SKILL.md`) or command (`commands/*.md`)
 *   when it is used, plugin skills included
 *   (https://code.claude.com/docs/en/skills.md). From the CLI bundled with the
 *   Agent SDK (0.3.280): a block is ``/```!\s*\n?([\s\S]*?)\n?```/g`` over the
 *   whole text, not anchored to a line, so ```` ```!sh ```` and a block inside
 *   a blockquote run too; an inline command is ``/(?<=^|\s)!`([^`]+)`/gm``
 *   after single-line code spans not preceded by `!` are blanked. DorkOS's
 *   Claude Code sessions load plugins through the same engine.
 * - **OpenCode** runs ``/!`([^`]+)`/g`` anywhere in a command template
 *   (`packages/opencode/src/session/prompt.ts`, `6df0d5d`), and Harness Sync
 *   copies every plugin command's body into an `.opencode/commands/` wrapper.
 *   OpenCode does not render skills.
 *
 * Codex has no such syntax (its core was searched at `dbb875d`), and a
 * scheduled task's body is sent as a plain prompt, which renders nothing.
 *
 * So this reports the UNION of: both programs' patterns exactly, plus a
 * Markdown reading of fences (tildes, longer fences, an info string starting
 * with `!`, a fence inside a blockquote or list item, an unclosed block running
 * to the end), plus every double-backtick span after a `!`. Where two readings
 * of one block disagree, both are listed. A line on the install card for a
 * command that would not have run is a small cost; a command that runs without
 * having been shown is the bug.
 *
 * Arguments: both programs put the text typed after a command into its
 * placeholders BEFORE running its shell commands (Claude Code escapes that text
 * so it cannot add a command of its own; OpenCode does not). A command that
 * names a placeholder therefore runs with that text in it; see
 * {@link usesTypedArguments}.
 *
 * @module skills/shell-commands
 */

/** One command a skill's text runs, verbatim. */
export interface SkillShellCommand {
  /** `inline` for `` !`cmd` ``, `block` for a fenced block whose info string starts with `!`. */
  form: 'inline' | 'block';
  /** The command exactly as written: a block's lines joined, an inline span's text. */
  command: string;
}

/** Claude Code's block pattern, verbatim. */
const CLAUDE_BLOCK = /```!\s*\n?([\s\S]*?)\n?```/g;

/** OpenCode's inline pattern, verbatim; it matches everything Claude Code's inline pattern does. */
const OPENCODE_INLINE = /!`([^`]+)`/g;

/** A container prefix a fence may sit behind: blockquote markers and list markers, in any mix. */
const CONTAINER_PREFIX = /^(?:[ \t]*(?:>|[-*+]|\d{1,9}[.)])(?=[ \t]|$)[ \t]?)*/;

/** A fence line once its container prefix is removed: its run of backticks or tildes, then the info string. */
const FENCE = /^ {0,3}(`{3,}|~{3,})(.*)$/;

/** A found command and where it starts, for document order. */
interface Found {
  at: number;
  found: SkillShellCommand;
}

/** Every inline command OpenCode's pattern finds (a superset of Claude Code's). */
function patternInline(text: string): Found[] {
  return [...text.matchAll(OPENCODE_INLINE)].map((m) => ({
    at: m.index,
    found: { form: 'inline', command: m[1]! },
  }));
}

/** Every `!` followed by a span of two or more backticks, whole, which neither pattern runs. */
function longSpans(text: string): Found[] {
  const out: Found[] = [];
  for (const m of text.matchAll(/!(`{2,})/g)) {
    const fence = m[1]!;
    const start = m.index + 1 + fence.length;
    // A Markdown code span ends at the next run of exactly as many backticks.
    let close = text.indexOf(fence, start);
    while (close !== -1 && (text[close - 1] === '`' || text[close + fence.length] === '`')) {
      close = text.indexOf(fence, close + 1);
    }
    if (close !== -1)
      out.push({ at: m.index, found: { form: 'inline', command: text.slice(start, close) } });
  }
  return out;
}

/** Every block Claude Code's own pattern runs, trimmed as it trims them. */
function patternBlocks(text: string): Found[] {
  return [...text.matchAll(CLAUDE_BLOCK)].map((m) => ({
    at: m.index,
    found: { form: 'block', command: m[1]!.trim() },
  }));
}

/** Every fenced block a Markdown reader would see whose info string starts with `!`. */
function markdownBlocks(text: string): Found[] {
  const out: Found[] = [];
  const lines = text.split('\n');
  // A file ending in a newline has no extra empty last line.
  if (text.endsWith('\n')) lines.pop();
  let offset = 0;
  let open: { at: number; char: string; length: number; body: string[] } | null = null;
  for (const line of lines) {
    const inner = line.replace(CONTAINER_PREFIX, '');
    const fence = FENCE.exec(inner);
    if (open) {
      if (
        fence &&
        fence[1]![0] === open.char &&
        fence[1]!.length >= open.length &&
        !fence[2]!.trim()
      ) {
        out.push({ at: open.at, found: { form: 'block', command: open.body.join('\n') } });
        open = null;
      } else {
        open.body.push(inner);
      }
    } else if (fence && fence[2]!.trimStart().startsWith('!')) {
      open = { at: offset, char: fence[1]![0]!, length: fence[1]!.length, body: [] };
    }
    offset += line.length + 1;
  }
  // An unclosed block runs to the end of the file, as Markdown reads it.
  if (open) out.push({ at: open.at, found: { form: 'block', command: open.body.join('\n') } });
  return out;
}

/**
 * Every shell command a skill's or command's text would run when it is used,
 * in the order they appear, each distinct reading listed once.
 *
 * @param text - The whole file, frontmatter included: a frontmatter split that
 *   differs from Claude Code's must not hide a command.
 * @returns The commands, verbatim, in document order.
 */
export function findSkillShellCommands(text: string): SkillShellCommand[] {
  // Every line ending a Markdown reader accepts, so a CRLF or CR file cannot
  // hide a fence from a scan that splits on `\n`.
  const normalized = text.replace(/\r\n?/g, '\n');
  const all = [
    ...patternInline(normalized),
    ...longSpans(normalized),
    ...patternBlocks(normalized),
    ...markdownBlocks(normalized),
  ].sort((a, b) => a.at - b.at);
  const seen = new Set<string>();
  const out: SkillShellCommand[] = [];
  for (const { found } of all) {
    const key = `${found.form}\u0000${found.command}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(found);
  }
  return out;
}

/**
 * Whether a command uses the text typed after the skill or command: Claude
 * Code's `$ARGUMENTS`, `$ARGUMENTS[N]`, `$N` or a `$name` from the frontmatter
 * `arguments` list, and OpenCode's `$ARGUMENTS` and `$N`. Both substitute them
 * before running the command, so what it runs depends on what is typed. A
 * placeholder escaped as `\$` is literal to Claude Code and is not counted.
 *
 * @param command - The command as written.
 * @param argumentNames - The names in the file's frontmatter `arguments`.
 * @returns True when the command names a placeholder.
 */
export function usesTypedArguments(command: string, argumentNames: readonly string[]): boolean {
  const names = argumentNames
    .filter((name) => name.length > 0)
    .map((name) => `${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![\\[\\w])`);
  const placeholder = new RegExp(`(?<!\\\\)\\$(?:ARGUMENTS|\\d|${[...names, '(?!)'].join('|')})`);
  return placeholder.test(command);
}
