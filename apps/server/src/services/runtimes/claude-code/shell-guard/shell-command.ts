/**
 * One shell command line as the guard reads it (DOR-3300): its commands, with what `sh -c`, `eval`
 * and `$(…)` run pulled out, each command's name, and how a word turns into real paths after its
 * variables, `cd`s and wildcards.
 *
 * @module services/runtimes/claude-code/shell-guard/shell-command
 */
import { lstatSync, readdirSync } from 'node:fs';
import path from 'node:path';
import {
  expandBraces,
  expandVariables,
  parseShell,
  pathPieces,
  type ShellSegment,
} from './shell-words.js';

/** The most pieces one word may name before it counts as unreadable. */
const MAX_PIECES = 5_000;
/** The most paths one glob opens into before it counts as protected. */
const MAX_GLOB_RESULTS = 500;
/** The most folders a `**` looks through before it counts as protected. */
const MAX_GLOB_FOLDERS = 2_000;
/** How deep `sh -c "sh -c …"` is followed. */
const MAX_NESTING = 3;

/** Words that open a block or run the next word as the command. */
const COMMAND_PREFIXES = new Set([
  'if',
  'then',
  'elif',
  'else',
  'while',
  'until',
  'do',
  '!',
  '{',
  'env',
  'sudo',
  'command',
  'builtin',
  'nice',
  'nohup',
  'time',
  'timeout',
  'xargs',
  'exec',
]);

/** Programs whose text argument or heredoc is itself a script. */
export const INTERPRETERS = new Set([
  'python',
  'python3',
  'node',
  'bun',
  'deno',
  'ruby',
  'perl',
  'php',
  'awk',
  'gawk',
  'sh',
  'bash',
  'zsh',
  'dash',
  'eval',
]);

/** Shells, whose script is more shell to read. */
export const SHELLS: ReadonlySet<string> = new Set(['sh', 'bash', 'zsh', 'dash']);

/**
 * A segment's command name and the words after it, past keywords, `env`, `sudo` and the like.
 *
 * @param segment - One command.
 */
export function commandOf(segment: ShellSegment): {
  verb: string;
  args: string[];
  viaXargs: boolean;
} {
  let at = 0;
  let viaXargs = false;
  while (at < segment.words.length) {
    const word = segment.words[at]!;
    const name = path.basename(word);
    if (/^[A-Za-z_]\w*=/.test(word)) {
      at += 1;
    } else if (COMMAND_PREFIXES.has(name)) {
      viaXargs ||= name === 'xargs';
      at += 1;
      // A prefix's own options and their values: `nice -n 5`, `timeout 5s`, `sudo -u root`,
      // `xargs -I {} rm {}`.
      for (;;) {
        const next = segment.words[at] ?? '';
        if (/^-[unIgLP]$/.test(next)) at += 2;
        else if (/^(-.*|\d+(\.\d+)?[smhd]?)$/.test(next)) at += 1;
        else break;
      }
    } else {
      return {
        verb: name.replace(/^python[\d.]+$/, 'python'),
        args: segment.words.slice(at + 1),
        viaXargs,
      };
    }
  }
  return { verb: '', args: [], viaXargs };
}

/**
 * The text a program runs as a script: its heredocs, and the value of a flag that takes one.
 *
 * @param segment - One command.
 */
export function scriptTexts(segment: ShellSegment): string[] {
  const { verb, args } = commandOf(segment);
  if (!INTERPRETERS.has(verb)) return [];
  const inline = args.filter((_, i) => /^(-[A-Za-z]*[cepEr]|--eval)$/.test(args[i - 1] ?? ''));
  return [...segment.scripts, ...inline];
}

/** Add what a segment runs through a shell, `eval` or `$(…)`, as segments of their own. */
function withNested(segments: ShellSegment[], depth = 0): ShellSegment[] {
  if (depth >= MAX_NESTING) return segments;
  const out: ShellSegment[] = [];
  for (const segment of segments) {
    out.push(segment);
    const { verb, args } = commandOf(segment);
    const inner: string[] = [];
    if (SHELLS.has(verb)) inner.push(...scriptTexts(segment));
    if (verb === 'eval') inner.push(args.join(' '));
    for (const word of [...segment.words, ...segment.redirects]) {
      // A `$(…)` left whole by double quotes. Only one with no parens inside: a PR body in a
      // heredoc is prose, and reading it as commands would refuse a sentence.
      for (const match of word.matchAll(/\$\(([^()]*)\)|`([^`]*)`/g)) {
        inner.push(match[1] ?? match[2] ?? '');
      }
    }
    if (inner.length > 0) out.push(...withNested(inner.flatMap(parseShell), depth + 1));
  }
  return out;
}

/** A path's wildcards as a regex for one name. A `[` with no close is a plain `[`, as in a shell. */
function namePattern(segment: string): RegExp {
  const body = segment
    .replace(/[.+$(){}|\\]/g, '\\$&')
    .replace(/(?<!\[)\^/g, '\\^')
    .replace(/\[!/g, '[^')
    .replace(/\*+/g, '.*')
    .replace(/\?/g, '.');
  try {
    return new RegExp(`^${body}$`, 'i');
  } catch {
    return new RegExp(`^${segment.replace(/[.+$(){}|\\^[\]*?]/g, '\\$&')}$`, 'i');
  }
}

/** Every folder at or below `base`, for a `**`. `false` when the command's budget runs out. */
function foldersBelow(base: string, seen: Set<string>, budget: { folders: number }): boolean {
  const pending = [base];
  while (pending.length > 0) {
    const current = pending.pop()!;
    if (seen.has(current)) continue;
    seen.add(current);
    if (--budget.folders < 0) return false;
    try {
      for (const entry of readdirSync(current, { withFileTypes: true })) {
        if (entry.isDirectory()) pending.push(path.join(current, entry.name));
      }
    } catch {
      // Not a folder, or not readable: nothing below it.
    }
  }
  return true;
}

/** Open a path's wildcards against the disk. `null` when it opens into too much to check. */
function openGlob(target: string, dotFiles: boolean, budget: { folders: number }): string[] | null {
  if (!/[*?[]/.test(target)) return [target];
  const { root } = path.parse(target);
  let found = [root];
  for (const segment of target.slice(root.length).split(path.sep).filter(Boolean)) {
    if (segment === '**') {
      const folders = new Set<string>();
      for (const base of found) if (!foldersBelow(base, folders, budget)) return null;
      found = [...folders];
      continue;
    }
    if (!/[*?[]/.test(segment)) {
      found = found.map((base) => path.join(base, segment));
      continue;
    }
    const pattern = namePattern(segment);
    const next: string[] = [];
    for (const base of found) {
      try {
        for (const name of readdirSync(base)) {
          if (!dotFiles && name.startsWith('.') && !segment.startsWith('.')) continue;
          if (pattern.test(name)) next.push(path.join(base, name));
        }
      } catch {
        // Not a folder, or not readable: no match here.
      }
      if (next.length > MAX_GLOB_RESULTS) return null;
    }
    found = next;
  }
  return found;
}

/**
 * Whether a path exists, link or not. A name too long to open does not.
 *
 * @param target - An absolute path.
 */
export function pathExists(target: string): boolean {
  try {
    return lstatSync(target, { throwIfNoEntry: false }) !== undefined;
  } catch {
    return false;
  }
}

/** How to turn a word into paths. */
export interface ResolveOptions {
  /** Whether to look inside it too, for a word that isn't one path. */
  pieces: boolean;
  /**
   * The folder the word's command stands in, for a write. A write has to be sure, so it takes this
   * one folder rather than every folder the command reaches, and opens wildcards as a shell does:
   * a `*` skips dot files, and a script's `2 * 3` opens nothing. A read takes every folder and
   * every file, because matching more only asks.
   */
  writingFrom?: string;
}

/** What a word could name, and where to look. */
export interface ReadCommand {
  /** Every command, nested ones included, each with the folder it runs in. */
  segments: { segment: ShellSegment; cwd: string }[];
  /**
   * Turn a word into the absolute paths it could name; `null` when it opens into too much.
   *
   * @param word - The word.
   * @param options - How to read it.
   */
  resolve: (word: string, options: ResolveOptions) => string[] | null;
}

/**
 * Parse a command, following its `cd`s, `NAME=value`s and `for` lists.
 *
 * @param command - The command line.
 * @param where - The working folder, the home folder and the shell's starting variables.
 * @param where.cwd - The working folder.
 * @param where.home - The home folder.
 * @param where.env - The shell's starting variables.
 */
export function readCommand(
  command: string,
  where: { cwd: string; home: string; env: Readonly<Record<string, string | undefined>> }
): ReadCommand {
  const parsed = withNested(parseShell(command));
  const vars: Record<string, string | undefined> = {
    HOME: where.home,
    ...where.env,
    PWD: where.cwd,
  };
  const lists = new Map<string, string[]>();
  for (const { words } of parsed) {
    if (words[0] === 'for' && words[2] === 'in' && /^[A-Za-z_]\w*$/.test(words[1] ?? '')) {
      lists.set(words[1]!, words.slice(3));
    }
    for (const word of words) {
      const assigned = /^([A-Za-z_]\w*)=(.*)$/s.exec(word);
      if (assigned) vars[assigned[1]!] = expandVariables(assigned[2]!, where.home, vars);
    }
  }
  const open = (word: string): string[] => {
    let opened = [word];
    for (const [name, values] of lists) {
      if (!word.includes(name)) continue;
      const pattern = new RegExp(`\\$\\{?${name}\\}?(?!\\w)`, 'g');
      opened = opened.flatMap((one) =>
        pattern.test(one) ? values.map((value) => one.replace(pattern, value)) : [one]
      );
    }
    return opened.flatMap(expandBraces).map((piece) =>
      // Where the command stands is a relative path, so it follows the `cd`s below.
      expandVariables(piece.replace(/(\$\(pwd\)|\$PWD|\$\{PWD\})\/?/g, './'), where.home, vars)
    );
  };
  const budget = { folders: MAX_GLOB_FOLDERS };
  // Every folder a `cd` reaches counts for every named word: a subshell's `cd` ends early, and
  // asking about a path it didn't reach costs less than missing one it did.
  const cwds = new Set([where.cwd]);
  let current = where.cwd;
  const segments = parsed.map((segment) => {
    const { verb, args } = commandOf(segment);
    if (verb === 'cd' || verb === 'pushd') {
      const target = args.find((arg) => !arg.startsWith('-'));
      current = target === undefined ? where.home : path.resolve(current, open(target)[0] ?? '');
      cwds.add(current);
    }
    // `git -C <folder>` stands there for this one command.
    const gitFolder = verb === 'git' && args[0] === '-C' ? args[1] : undefined;
    if (gitFolder === undefined) return { segment, cwd: current };
    const cwd = path.resolve(current, open(gitFolder)[0] ?? '');
    cwds.add(cwd);
    return { segment, cwd };
  });
  return {
    segments,
    resolve: (word, { pieces, writingFrom }) => {
      const results = new Set<string>();
      for (const opened of open(word)) {
        for (const piece of pieces ? pathPieces(opened) : [opened]) {
          // Again per piece: `--file=~/x` and a script's `'~/x'` start with `~` only here.
          const named = expandVariables(piece, where.home, vars);
          for (const cwd of writingFrom ? [writingFrom] : cwds) {
            results.add(path.resolve(cwd, named));
          }
        }
      }
      if (results.size > MAX_PIECES) return null;
      const all: string[] = [];
      for (const result of results) {
        if (writingFrom && pieces) {
          all.push(result);
          continue;
        }
        const globbed = openGlob(result, !writingFrom, budget);
        if (globbed === null) return null;
        all.push(...globbed);
      }
      return all;
    },
  };
}
