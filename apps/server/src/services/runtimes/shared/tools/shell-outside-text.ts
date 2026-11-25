/**
 * Which shell commands hand the turn someone else's words (DOR-5236): a command that fetches from
 * the network (`shell-network-commands.ts`), one that names a file in a folder of outside files,
 * and a recursive search that reaches one (`outside-file-places.ts`). Such a command marks the turn,
 * as a web page does.
 *
 * It reads a command with the shell guard's own parser (`parseShell`, `withNested`, `commandOf`), so
 * it sees through pipes, `&&`, `env` and `NAME=value` prefixes, `sudo`, `timeout`, `xargs`, an
 * absolute program path, `sh -c '…'`, `eval` and `$(…)` exactly as the guard does. A path is read
 * after `~`, `$HOME` and `$TMPDIR` (`${TMPDIR:-/tmp}` included) are expanded.
 *
 * Generous over precise, because a mark only adds a hold and never lowers power. Commands that stay
 * local (`git status`, `git diff`, `pnpm test`, `ls` in the agent's folder) stay unmarked.
 *
 * @module services/runtimes/shared/tools/shell-outside-text
 */
import os from 'node:os';
import path from 'node:path';
import { expandTilde } from '../../../../lib/boundary.js';
import { commandOf, withNested } from '../../claude-code/shell-guard/shell-command.js';
import {
  expandVariables,
  parseShell,
  pathPieces,
  type ShellSegment,
} from '../../claude-code/shell-guard/shell-words.js';
import { outsideFileTests, type CallPlace, type OutsideFileTests } from './outside-file-places.js';
import { segmentFetches } from './shell-network-commands.js';

/** A command longer than this is not read; it marks, since what it does is unknown. */
const MAX_COMMAND = 100_000;

/** Programs that search a folder tree, and whether their first positional word is a pattern. */
const TREE_SEARCHES: Readonly<Record<string, { patternFirst: boolean }>> = {
  rg: { patternFirst: true },
  ag: { patternFirst: true },
  ack: { patternFirst: true },
  rgrep: { patternFirst: true },
  fd: { patternFirst: true },
  fdfind: { patternFirst: true },
  find: { patternFirst: false },
};
/** `grep` and its kin search a tree only when asked to. */
const GREPS: ReadonlySet<string> = new Set(['grep', 'egrep', 'fgrep']);

/** A word with its `~`, `$HOME` and `$TMPDIR` expanded, or `null` when that is too much to do. */
function expanded(piece: string, home: string): string | null {
  return expandVariables(piece, home, { HOME: home, TMPDIR: os.tmpdir() });
}

/** Whether one command names a path in a folder of outside files. */
function namesOutsideFile(segment: ShellSegment, tests: OutsideFileTests, home: string): boolean {
  for (const text of [...segment.words, ...segment.scripts]) {
    for (const piece of pathPieces(text)) {
      const named = expanded(piece, home);
      if (named === null || tests.holds(named)) return true;
    }
  }
  return false;
}

/** Whether one command is a recursive search starting at or above a folder of outside files. */
function searchesOutsideFiles(
  segment: ShellSegment,
  tests: OutsideFileTests,
  home: string
): boolean {
  const { verb, args } = commandOf(segment);
  const recursiveGrep =
    GREPS.has(verb) &&
    args.some((arg) => /^-[A-Za-z]*[rR]/.test(arg) || /^--(?:dereference-)?recursive$/.test(arg));
  const tree = TREE_SEARCHES[verb] ?? (recursiveGrep ? { patternFirst: true } : undefined);
  if (!tree) return false;
  const words = args.filter((arg) => !arg.startsWith('-'));
  // With no folder named, a search starts where it stands.
  const roots = words.length > (tree.patternFirst ? 1 : 0) ? words : [...words, '.'];
  return roots.some((root) => {
    const named = expanded(root, home);
    return named === null || tests.searchReaches(named);
  });
}

/**
 * Whether a shell command hands the turn someone else's words.
 *
 * @param command - The command line, as the runtime will run it.
 * @param place - Where it runs, so a file in the agent's own folder stays unmarked.
 */
export function commandReadsOutsideText(command: string, place: CallPlace = {}): boolean {
  if (command.length > MAX_COMMAND) return true;
  const segments = withNested(parseShell(command));
  if (segments.some((segment) => segmentFetches(segment))) return true;
  const tests = outsideFileTests(place);
  const home = expandTilde('~');
  return segments.some(
    (segment) =>
      namesOutsideFile(segment, tests, home) || searchesOutsideFiles(segment, tests, home)
  );
}

/** One argument, quoted for a shell so a list joins back into the command it was. */
function shellQuoted(arg: string): string {
  return `'${arg.replace(/'/g, `'\\''`)}'`;
}

/**
 * The command text a shell tool's input carries: Claude Code's and OpenCode's `{ command }`, Codex's
 * `{ command, cwd }` (a string, or the argument list it was split into), or a bare string.
 *
 * @param input - The tool's input, parsed or as it arrived.
 * @returns The command, and the folder it runs in when the input names one.
 */
export function shellCommandOf(input: unknown): { command: string; cwd?: string } | undefined {
  if (typeof input === 'string') return { command: input };
  if (!input || typeof input !== 'object') return undefined;
  const { command, cwd } = input as { command?: unknown; cwd?: unknown };
  const text = Array.isArray(command)
    ? command.map((arg) => shellQuoted(String(arg))).join(' ')
    : typeof command === 'string'
      ? command
      : undefined;
  if (text === undefined) return undefined;
  return {
    command: text,
    ...(typeof cwd === 'string' && path.isAbsolute(cwd) ? { cwd } : {}),
  };
}
