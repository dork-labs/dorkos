/**
 * Script files a command runs, read for the network (DOR-5240, DOR-5261): `python3 fetch.py`,
 * `node get.mjs`, `bash pull.sh`, `deno run x.ts`, `tsx x.ts`, `source x.sh`, `./x.sh` by its `#!`
 * line, and the same started by a launcher (`pnpm exec tsx x.ts`, `uv run x.py`,
 * `script-launchers.ts`). A script read on an interpreter's input counts too: files after
 * `bash -s`, a file `cat` pipes in and text `echo` pipes in; anything else piped in marks. The
 * file is read where the command stands. A shell script is judged command by command, with its own variables and the
 * arguments it was given (`shell-script-variables.ts`); any other script by its web addresses and
 * its language's network calls, with its comments left out (`script-network-calls.ts`).
 *
 * A script the same command line writes first is judged by what it writes: a heredoc's text, and
 * otherwise it marks. A script that cannot be judged marks: a word naming no one path, a file over
 * {@link MAX_SCRIPT_BYTES}, a pipe or a device, or more than {@link MAX_SCRIPT_FILES} on one line.
 * A path with nothing there, a folder and a program's binary run no script.
 *
 * @module services/runtimes/shared/tools/shell-script-files
 */
import { closeSync, constants, fstatSync, openSync, readSync, statSync } from 'node:fs';
import path from 'node:path';
import { commandOf, SHELLS } from '../../claude-code/shell-guard/shell-command.js';
import type { ShellSegment } from '../../claude-code/shell-guard/shell-words.js';
import { hasWildcard } from './outside-file-patterns.js';
import { withoutComments, type CommentStyle } from './script-comments.js';
import { launchedCommand } from './script-launchers.js';
import { scriptFileTextFetches, type ScriptLanguage } from './script-network-calls.js';
import { shellFileFetches } from './shell-script-variables.js';

/** How much of a script file is read. */
export const MAX_SCRIPT_BYTES = 64 * 1024;
/** How many script files one command line may have read. */
export const MAX_SCRIPT_FILES = 8;

/** How each interpreter names its script: flags whose next word is a value, and inline-code flags. */
interface Runner {
  /** Flags that take the next word as their value. */
  values: ReadonlySet<string>;
  /** A flag that means the script is not a file: inline code or a module. */
  inline?: RegExp;
  /** A flag that means the script comes in on standard input (`bash -s`). */
  stdin?: RegExp;
  /** Its comment style, left out before the text is judged. */
  comments: CommentStyle;
  /** Whether its script is shell, read command by command. */
  shell?: boolean;
  /** The word before the file, when the program has commands of its own (`deno run`). */
  subcommand?: string;
  /** A flag whose value is the file (`php -f x.php`). */
  fileFlag?: string;
}

const SHELL_RUNNER: Runner = {
  values: new Set(['-o', '-O', '+o', '+O']),
  inline: /^-[A-Za-z]*c/,
  stdin: /^-[A-Za-z]*s/,
  comments: 'hash',
  shell: true,
};
/** `source x.sh` and `. x.sh` run a shell script in the shell that is running. */
const SOURCE_RUNNER: Runner = { values: new Set(), comments: 'hash', shell: true };
/** TypeScript runners, which take Node's inline-code flags. */
const TS_RUNNER: Runner = {
  values: new Set(['-r', '--require', '--import', '--tsconfig', '-P', '--project']),
  inline: /^(-[A-Za-z]*[ep]|--eval|--print)(=|$)/,
  comments: 'slash',
  subcommand: 'watch',
};

/** The interpreters whose file argument is read. */
const RUNNERS: Readonly<Record<string, Runner>> = {
  python: { values: new Set(['-W', '-X', '-Q']), inline: /^(-[A-Za-z]*c|-m)/, comments: 'hash' },
  node: {
    values: new Set(['-r', '--require', '--import', '--loader', '--experimental-loader', '-C']),
    inline: /^(-[A-Za-z]*[ep]|--eval|--print)(=|$)/,
    comments: 'slash',
  },
  bun: {
    values: new Set(['-r', '--preload', '--cwd']),
    inline: /^(-e|--eval)$/,
    comments: 'slash',
    subcommand: 'run',
  },
  deno: { values: new Set(), comments: 'slash', subcommand: 'run' },
  ruby: { values: new Set(['-I', '-r', '-C', '-E']), inline: /^-[A-Za-z]*e$/, comments: 'hash' },
  perl: { values: new Set(['-I']), inline: /^-[A-Za-z]*[eE]$/, comments: 'hash' },
  php: {
    values: new Set(['-c', '-d', '-z']),
    inline: /^-[A-Za-z]*[ar]$/,
    comments: 'slash',
    fileFlag: '-f',
  },
  tsx: TS_RUNNER,
  'ts-node': TS_RUNNER,
  'vite-node': TS_RUNNER,
  source: SOURCE_RUNNER,
  '.': SOURCE_RUNNER,
  ...Object.fromEntries([...SHELLS].map((shell) => [shell, SHELL_RUNNER])),
};

/** How a file names the program that runs it, from its `#!` line. */
function shebangProgram(text: string): string | undefined {
  if (!text.startsWith('#!')) return undefined;
  const words = text.slice(2, text.indexOf('\n') === -1 ? undefined : text.indexOf('\n')).trim();
  const [program, ...rest] = words.split(/\s+/);
  const name = path.basename(program ?? '');
  if (name !== 'env') return name;
  return path.basename(rest.find((word) => !word.startsWith('-')) ?? '');
}

/** What reading a script file found. */
export type ScriptRead =
  | { kind: 'text'; text: string }
  /** Nothing there, a folder, or a program's binary: the shell's own error or a real program. */
  | { kind: 'none' }
  /** Something that cannot be judged: too big, a pipe or a device, or unreadable. */
  | { kind: 'unknown' };

/** How much of a file is read to tell a program's binary from a script. */
const SNIFF_BYTES = 4_096;

/**
 * A script file's text, when it is a regular file of text no bigger than {@link MAX_SCRIPT_BYTES}.
 *
 * @param file - The file, absolute.
 */
export function readScript(file: string): ScriptRead {
  let stat;
  try {
    stat = statSync(file);
  } catch {
    return { kind: 'none' };
  }
  if (stat.isDirectory()) return { kind: 'none' };
  if (!stat.isFile()) return { kind: 'unknown' };
  let handle: number | undefined;
  try {
    // Non-blocking, so a pipe swapped in after the check never holds the server.
    handle = openSync(file, constants.O_RDONLY | constants.O_NONBLOCK);
    if (!fstatSync(handle).isFile()) return { kind: 'unknown' };
    const buffer = Buffer.alloc(Math.min(stat.size, MAX_SCRIPT_BYTES + 1));
    const length = readSync(handle, buffer, 0, buffer.length, 0);
    const read = buffer.subarray(0, length);
    if (read.subarray(0, SNIFF_BYTES).includes(0)) return { kind: 'none' };
    if (length > MAX_SCRIPT_BYTES) return { kind: 'unknown' };
    return { kind: 'text', text: read.toString('utf8') };
  } catch {
    return { kind: 'unknown' };
  } finally {
    if (handle !== undefined) closeSync(handle);
  }
}

/** Where an interpreter's script is named among its arguments: `-1` for none, `-2` for its input. */
function scriptAt(runner: Runner, args: readonly string[]): number {
  let subcommandSeen = runner.subcommand === undefined;
  for (let at = 0; at < args.length; at += 1) {
    const arg = args[at]!;
    if (runner.inline?.test(arg)) return -1;
    if (runner.stdin?.test(arg)) return -2;
    if (runner.values.has(arg)) {
      at += 1;
      continue;
    }
    if (arg === runner.fileFlag) return at + 1 < args.length ? at + 1 : -1;
    if (arg.startsWith('-') || arg.startsWith('+')) continue;
    if (subcommandSeen) return at;
    // `deno run x.ts`; `deno x.ts` as well, but no other command of Deno's.
    if (arg === runner.subcommand) subcommandSeen = true;
    else return /\.[cm]?[jt]sx?$/.test(arg) ? at : -1;
  }
  return subcommandSeen ? -2 : -1;
}

/** The language whose network calls a program's script is read for. */
function languageOf(program: string): ScriptLanguage {
  const name = program.replace(/^python[\d.]*$/, 'python');
  if (name === 'python' || name === 'ruby' || name === 'perl' || name === 'php') return name;
  if (name === 'node' || name === 'bun' || name === 'deno' || /^tsx?$|^ts-node$/.test(name)) {
    return 'js';
  }
  return 'any';
}

/** Whether a script's text reaches the network, read by the rules its program gets. */
function textFetches(text: string, program: string, args: readonly string[]): boolean {
  const runner = RUNNERS[program.replace(/^python[\d.]*$/, 'python')];
  if (runner?.shell) return shellFileFetches(text, args);
  const language = languageOf(program);
  return scriptFileTextFetches(withoutComments(text, runner?.comments ?? 'hash'), language);
}

/** What is left of one command line's allowance of script files. */
export interface ScriptFileBudget {
  /** Files still allowed. */
  files: number;
}

/** How a command line reads the script files its commands run. */
export interface ScriptFileReading {
  /** Turns a word into the absolute path it names, or `null` when it cannot. */
  pathOf: (word: string) => string | null;
  /**
   * What the same command line writes to a path before it may run it: the heredoc's text when
   * that is what is written, `null` when what is written cannot be known, `undefined` when the
   * line writes nothing there.
   */
  writtenTo: (file: string) => string | null | undefined;
  /** The command line's allowance, spent here. */
  budget: ScriptFileBudget;
  /** The command whose output is piped into this one, when one is. */
  fedBy?: ShellSegment;
}

/** Programs that print the text they are given. */
const PRINTERS: ReadonlySet<string> = new Set(['echo', 'printf']);

/** Whether one script file reaches the network, read by the rules `program` gets. */
function fileFetches(
  word: string,
  program: string | undefined,
  args: readonly string[],
  reading: ScriptFileReading
): boolean {
  if (reading.budget.files <= 0) return true;
  reading.budget.files -= 1;
  if (hasWildcard(word)) return true;
  const file = reading.pathOf(word);
  if (!file || file.includes('$')) return true;
  const written = reading.writtenTo(file);
  if (written === null) return true;
  if (written !== undefined && textFetches(written, program ?? shebangOf(written), args)) {
    return true;
  }
  const read = readScript(file);
  if (read.kind === 'unknown') return true;
  if (read.kind === 'none') return false;
  // A text file with no `#!` line runs in the shell.
  return textFetches(read.text, program ?? shebangOf(read.text), args);
}

/** The program a file's `#!` line names, or the shell. */
function shebangOf(text: string): string {
  return shebangProgram(text) ?? 'sh';
}

/**
 * Whether the script an interpreter reads on its input reaches the network: files named after
 * `bash -s` (what `<` hands it), and what is piped in. Printed text is judged as the script; a
 * file `cat` prints is read as one; anything else piped in cannot be judged.
 */
function inputFetches(
  program: string,
  args: readonly string[],
  reading: ScriptFileReading
): boolean {
  const after = args.slice(args.findIndex((arg) => RUNNERS[program]?.stdin?.test(arg)) + 1);
  const words = after.filter((arg) => !arg.startsWith('-'));
  if (words.length > MAX_SCRIPT_FILES) return true;
  for (const word of words) {
    // The script's own arguments name no file; only the file `<` hands it is read.
    const file = reading.pathOf(word);
    if (file && readScript(file).kind === 'none') continue;
    if (fileFetches(word, program, [], reading)) return true;
  }
  if (!reading.fedBy) return false;
  const { verb, args: fed } = commandOf(reading.fedBy);
  if (PRINTERS.has(verb)) {
    const text = fed.slice(fed.findIndex((word) => !word.startsWith('-')));
    return textFetches(text.join(' '), program, []);
  }
  if (verb !== 'cat') return true;
  return fed.some((word) => !word.startsWith('-') && fileFetches(word, program, [], reading));
}

/**
 * Whether the script file one command runs reaches the network: the file it names, or the script it
 * reads on its input.
 *
 * @param segment - The command.
 * @param reading - How the command line's paths, writes and allowance are read.
 */
export function scriptFileFetches(segment: ShellSegment, reading: ScriptFileReading): boolean {
  const launched = launchedCommand(segment);
  if (launched) return scriptFileFetches(launched, reading);
  const { verb, args } = commandOf(segment);
  const program = verb.toLowerCase().replace(/\.exe$/, '');
  const runner = RUNNERS[program];
  // The program's own word, as written: a path to a script runs it by its `#!` line.
  const programWord = segment.words[segment.words.length - args.length - 1] ?? '';
  if (!runner) {
    return /[\\/]/.test(programWord) && fileFetches(programWord, undefined, args, reading);
  }
  const at = scriptAt(runner, args);
  if (at === -1) return false;
  if (at === -2) return segment.scripts.length === 0 && inputFetches(program, args, reading);
  return fileFetches(args[at]!, program, args.slice(at + 1), reading);
}
