/**
 * The reads a held turn may make without a card (DOR-3204): a file tool reading inside the agent's
 * own folders, and a plain read-only shell command that names nothing outside them.
 *
 * Everything else a held turn calls is put to a person (`held-turn-hook.ts`), because the folder's
 * allow rules would otherwise run it unasked. These two are let through so a held turn can still
 * look around its own folder, as Default mode lets any turn: an unattended one (a beat that read a
 * stranger's words) would otherwise be refused every `ls`. Each is let through only where an allow
 * rule could not widen it: a file tool's path must resolve inside the folders, and a command must
 * be one plain command, with no shell syntax and no path that could leave them.
 *
 * @module services/runtimes/claude-code/tool-gate/held-turn-reads
 */
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
  'file',
  'stat',
  'du',
  'tree',
  'find',
  'git',
]);

/** The `git` subcommands that only read. */
const READ_ONLY_GIT: ReadonlySet<string> = new Set(['status', 'log', 'diff', 'show']);

/** `find` actions that run, delete or write. */
const FIND_ACTIONS = /^-(exec|execdir|ok|okdir|delete|fprint|fprint0|fprintf|fls)$/;

/** Shell syntax that could chain, redirect, substitute or expand into another command or path. */
const SHELL_SYNTAX = /[;&|<>`$(){}\\\n\r!~]/;

/** Whether `target` is one of `roots` or inside one. */
function inside(target: string, roots: readonly string[]): boolean {
  return roots.some((root) => {
    const rel = path.relative(root, target);
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
 * Whether a shell command is one plain read-only command that names no path outside the folder:
 * no shell syntax, no absolute or home path, no `..`, and for `find` and `git` no action or
 * subcommand that runs or writes anything.
 *
 * @param command - The command line.
 */
export function isPlainReadCommand(command: string): boolean {
  if (SHELL_SYNTAX.test(command)) return false;
  const words = command
    .trim()
    .split(/\s+/)
    .map((word) => word.replace(/^(['"])(.*)\1$/, '$2'));
  const [first, second] = words;
  if (first === undefined || !READ_ONLY_COMMANDS.has(first)) return false;
  if (first === 'git' && (second === undefined || !READ_ONLY_GIT.has(second))) return false;
  return words.every(
    (word) =>
      !word.includes('"') &&
      !word.includes("'") &&
      !word.startsWith('/') &&
      !word.includes('..') &&
      // A glob after a dot matches `..` itself.
      !/\.[*?[]/.test(word) &&
      !FIND_ACTIONS.test(word) &&
      !/^--(output|ext-diff)/.test(word)
  );
}
