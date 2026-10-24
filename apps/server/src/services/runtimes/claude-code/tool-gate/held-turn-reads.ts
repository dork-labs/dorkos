/**
 * The reads a held turn may make without a card (DOR-3204): a file tool reading inside the agent's
 * own folders, and a plain read-only shell command that names nothing outside them.
 *
 * Everything else a held turn calls is put to a person (`held-turn-hook.ts`), because the folder's
 * allow rules would otherwise run it unasked. These two are let through so a held turn can still
 * look around its own folder, as Default mode lets any turn: an unattended one (a beat that read a
 * stranger's words) would otherwise be refused every `ls`. Each is let through only where an allow
 * rule could not widen it: every path must resolve, symlinks followed, inside the folders, and a
 * command must be one plain command with no shell syntax, no option that hides a path, and no
 * option that follows symlinks or writes.
 *
 * **`git status`, `log`, `diff` and `show` stay on the list.** Each can run a program a repo's
 * config names (`core.fsmonitor`, `diff.external`, a `textconv` driver). That config lives in the
 * local `.git/config` (or the user's own), which a clone or fetch never brings and a held turn
 * cannot write unasked (an edit or any other command asks). So the program it could run is one
 * somebody on this computer set up. The flags that name another repo or config (`-C`, `-c`,
 * `--git-dir`, `--exec-path`) are refused by the subcommand check, and `--output` and `--ext-diff`
 * by name.
 *
 * Not checked: what a recursive search finds below a folder. The tools here do not follow a
 * symlinked folder while recursing unless told to, and the options that tell them are refused.
 *
 * @module services/runtimes/claude-code/tool-gate/held-turn-reads
 */
import fs from 'node:fs';
import path from 'node:path';

/** File tools, and the input field each names its path in. */
const FILE_READ_PATHS: Readonly<Record<string, readonly string[]>> = {
  Read: ['file_path'],
  NotebookRead: ['notebook_path'],
  Grep: ['path'],
  Glob: ['path', 'pattern'],
  LS: ['path'],
};

/** Commands that only read, by their first word. `find` and `git` are narrowed below. */
const READ_ONLY_COMMANDS: ReadonlySet<string> = new Set([
  'ls',
  'pwd',
  'cat',
  'head',
  'tail',
  'wc',
  'grep',
  'stat',
  'du',
  'find',
  'git',
]);

/** The `git` subcommands that only read. */
const READ_ONLY_GIT: ReadonlySet<string> = new Set(['status', 'log', 'diff', 'show']);

/** `find` actions that run, delete or write, and its options that follow symlinks. */
const FIND_REFUSED = /^-(exec|execdir|ok|okdir|delete|fprint|fprint0|fprintf|fls|follow|L|H)$/;

/** Options that follow symlinks, per command: a short flag letter, or a long option. */
const FOLLOWS_SYMLINKS: Readonly<Record<string, RegExp>> = {
  grep: /^(-[A-Za-z]*[RSO][A-Za-z]*|--dereference-recursive)$/,
  ls: /^-[A-Za-z]*[LH][A-Za-z]*$/,
  du: /^(-[A-Za-z]*[LHD][A-Za-z]*|--dereference.*)$/,
  stat: /^(-[A-Za-z]*L[A-Za-z]*|--dereference)$/,
};

/** Shell syntax that could chain, redirect, substitute or expand into another command or path. */
const SHELL_SYNTAX = /[;&|<>`$(){}\\\n\r!~]/;

/** An option carrying a path in the same word: `--file=/x`, `--from=~/x`, `-f/x`. */
const OPTION_WITH_PATH = /(=[/~])|^-[A-Za-z]+\//;

/**
 * Where a path really is: the deepest part of it that exists, symlinks resolved, with the rest
 * appended. A path that does not exist yet resolves through the folders it would be in.
 */
function realLocation(target: string): string {
  let existing = target;
  const rest: string[] = [];
  for (;;) {
    try {
      return path.join(fs.realpathSync(existing), ...rest.reverse());
    } catch {
      const parent = path.dirname(existing);
      if (parent === existing) return target;
      rest.push(path.basename(existing));
      existing = parent;
    }
  }
}

/** Whether `target`, symlinks followed, is one of `roots` or inside one. */
function inside(target: string, roots: readonly string[]): boolean {
  const real = realLocation(target);
  return roots.some((root) => {
    const rel = path.relative(realLocation(root), real);
    return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
  });
}

/**
 * Whether a file tool's call reads only inside the folders. A tool this does not know, or a path it
 * cannot read, is not.
 *
 * @param toolName - The tool.
 * @param input - Its arguments.
 * @param cwd - The folder relative paths resolve against.
 * @param roots - The agent's folders: its working folder and the ones this turn was granted.
 */
export function fileReadStaysInside(
  toolName: string,
  input: Record<string, unknown>,
  cwd: string,
  roots: readonly string[]
): boolean {
  const fields = FILE_READ_PATHS[toolName];
  if (fields === undefined) return false;
  return fields.every((field) => {
    const value = input[field];
    if (value === undefined) return true;
    if (typeof value !== 'string') return false;
    // A glob pattern's own wildcards cannot climb out; its literal part can.
    const literal = field === 'pattern' ? value.split(/[*?[{]/)[0]! : value;
    return inside(path.resolve(cwd, literal), roots);
  });
}

/**
 * Whether a shell command is one plain read-only command that reads only inside the folders: no
 * shell syntax, no home path, no `..`, no option hiding a path or following symlinks, every other
 * word resolving inside the folders, and for `find` and `git` no action or subcommand that runs or
 * writes anything.
 *
 * @param command - The command line.
 * @param cwd - The folder it runs in.
 * @param roots - The agent's folders.
 */
export function isPlainReadCommand(
  command: string,
  cwd: string,
  roots: readonly string[]
): boolean {
  if (SHELL_SYNTAX.test(command)) return false;
  const words = command
    .trim()
    .split(/\s+/)
    .map((word) => word.replace(/^(['"])(.*)\1$/, '$2'));
  const [first, second] = words;
  if (first === undefined || !READ_ONLY_COMMANDS.has(first)) return false;
  if (first === 'git' && (second === undefined || !READ_ONLY_GIT.has(second))) return false;
  const follows = FOLLOWS_SYMLINKS[first];
  return words.slice(1).every((word) => {
    if (word.includes('"') || word.includes("'") || word.includes('..')) return false;
    // A glob after a dot matches `..` itself.
    if (/\.[*?[]/.test(word)) return false;
    if (OPTION_WITH_PATH.test(word) || /^--(output|ext-diff)/.test(word)) return false;
    if (first === 'find' && FIND_REFUSED.test(word)) return false;
    if (follows?.test(word)) return false;
    // Any other word may be a path: it must stay inside, symlinks followed. A word that is not a
    // path (a pattern, a flag) resolves inside the working folder, which is inside.
    return word.startsWith('-') || inside(path.resolve(cwd, word), roots);
  });
}
