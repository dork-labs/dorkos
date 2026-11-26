/**
 * Which shell commands search a folder tree, and where they start (DOR-5236, DOR-5240, DOR-5261):
 * `grep -r` (and `grep -d recurse`), `rg`, `ag`, `ack`, `fd` and `find`. A search marks when a root
 * reaches a folder of outside files (`outside-file-places.ts`).
 *
 * A root is a positional word past each program's flags and the values they take, and past the
 * pattern when the pattern is not given by a flag; with none, the search starts where it stands.
 * `find`'s roots come after its own flags (BSD's `-E -X -d -s -x` and `-f <folder>` too). `rg`, `ag`
 * and `fd` leave hidden folders out unless told otherwise; `grep -r`, `ack` and `find` enter them
 * (ack leaves out only named folders such as `.git`). `rg` honours the ignore file written beside
 * room attachments copied into a tree when it keeps its ignore files in force: no `-u` or
 * `--no-ignore`, only negated or file-extension globs, and no config file in play.
 *
 * @module services/runtimes/shared/tools/shell-tree-searches
 */
import { commandOf } from '../../claude-code/shell-guard/shell-command.js';
import type { ShellSegment } from '../../claude-code/shell-guard/shell-words.js';
import { globsKeepIgnores, type OutsideFileTests, type SearchWalk } from './outside-file-places.js';
import { hasWildcard } from './outside-file-patterns.js';

/** How one search program reads its words. */
interface TreeSearch {
  /** Flags that take the next word as their value. */
  values: ReadonlySet<string>;
  /** Flags that give the pattern, so every positional word is a root. */
  patternFlags: ReadonlySet<string>;
  /** Whether it reads a pattern as its first positional word. */
  patternFirst: boolean;
  /** Flags after which the rest of the words are a command it runs (`fd -x`). */
  stops?: ReadonlySet<string>;
}

const GREP: TreeSearch = {
  values: new Set([
    ...['-e', '-f', '-m', '-A', '-B', '-C', '-d', '-D', '--regexp', '--file', '--max-count'],
    ...['--context', '--after-context', '--before-context', '--directories', '--devices'],
    ...['--include', '--exclude', '--exclude-dir', '--exclude-from', '--label', '--binary-files'],
  ]),
  patternFlags: new Set(['-e', '-f', '--regexp', '--file']),
  patternFirst: true,
};

const RG: TreeSearch = {
  values: new Set([
    ...['-e', '-f', '-g', '-t', '-T', '-m', '-A', '-B', '-C', '-j', '-d', '-E', '-M', '-r'],
    ...['--regexp', '--file', '--glob', '--iglob', '--type', '--type-not', '--type-add'],
    ...['--max-count', '--context', '--after-context', '--before-context', '--threads'],
    ...['--max-depth', '--encoding', '--max-columns', '--replace', '--ignore-file', '--sort'],
    ...['--sortr', '--pre', '--pre-glob', '--max-filesize', '--path-separator', '--color'],
    '--colors',
  ]),
  patternFlags: new Set(['-e', '-f', '--regexp', '--file', '--files', '--type-list']),
  patternFirst: true,
};

const AG: TreeSearch = {
  values: new Set([
    '-A',
    '-B',
    '-C',
    '-G',
    '-g',
    '-m',
    '-p',
    '--ignore',
    '--depth',
    '--path-to-ignore',
  ]),
  patternFlags: new Set(['-g']),
  patternFirst: true,
};

const ACK: TreeSearch = {
  values: new Set([
    '-A',
    '-B',
    '-C',
    '-m',
    '-g',
    '--match',
    '--type',
    '--ignore-dir',
    '--noignore-dir',
  ]),
  patternFlags: new Set(['-g', '--match', '-f']),
  patternFirst: true,
};

const FD: TreeSearch = {
  values: new Set([
    ...['-e', '-t', '-E', '-d', '-j', '-S', '-o', '-c', '--extension', '--type', '--exclude'],
    ...['--max-depth', '--min-depth', '--exact-depth', '--changed-within', '--changed-before'],
    ...['--owner', '--color', '--ignore-file', '--max-results', '--format', '--threads', '--size'],
  ]),
  patternFlags: new Set(),
  patternFirst: true,
  stops: new Set(['-x', '-X', '--exec', '--exec-batch']),
};

/** Programs that search a folder tree; `grep` and its kin only when asked to. */
const TREE_SEARCHES: Readonly<Record<string, TreeSearch>> = {
  rg: RG,
  ag: AG,
  ack: ACK,
  rgrep: GREP,
  fd: FD,
  fdfind: FD,
};
/** `grep` and its kin search a tree only when asked to. */
const GREPS: ReadonlySet<string> = new Set(['grep', 'egrep', 'fgrep']);
/** Searches that leave hidden folders out unless a flag says otherwise. */
const SKIPS_HIDDEN: ReadonlySet<string> = new Set(['rg', 'ag', 'fd', 'fdfind']);
/** The flags that make one of them search hidden folders too. */
const SEES_HIDDEN = /^(-[A-Za-z.]*[u.aH][A-Za-z.]*|--hidden|--all-types|--unrestricted)$/;
/** The flags that make `rg` read past its ignore files. */
const RG_NO_IGNORE = /^(-[A-Za-z.]*u[A-Za-z.]*|--no-ignore|--no-ignore-dot|--unrestricted)$/;
/** `rg`'s flags that take a glob as their next word. */
const RG_GLOB_FLAGS: ReadonlySet<string> = new Set(['-g', '--glob', '--iglob']);
/** `find`'s own flags before its folders, GNU's and BSD's. */
const FIND_LEADING = /^-[HLPEXdsx]+$|^-O\d*$/;
/** The flags that make a search follow links, per program. */
const FOLLOWS_LINKS: Readonly<Record<string, RegExp>> = {
  grep: /^(-[A-Za-z]*R[A-Za-z]*|--dereference-recursive)$/,
  rg: /^(-[A-Za-z]*L[A-Za-z]*|--follow)$/,
  fd: /^(-[A-Za-z]*L[A-Za-z]*|--follow)$/,
  ag: /^(-[A-Za-z]*f[A-Za-z]*|--follow)$/,
  ack: /^--follow$/,
  find: /^(-[HLPEXdsx]*L[HLPEXdsx]*|-follow)$/,
};

/** Whether a `grep` is asked to search a tree: `-r`, `-R`, `--recursive`, `-d recurse`. */
function grepRecurses(args: readonly string[]): boolean {
  return args.some(
    (arg, at) =>
      /^-[A-Za-z]*[rR]/.test(arg) ||
      /^--(?:dereference-)?recursive$/.test(arg) ||
      /^(?:-d|--directories=?)recurse$/.test(arg) ||
      ((arg === '-d' || arg === '--directories') && args[at + 1] === 'recurse')
  );
}

/** Where `find` starts: the words before its first test, else where it stands. */
function findRoots(args: readonly string[]): string[] {
  const roots: string[] = [];
  let at = 0;
  for (; at < args.length; at += 1) {
    const arg = args[at]!;
    if (arg === '-D') at += 1;
    else if (arg === '-f') {
      // BSD's `find -f <folder>`: a root that may start with a dash.
      if (args[at + 1] !== undefined) roots.push(args[at + 1]!);
      at += 1;
    } else if (!FIND_LEADING.test(arg)) break;
  }
  for (; at < args.length && !/^[-(!,]/.test(args[at]!); at += 1) roots.push(args[at]!);
  return roots.length > 0 ? roots : ['.'];
}

/** Where any other search starts: its positional words past its pattern, else where it stands. */
function searchRoots(search: TreeSearch, args: readonly string[]): string[] {
  const words: string[] = [];
  let patternGiven = false;
  for (let at = 0; at < args.length; at += 1) {
    const arg = args[at]!;
    const flag = arg.split('=', 1)[0]!;
    if (search.stops?.has(arg)) break;
    if (search.patternFlags.has(flag)) patternGiven = true;
    if (arg === '--') {
      words.push(...args.slice(at + 1));
      break;
    }
    if (search.values.has(arg)) at += 1;
    else if (!arg.startsWith('-')) words.push(arg);
  }
  const roots = search.patternFirst && !patternGiven ? words.slice(1) : words;
  return roots.length > 0 ? roots : ['.'];
}

/** The values `rg` is given for its glob flags. */
function rgGlobs(args: readonly string[]): string[] {
  const globs: string[] = [];
  for (let at = 0; at < args.length; at += 1) {
    const arg = args[at]!;
    if (RG_GLOB_FLAGS.has(arg) && args[at + 1] !== undefined) globs.push(args[at + 1]!);
    const joined = /^--i?glob=(.*)$/s.exec(arg)?.[1];
    if (joined !== undefined) globs.push(joined);
  }
  return globs;
}

/**
 * Whether `rg` keeps its ignore files in force: no flag reads past them, every glob leaves them
 * in force, and no config file it would read could change that.
 */
function rgKeepsIgnores(args: readonly string[], ripgrepConfig: boolean): boolean {
  if (args.some((arg) => RG_NO_IGNORE.test(arg))) return false;
  if (ripgrepConfig && !args.includes('--no-config')) return false;
  return globsKeepIgnores(rgGlobs(args));
}

/** How one command line's paths are read and tested. */
export interface SearchReading {
  /** Whether the line or the server's environment names a ripgrep config file. */
  ripgrepConfig: boolean;
  /** The absolute paths a word could name, one per folder the command stands in; `null` marks. */
  pathsOf: (word: string) => string[] | null;
  /** The command line's tests. */
  tests: OutsideFileTests;
}

/**
 * Whether one command is a recursive search starting at or above a folder of outside files.
 *
 * @param segment - The command.
 * @param reading - How its words are read and its paths tested.
 */
export function searchesOutsideFiles(segment: ShellSegment, reading: SearchReading): boolean {
  const { verb, args } = commandOf(segment);
  const grep = GREPS.has(verb) && grepRecurses(args);
  const search = TREE_SEARCHES[verb] ?? (grep ? GREP : undefined);
  if (verb !== 'find' && !search) return false;
  const roots = search ? searchRoots(search, args) : findRoots(args);
  const program = GREPS.has(verb) || verb === 'rgrep' ? 'grep' : verb === 'fdfind' ? 'fd' : verb;
  const walk: SearchWalk = {
    skipsHidden: SKIPS_HIDDEN.has(verb) && !args.some((arg) => SEES_HIDDEN.test(arg)),
    ignoreFiles: verb === 'rg' && rgKeepsIgnores(args, reading.ripgrepConfig),
  };
  const follows = args.some((arg) => FOLLOWS_LINKS[program]?.test(arg));
  return roots.some((root) => {
    const named = reading.pathsOf(root);
    if (named === null) return true;
    return named.some((absolute) => {
      if (hasWildcard(absolute)) return reading.tests.patternReaches(absolute, true, walk);
      return (
        reading.tests.rootReaches(absolute, walk) || (follows && reading.tests.linksReach(absolute))
      );
    });
  });
}
