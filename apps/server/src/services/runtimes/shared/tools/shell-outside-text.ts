/**
 * Which shell commands hand the turn someone else's words (DOR-5236, DOR-5240, DOR-5261): a command
 * that fetches from the network (`shell-network-commands.ts`), a script file that does
 * (`shell-script-files.ts`), a project script whose commands do (`project-scripts.ts`), one that
 * names a file in a folder of outside files, and a recursive search that reaches one
 * (`shell-tree-searches.ts`, `outside-file-places.ts`). Such a command marks the turn, as a web
 * page does.
 *
 * It reads a command with the shell guard's own reader (`readCommand`), so it sees through pipes,
 * `&&`, `env` and `NAME=value` prefixes, `sudo`, `timeout`, `xargs`, an absolute program path,
 * `sh -c '…'`, `eval` and `$(…)` exactly as the guard does, and a path is read after its `cd`s,
 * `~`, `$HOME`, `$TMPDIR` (`${TMPDIR:-/tmp}` included), `for` lists and braces. A wildcard is
 * matched against the folders' names (`outside-file-patterns.ts`). A word too much to read marks.
 *
 * Generous over precise, because a mark only adds a hold and never lowers power. Commands that stay
 * local (`git status`, `git diff`, `pnpm test`, `ls` in the agent's folder) stay unmarked.
 *
 * @module services/runtimes/shared/tools/shell-outside-text
 */
import os from 'node:os';
import path from 'node:path';
import { expandTilde } from '../../../../lib/boundary.js';
import {
  commandOf,
  readCommand,
  scriptTexts,
  type ReadCommand,
} from '../../claude-code/shell-guard/shell-command.js';
import { pathPieces, type ShellSegment } from '../../claude-code/shell-guard/shell-words.js';
import { outsideFileTests, type CallPlace, type OutsideFileTests } from './outside-file-places.js';
import { hasWildcard } from './outside-file-patterns.js';
import { segmentFetches } from './shell-network-commands.js';
import { MAX_SCRIPT_FILES, scriptFileFetches } from './shell-script-files.js';
import { projectScriptOf } from './project-scripts.js';
import { searchesOutsideFiles } from './shell-tree-searches.js';

/** A command longer than this is not read; it marks, since what it does is unknown. */
const MAX_COMMAND = 100_000;

/** A piece spelled as a path, which is resolved and looked up on disk; a bare word is not. */
function spelledAsPath(piece: string): boolean {
  return /[\\/~$*?[]/.test(piece) || piece.startsWith('.');
}

/** The shell's starting variables a path may name: the computer's own, read here. */
function shellVariables(): Record<string, string | undefined> {
  // eslint-disable-next-line no-restricted-syntax -- the shell's own TMPDIR, kept with its trailing slash, which os.tmpdir() drops
  const { TMPDIR, USER, LOGNAME } = process.env;
  return { TMPDIR: TMPDIR || os.tmpdir(), USER, LOGNAME };
}

/** One command line, read once, with the tests its paths are put to. */
interface LineReading {
  read: ReadCommand;
  /** Every folder the command stands in, its `cd`s included. */
  cwds: string[];
  tests: OutsideFileTests;
}

/** The absolute paths a piece could name, one per folder the command stands in; `null` marks. */
function piecePaths(line: LineReading, piece: string): string[] | null {
  if (!spelledAsPath(piece)) return line.cwds.map((cwd) => path.resolve(cwd, piece));
  const out: string[] = [];
  for (const cwd of line.cwds) {
    // Opened as a write is, against one folder and with its wildcards left in place.
    const found = line.read.resolve(piece, { pieces: true, writingFrom: cwd });
    if (found === null) return null;
    out.push(...found);
  }
  return out;
}

/** Whether one command names a path in a folder of outside files. */
function namesOutsideFile(segment: ShellSegment, line: LineReading): boolean {
  for (const text of [...segment.words, ...segment.scripts]) {
    for (const piece of pathPieces(text)) {
      const named = piecePaths(line, piece);
      if (named === null) return true;
      const onDisk = spelledAsPath(piece);
      for (const absolute of named) {
        const reads = hasWildcard(absolute)
          ? line.tests.patternReaches(absolute, false)
          : line.tests.holdsPath(absolute, onDisk);
        if (reads) return true;
      }
    }
  }
  return false;
}

/** The one path a word names where its command stands; `null` when it names no one path. */
function onePath(read: ReadCommand, word: string, cwd: string): string | null {
  return read.resolve(word, { pieces: true, writingFrom: cwd })?.[0] ?? null;
}

/** Programs that write the file they are given, and the heredoc they are handed. */
const HEREDOC_WRITERS: ReadonlySet<string> = new Set(['cat', 'tee']);
/** Programs that copy or move files to their last word. */
const COPIERS: ReadonlySet<string> = new Set(['cp', 'mv', 'install', 'ln', 'rsync']);
/** Interpreters whose inline code may write any file it names (`python3 -c "open('x.sh', 'w')…"`). */
const CODE_WRITERS: ReadonlySet<string> = new Set([
  'python',
  'node',
  'bun',
  'deno',
  'ruby',
  'perl',
  'php',
]);

/** A command's heredoc text, or `null` when it has none. */
function heredocOf(segment: ShellSegment): string | null {
  return segment.scripts.length > 0 ? segment.scripts.join('\n') : null;
}

/**
 * The paths a command line writes, with the heredoc text written there when that is what is
 * written, and `null` when what is written cannot be known.
 */
function writtenPaths(read: ReadCommand): Map<string, string | null> {
  const out = new Map<string, string | null>();
  const note = (word: string, cwd: string, text: string | null): void => {
    const file = onePath(read, word, cwd);
    if (file === null) return;
    const before = out.get(file);
    out.set(file, before === null || text === null ? null : `${before ?? ''}${text}\n`);
  };
  for (const { segment, cwd } of read.segments) {
    const { verb, args } = commandOf(segment);
    const heredoc = HEREDOC_WRITERS.has(verb) ? heredocOf(segment) : null;
    for (const target of segment.redirects) note(target, cwd, heredoc);
    const words = args.filter((arg) => !arg.startsWith('-'));
    if (verb === 'tee') for (const target of words) note(target, cwd, heredoc);
    if (verb === 'dd') {
      // `dd of=x.sh <<EOF` writes its input; with `if=` it copies a file.
      const from = args.some((arg) => arg.startsWith('if=')) ? null : heredocOf(segment);
      for (const arg of args) if (arg.startsWith('of=')) note(arg.slice(3), cwd, from);
    }
    if (CODE_WRITERS.has(verb)) {
      // What inline code writes cannot be known, so each file it names counts as written.
      for (const piece of scriptTexts(segment).flatMap(pathPieces)) {
        if (/[./]/.test(piece)) note(piece, cwd, null);
      }
    }
    if (COPIERS.has(verb) && words.length >= 2) {
      const destination = words.at(-1)!;
      note(destination, cwd, null);
      for (const source of words.slice(0, -1)) {
        note(path.join(destination, path.basename(source)), cwd, null);
      }
    }
  }
  return out;
}

/** Programs that unpack an archive, and the flags naming where. */
const UNPACKERS: Readonly<Record<string, RegExp>> = {
  tar: /^(?:-C|--directory)$/,
  unzip: /^-d$/,
};

/**
 * The folders a command line makes, and the folders it unpacks archives into (whatever they hold
 * may appear below them), so a search later on the same line counts them as there.
 */
function madeFolders(read: ReadCommand): { made: string[]; below: string[] } {
  const made: string[] = [];
  const below: string[] = [];
  const add = (into: string[], word: string, cwd: string): void => {
    const found = onePath(read, word, cwd);
    if (found !== null) into.push(found);
  };
  for (const { segment, cwd } of read.segments) {
    const { verb, args } = commandOf(segment);
    const words = args.filter((arg) => !arg.startsWith('-'));
    if (verb === 'mkdir') for (const word of words) add(made, word, cwd);
    if (COPIERS.has(verb) && words.length >= 2) {
      const destination = words.at(-1)!;
      add(made, destination, cwd);
      for (const source of words.slice(0, -1)) {
        // `rsync -a src/ dest` copies what `src` holds, whatever its names.
        if (source.endsWith('/')) add(below, destination, cwd);
        else add(made, path.join(destination, path.basename(source)), cwd);
      }
    }
    const into = UNPACKERS[verb];
    const unpacks =
      verb === 'unzip' ||
      (verb === 'tar' && /^-?[A-Za-z]*x|^--(?:extract|get)$/.test(args[0] ?? ''));
    if (into && unpacks) {
      const flag = args.findIndex((arg) => into.test(arg));
      const named = args
        .find((arg) => arg.startsWith('--directory='))
        ?.slice('--directory='.length);
      add(below, named ?? (flag === -1 ? '.' : (args[flag + 1] ?? '.')), cwd);
    }
  }
  return { made, below };
}

/** Whether `target` is `folder` or inside it. Both absolute. */
function isAtOrInside(target: string, folder: string): boolean {
  const relative = path.relative(folder, target);
  return (
    relative === '' ||
    (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative))
  );
}

/**
 * Whether the command line makes a folder before it searches: a folder it makes (`mkdir`, a copy,
 * move or link to it) or one inside it, or any folder below where it unpacks an archive. Read
 * once, when a search first asks.
 */
function madeByLine(read: ReadCommand): (folder: string) => boolean {
  let found: { made: string[]; below: string[] } | undefined;
  return (folder) => {
    found ??= madeFolders(read);
    return (
      found.made.some((made) => isAtOrInside(made, folder)) ||
      found.below.some((unpacked) => isAtOrInside(folder, unpacked))
    );
  };
}

/**
 * Whether a shell command hands the turn someone else's words.
 *
 * @param command - The command line, as the runtime will run it.
 * @param place - Where it runs, so a file in the agent's own folder stays unmarked.
 */
export function commandReadsOutsideText(command: string, place: CallPlace = {}): boolean {
  return lineReadsOutsideText(command, place, true);
}

/** Whether a command line reads outside words; a project script it runs is read when `scripts`. */
function lineReadsOutsideText(command: string, place: CallPlace, scripts: boolean): boolean {
  if (command.length > MAX_COMMAND) return true;
  const home = expandTilde('~');
  // With no working folder known, a relative path names nothing outside.
  const cwd = place.cwd ?? place.agentHome ?? path.join(path.sep, '\0no-working-folder');
  const read = readCommand(command, { cwd, home, env: shellVariables() });
  const segments = read.segments;
  if (segments.some(({ segment }) => segmentFetches(segment))) return true;
  const line: LineReading = {
    read,
    cwds: [...new Set([cwd, ...segments.map((entry) => entry.cwd)])],
    tests: outsideFileTests(place, madeByLine(read)),
  };
  const budget = { files: MAX_SCRIPT_FILES };
  // eslint-disable-next-line no-restricted-syntax -- ripgrep's own config variable, which the shell's rg reads
  const ripgrepConfig =
    !!process.env.RIPGREP_CONFIG_PATH || command.includes('RIPGREP_CONFIG_PATH');
  let written: Map<string, string | null> | undefined;
  const writtenTo = (file: string) => (written ??= writtenPaths(read)).get(file);
  return segments.some(({ segment, cwd: standing }) => {
    const pathOf = (word: string) => onePath(read, word, standing);
    const fedBy = segment.pipedFrom;
    // One level: the commands a project script runs are read, but not a script they run by name.
    const project = scripts ? projectScriptOf(segment, standing, pathOf, budget) : undefined;
    return (
      (project !== undefined &&
        lineReadsOutsideText(project.text, { ...place, cwd: project.cwd }, false)) ||
      scriptFileFetches(segment, { pathOf, writtenTo, budget, ...(fedBy ? { fedBy } : {}) }) ||
      namesOutsideFile(segment, line) ||
      searchesOutsideFiles(segment, {
        pathsOf: (word) => piecePaths(line, word),
        tests: line.tests,
        ripgrepConfig,
      })
    );
  });
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
