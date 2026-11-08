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
  MAX_PATH_PIECE,
  pathPieces,
  type ShellSegment,
} from './shell-words.js';

/** The most pieces one word may name before it counts as unreadable. */
const MAX_PIECES = 5_000;
/**
 * The work one check may do before the command counts as unreadable, across everything it does:
 * this runs in the server, before any card, on text an agent chose, so no one shape of command gets
 * its own limit to find a way around. Roughly a character handled; the costs below weigh the rest.
 */
const MAX_WORK = 4_000_000;
/** What one named path costs: it gets resolved, and then checked against every rule. */
const PATH_COST = 256;
/** What listing one folder costs. */
const LISTING_COST = 1_024;
/** What one entry of a listing costs, before matching its name. */
const ENTRY_COST = 64;
/** A wildcard match's cost is its name times its pattern, over this. */
const MATCH_COST_DIVISOR = 8;
/** The most `for` lists a command may hold before a word using a variable counts as unreadable. */
const MAX_FOR_LISTS = 64;
/** The most folders a command's `cd`s may reach: every named word is resolved against each. */
const MAX_CWDS = 64;
/** The most paths one glob opens into before it counts as protected. */
const MAX_GLOB_RESULTS = 500;
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

/** One step of a wildcard pattern: `*`, or a test of one character. */
type WildcardStep = '*' | ((char: string) => boolean);

/**
 * Whether a range holds the same letters in every shell. Bash under a UTF-8 locale orders a < A < b,
 * so `[a-Z]` and `[:-~]` open into names they wouldn't by code point, and under `LC_ALL=C` they
 * don't. A shell's locale can't be read from here, so only forward ranges of digits or same-case
 * letters are read as written. Any other set may hold anything, because matching more only refuses.
 */
function ordersTheSameEverywhere(from: string, to: string): boolean {
  if (from > to) return false;
  return [/^[0-9]$/, /^[a-z]$/, /^[A-Z]$/].some((kind) => kind.test(from) && kind.test(to));
}

/** A `[…]` as a test of one lowercased character, and where it ends. No close means no set. */
function characterSet(
  segment: string,
  open: number
): { test: (char: string) => boolean; end: number } | undefined {
  let at = open + 1;
  const negate = segment[at] === '!' || segment[at] === '^';
  if (negate) at += 1;
  const first = at;
  const singles = new Set<string>();
  const ranges: [string, string][] = [];
  let anything = false;
  while (at < segment.length && (segment[at] !== ']' || at === first)) {
    if (['[:', '[.', '[='].some((form) => segment.startsWith(form, at))) {
      // Classes, collating symbols and equivalence classes depend on the shell and locale.
      // Skip the whole inner form; the outer set may hold anything, so matching more refuses.
      const close = segment.indexOf(`${segment[at + 1]}]`, at + 2);
      if (close === -1) throw new Error('Unclosed shell bracket form.');
      anything = true;
      at = close + 2;
      continue;
    }
    // Bash and zsh read `,-[` as a range, which holds `.`; skipping it as one here would need the
    // shell's rule for where the set then ends. Matching more only refuses.
    if (segment[at + 1] === '-' && segment[at + 2] === '[') anything = true;
    if (
      segment[at + 1] === '-' &&
      at + 2 < segment.length &&
      segment[at + 2] !== ']' &&
      segment[at + 2] !== '['
    ) {
      if (!ordersTheSameEverywhere(segment[at]!, segment[at + 2]!)) anything = true;
      ranges.push([segment[at]!, segment[at + 2]!]);
      at += 3;
    } else {
      singles.add(segment[at]!);
      at += 1;
    }
  }
  if (at >= segment.length) {
    if (anything) throw new Error('Unclosed shell bracket set.');
    // Zsh reads `[!]` as any one character, and the Mac's shell is zsh. Matching more only refuses.
    if (!negate) return undefined;
    return { test: () => true, end: segment[first] === ']' ? first : first - 1 };
  }
  // Negated too: a set that may hold anything may also leave anything out.
  if (anything) return { test: () => true, end: at };
  const member = (char: string): boolean =>
    singles.has(char) || ranges.some(([from, to]) => char >= from && char <= to);
  // Read against the pattern as written, so `Z-d` keeps its meaning. A shell tests the real
  // character, which is all a negated set needs; a plain set also tries both cases, because the
  // Mac's disk ignores case and matching more only refuses.
  const test = (char: string): boolean =>
    negate
      ? !member(char)
      : member(char) || member(char.toLowerCase()) || member(char.toUpperCase());
  return { test, end: at };
}

/** A path's wildcards as steps for one name. Plain letters match in either case. */
function wildcardSteps(segment: string): WildcardStep[] {
  const steps: WildcardStep[] = [];
  for (let i = 0; i < segment.length; i++) {
    const char = segment[i]!;
    if (char === '*') {
      if (steps.at(-1) !== '*') steps.push('*');
    } else if (char === '?') {
      steps.push(() => true);
    } else {
      // Otherwise a `[` with no close is a plain `[`, as in a shell.
      const set = char === '[' ? characterSet(segment, i) : undefined;
      if (set) i = set.end;
      const lower = char.toLowerCase();
      steps.push(set ? set.test : (other) => other.toLowerCase() === lower);
    }
  }
  return steps;
}

/**
 * Whether a name fits a pattern. A regex here backtracked: four stars on a long file name an agent
 * made itself took 24 s in the server. This only ever goes back to the last star, so it does at most
 * name × pattern steps, which the caller charges for.
 */
function matchesWildcard(name: string, steps: readonly WildcardStep[]): boolean {
  let at = 0;
  let step = 0;
  let star = -1;
  let mark = 0;
  while (at < name.length) {
    const current = steps[step];
    if (current === '*') {
      star = step;
      step += 1;
      mark = at;
    } else if (current !== undefined && current(name[at]!)) {
      at += 1;
      step += 1;
    } else if (star !== -1) {
      step = star + 1;
      mark += 1;
      at = mark;
    } else {
      return false;
    }
  }
  while (steps[step] === '*') step += 1;
  return step === steps.length;
}

/** The check's shared work allowance. `false` once it is spent. */
interface WorkBudget {
  spend: (cost: number) => boolean;
}

/** Every folder at or below `base`, for a `**`. `false` when the command's budget runs out. */
function foldersBelow(base: string, seen: Set<string>, budget: WorkBudget): boolean {
  const pending = [base];
  while (pending.length > 0) {
    const current = pending.pop()!;
    if (seen.has(current)) continue;
    seen.add(current);
    if (!budget.spend(LISTING_COST)) return false;
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
function openGlob(
  target: string,
  options: { dotFiles: boolean; keep?: (found: string) => boolean },
  budget: WorkBudget
): string[] | null {
  if (!/[*?[]/.test(target)) return [target];
  const { dotFiles, keep } = options;
  const { root } = path.parse(target);
  let found = [root];
  const segments = target.slice(root.length).split(path.sep).filter(Boolean);
  for (const [index, segment] of segments.entries()) {
    const last = index === segments.length - 1;
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
    const steps = wildcardSteps(segment);
    const next: string[] = [];
    for (const base of found) {
      if (!budget.spend(LISTING_COST)) return null;
      try {
        for (const name of readdirSync(base)) {
          // The pattern's length, not its steps: one `[…]` is one step however many ranges it holds.
          const cost = ENTRY_COST + (name.length * segment.length) / MATCH_COST_DIVISOR;
          if (!budget.spend(cost)) return null;
          if (!dotFiles && name.startsWith('.') && !segment.startsWith('.')) continue;
          if (matchesWildcard(name, steps)) next.push(path.join(base, name));
        }
      } catch {
        // Not a folder, or not readable: no match here.
      }
      if (next.length > MAX_GLOB_RESULTS && !(last && keep)) return null;
    }
    // `rm build/*` in a big folder: only the names that could matter have to fit.
    found = last && keep && next.length > MAX_GLOB_RESULTS ? next.filter(keep) : next;
    if (found.length > MAX_GLOB_RESULTS) return null;
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
  /**
   * For a write: the only names worth keeping when there are too many to check them all. A script's
   * words are always cut to these, so padding one with junk paths can neither hide a write nor
   * refuse it.
   */
  keep?: (found: string) => boolean;
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
  // Sticky: once part of the command couldn't be read, nothing about the rest can be trusted. A
  // `cd` that couldn't be opened used to mean "stayed put", which hid a write to a setup file.
  let unreadable = false;
  for (const { words } of parsed) {
    if (words[0] === 'for' && words[2] === 'in' && /^[A-Za-z_]\w*$/.test(words[1] ?? '')) {
      lists.set(words[1]!, words.slice(3));
    }
    for (const word of words) {
      const assigned = /^([A-Za-z_]\w*)=(.*)$/s.exec(word);
      if (!assigned) continue;
      const value = expandVariables(assigned[2]!, where.home, vars);
      if (value === null) unreadable = true;
      else vars[assigned[1]!] = value;
    }
  }
  let work = MAX_WORK;
  const budget: WorkBudget = {
    spend: (cost) => {
      work -= cost;
      return work >= 0;
    },
  };
  // Nested `for` lists multiply, so what they would build is paid for BEFORE it is built, in bytes
  // as well as strings: 700 bytes once ran the server out of memory.
  const open = (word: string): string[] | null => {
    let opened = [word];
    if (word.includes('$')) {
      if (lists.size > MAX_FOR_LISTS) return null;
      for (const [name, values] of lists) {
        if (!word.includes(name)) continue;
        const pattern = new RegExp(`\\$\\{?${name}\\}?(?!\\w)`, 'g');
        const valueBytes = values.reduce((sum, value) => sum + value.length, 0);
        let built = 0;
        let cost = 0;
        for (const one of opened) {
          const uses = one.match(pattern)?.length ?? 0;
          built += uses === 0 ? 1 : values.length;
          if (uses > 0) cost += one.length * values.length + valueBytes * uses;
        }
        if (built > MAX_PIECES || !budget.spend(cost)) return null;
        opened = opened.flatMap((one) =>
          one.search(pattern) === -1
            ? [one]
            : values.map((value) => one.replace(pattern, () => value))
        );
      }
    }
    const results: string[] = [];
    for (const one of opened) {
      const braces = expandBraces(one);
      if (braces === null) return null;
      for (const piece of braces) {
        if (!budget.spend(piece.length)) return null;
        // Where the command stands is a relative path, so it follows the `cd`s below.
        const named = expandVariables(
          piece.replace(/(\$\(pwd\)|\$PWD|\$\{PWD\})\/?/g, './'),
          where.home,
          vars
        );
        if (named === null) return null;
        results.push(named);
      }
    }
    return results;
  };
  // Every folder a `cd` reaches counts for every named word: a subshell's `cd` ends early, and
  // asking about a path it didn't reach costs less than missing one it did.
  const cwds = new Set([where.cwd]);
  let current = where.cwd;
  const segments = parsed.map((segment) => {
    const { verb, args } = commandOf(segment);
    // Past the cap the command is unreadable anyway, and each `cd` here makes a longer path.
    if (cwds.size > MAX_CWDS) return { segment, cwd: current };
    if (verb === 'cd' || verb === 'pushd') {
      const target = args.find((arg) => !arg.startsWith('-'));
      const opened = target === undefined ? [where.home] : open(target);
      if (opened === null) unreadable = true;
      else current = path.resolve(current, opened[0] ?? '');
      cwds.add(current);
    }
    // `git -C <folder>` stands there for this one command.
    const gitFolder = verb === 'git' && args[0] === '-C' ? args[1] : undefined;
    if (gitFolder === undefined) return { segment, cwd: current };
    const opened = open(gitFolder);
    if (opened === null) unreadable = true;
    const cwd = path.resolve(current, opened?.[0] ?? '');
    cwds.add(cwd);
    return { segment, cwd };
  });
  return {
    segments,
    resolve: (word, { pieces, writingFrom, keep }) => {
      if (unreadable || cwds.size > MAX_CWDS) return null;
      const words = open(word);
      if (words === null) return null;
      const results = new Set<string>();
      for (const opened of words) {
        for (const piece of pieces ? pathPieces(opened) : [opened]) {
          if (writingFrom && pieces && keep && !keep(piece)) continue;
          if (piece.length > MAX_PATH_PIECE) {
            // Too long to open as written, but a wildcard can open it into a real name:
            // `hos[ttt…1,100…].key` printed the file. Only plain text this long names nothing.
            // A written word that could name a setup file too: `mkdir -p` walks folder by folder.
            if (/[*?[]/.test(piece) || keep?.(piece)) return null;
            continue;
          }
          // Again per piece: `--file=~/x` and a script's `'~/x'` start with `~` only here.
          const named = expandVariables(piece, where.home, vars);
          if (named === null) return null;
          for (const cwd of writingFrom ? [writingFrom] : cwds) {
            if (!budget.spend(PATH_COST + named.length)) return null;
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
        const globbed = openGlob(
          result,
          { dotFiles: !writingFrom, ...(keep ? { keep } : {}) },
          budget
        );
        if (globbed === null) return null;
        all.push(...globbed);
      }
      return all;
    },
  };
}
