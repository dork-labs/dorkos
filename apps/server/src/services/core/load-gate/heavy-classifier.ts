/**
 * Which shell commands are heavy enough to wait behind the load gate (DOR-4209).
 *
 * It reads a command with the shell guard's own parser ({@link parseShell},
 * {@link withNested}, {@link commandOf}), so it sees through `env`, `nice`,
 * `timeout`, `sudo`, `sh -c` and `$(…)` exactly as the guard does. A caller
 * that already parsed the command hands the segments to {@link classifySegments},
 * so both read one parse.
 *
 * A command is heavy when any of its commands is: `tsc`; `vitest` or `jest`
 * given anything but exactly one test file (a `.test.` or `.spec.` name; a
 * folder is a suite); `playwright test`; an install, build, verify, test,
 * typecheck or lint through `pnpm`, `npm`, `yarn` or `bun`, including through
 * `exec`, `dlx`, `npx` and package-manager flags such as `-C dir` or
 * `--filter x` (a package manager's `test` is heavy whatever it is handed,
 * because the root script fans out through turbo; `bun test` is bun's own runner
 * and follows the one-file rule); `turbo` running one of those tasks;
 * `vite build` and `next build`; `docker build`, `docker buildx build` and
 * compose builds; `git commit` and `git push`, which run hooks; `cargo build`,
 * `test` and friends; and `make`. Asking any of these for `--version` or
 * `--help` is not. Everything else is light.
 *
 * The reason given is the program's name alone ({@link jobLabel}), never its
 * arguments, because it is shown to other agents waiting in the same line.
 *
 * @module services/core/load-gate/heavy-classifier
 */
import path from 'node:path';
import { commandOf, withNested } from '../../runtimes/claude-code/shell-guard/shell-command.js';
import {
  parseShell,
  type ShellSegment,
} from '../../runtimes/claude-code/shell-guard/shell-words.js';
import { jobLabel } from './job-label.js';

/**
 * A person's changes to the built-in heavy list. Each pattern is a command name
 * and its leading words, separated by spaces (`pnpm docs:export-api`,
 * `storybook build`). It matches a command whose name and first words are those
 * words, read with prefixes like `env` and `nice` removed and also as the
 * program a runner starts (`npx storybook build` and `pnpm exec storybook build`
 * both match `storybook build`), and with a package manager's, git's or
 * docker's own flags before the subcommand dropped (`pnpm -C web build` matches
 * `pnpm build`). A `remove` match makes that command light, whatever the
 * built-in list or `add` say; an `add` match makes it heavy.
 */
export interface HeavyCommandOverrides {
  /** Patterns to treat as heavy. */
  add: readonly string[];
  /** Patterns to treat as light. Wins over `add` and the built-in list. */
  remove: readonly string[];
}

/** Whether a command waits behind the gate, and the program that makes it heavy. */
export interface Classification {
  /** Whether it is heavy. */
  heavy: boolean;
  /** The heavy program's name alone, such as `pnpm` or `tsc`. Present when heavy. */
  reason?: string;
}

type Words = readonly string[];

const NO_OVERRIDES: HeavyCommandOverrides = { add: [], remove: [] };
const EMPTY: ReadonlySet<string> = new Set();
/** How many runners deep (`npx pnpm exec …`) a command is followed. */
const MAX_UNWRAP_DEPTH = 4;
/** Arguments that only ask a program about itself. */
const HELP_WORDS = new Set(['--version', '-v', '-V', '--help', '-h', 'help', 'version']);

const PACKAGE_MANAGERS = new Set(['pnpm', 'npm', 'yarn', 'bun']);
const RUNNERS = new Set(['npx', 'pnpx', 'bunx']);
const RUNNER_VALUE_FLAGS = new Set(['-p', '--package']);
const INSTALL_SUBCOMMANDS = new Set([
  'install',
  'i',
  'ci',
  'add',
  'update',
  'up',
  'upgrade',
  'remove',
  'rm',
  'uninstall',
  'un',
  'rebuild',
  'dedupe',
  'it',
  'install-test',
  'cit',
  'install-ci-test',
]);
const TEST_SUBCOMMANDS = new Set(['test', 't']);
const EXEC_SUBCOMMANDS = new Set(['exec', 'dlx', 'x']);
const RUN_SUBCOMMANDS = new Set(['run', 'run-script']);
/** Script and turbo task names that are heavy, read before any `:` (`test:e2e`). */
const HEAVY_TASKS = new Set([
  'build',
  'verify',
  'test',
  'typecheck',
  'lint',
  'knip',
  'e2e',
  'smoke',
]);
/** Flags `vitest` and `jest` read a value after, so the value is not taken for a file. */
const TEST_VALUE_FLAGS = new Set([
  '--project',
  '--config',
  '-c',
  '--root',
  '-r',
  '--dir',
  '--reporter',
  '--reporters',
  '--environment',
  '--pool',
  '--shard',
  '--testNamePattern',
  '-t',
  '--testPathPattern',
  '--maxWorkers',
  '-w',
  '--minWorkers',
  '--outputFile',
  '--testTimeout',
  '--retry',
  '--mode',
  '--workspace',
  '--exclude',
  '--bail',
  '--selectProjects',
]);
const VITEST_SUBCOMMANDS = new Set(['run', 'watch', 'dev', 'related', 'bench']);
const GIT_HEAVY = new Set(['commit', 'push']);
const CARGO_HEAVY = new Set([
  'build',
  'b',
  'test',
  't',
  'check',
  'c',
  'clippy',
  'bench',
  'run',
  'r',
  'install',
]);

/** Each program's flags that take a value before its subcommand. */
const SUBCOMMAND_FLAGS = new Map<string, ReadonlySet<string>>([
  ['pnpm', new Set(['-C', '--dir', '--filter', '-F', '--filter-prod', '--reporter', '--loglevel'])],
  ['npm', new Set(['--prefix', '-w', '--workspace', '--loglevel'])],
  ['yarn', new Set(['--cwd'])],
  ['bun', new Set(['--cwd', '--filter', '-F'])],
  ['git', new Set(['-C', '-c', '--git-dir', '--work-tree', '--namespace', '--config-env'])],
  ['docker', new Set(['--context', '-c', '--host', '-H', '--config', '--log-level', '-l'])],
  [
    'docker-compose',
    new Set([
      '-f',
      '--file',
      '-p',
      '--project-name',
      '--profile',
      '--env-file',
      '--project-directory',
    ]),
  ],
  ['cargo', new Set(['-C', '--config', '-Z'])],
  [
    'turbo',
    new Set([
      '--filter',
      '-F',
      '--concurrency',
      '--output-logs',
      '--cache-dir',
      '--log-order',
      '--cwd',
    ]),
  ],
]);

/** A program's first word that is not a flag, and what follows it. */
function splitSub(args: Words, valueFlags: ReadonlySet<string>): { sub?: string; rest: Words } {
  let at = 0;
  while (at < args.length) {
    const word = args[at]!;
    if (word === '--') {
      at += 1;
      break;
    }
    if (!word.startsWith('-')) break;
    at += valueFlags.has(word) ? 2 : 1;
  }
  return at < args.length ? { sub: args[at]!, rest: args.slice(at + 1) } : { rest: [] };
}

/** The words that are neither flags nor a flag's value. */
function positionals(args: Words, valueFlags: ReadonlySet<string>): string[] {
  const found: string[] = [];
  for (let at = 0; at < args.length; at += 1) {
    const word = args[at]!;
    if (word === '--') continue;
    if (word.startsWith('-')) {
      if (valueFlags.has(word)) at += 1;
      continue;
    }
    found.push(word);
  }
  return found;
}

const taskBase = (name: string): string => name.split('#').pop()!.split(':')[0]!;

/** A word that names one test file rather than a folder or a filter. */
const TEST_FILE = /\.(test|spec)\./;

/**
 * One test file is a quick check. No argument, two or more, or one that is a
 * folder or a name filter (`vitest run apps/server`) is a suite.
 */
function testFilesAreHeavy(args: Words, subcommands: ReadonlySet<string>): boolean {
  const files = positionals(args, TEST_VALUE_FLAGS);
  if (subcommands.has(files[0] ?? '')) files.shift();
  return !(files.length === 1 && TEST_FILE.test(files[0]!));
}

function packageManagerIsHeavy(verb: string, args: Words): boolean {
  const { sub, rest } = splitSub(args, SUBCOMMAND_FLAGS.get(verb) ?? EMPTY);
  // A bare `yarn` installs; a bare `pnpm`, `npm` or `bun` prints help.
  if (sub === undefined) return verb === 'yarn';
  if (INSTALL_SUBCOMMANDS.has(sub)) return true;
  // `bun test` is bun's own test runner. Everyone else's `test` is the package's
  // test script, which at the root fans out across every package through turbo,
  // whatever it is handed; run one file with `pnpm vitest run <file>` instead.
  if (TEST_SUBCOMMANDS.has(sub)) return verb === 'bun' ? testFilesAreHeavy(rest, EMPTY) : true;
  return HEAVY_TASKS.has(taskBase(sub));
}

function turboIsHeavy(args: Words): boolean {
  const tasks = positionals(args, SUBCOMMAND_FLAGS.get('turbo')!);
  if (tasks[0] === 'run') tasks.shift();
  return tasks.some((task) => HEAVY_TASKS.has(taskBase(task)));
}

function composeIsHeavy(args: Words): boolean {
  const { sub, rest } = splitSub(args, SUBCOMMAND_FLAGS.get('docker-compose')!);
  return sub === 'build' || (sub === 'up' && rest.includes('--build'));
}

function dockerIsHeavy(args: Words): boolean {
  const { sub, rest } = splitSub(args, SUBCOMMAND_FLAGS.get('docker')!);
  if (sub === 'build') return true;
  if (sub === 'compose') return composeIsHeavy(rest);
  if (sub === 'buildx' || sub === 'image' || sub === 'builder') {
    const next = splitSub(rest, EMPTY).sub;
    return next === 'build' || next === 'bake';
  }
  return false;
}

function cargoIsHeavy(args: Words): boolean {
  // `cargo +nightly test`: the toolchain comes before the subcommand.
  const words = args[0]?.startsWith('+') ? args.slice(1) : args;
  return CARGO_HEAVY.has(splitSub(words, SUBCOMMAND_FLAGS.get('cargo')!).sub ?? '');
}

/** The built-in list, one rule per program. A Map, so a name like `constructor` finds nothing. */
const BUILT_IN = new Map<string, (verb: string, args: Words) => boolean>([
  ['tsc', () => true],
  ['vitest', (_verb, args) => testFilesAreHeavy(args, VITEST_SUBCOMMANDS)],
  ['jest', (_verb, args) => testFilesAreHeavy(args, EMPTY)],
  // Browser tests: every file starts browsers, so even one is heavy.
  ['playwright', (_verb, args) => splitSub(args, EMPTY).sub === 'test'],
  ['pnpm', packageManagerIsHeavy],
  ['npm', packageManagerIsHeavy],
  ['yarn', packageManagerIsHeavy],
  ['bun', packageManagerIsHeavy],
  ['turbo', (_verb, args) => turboIsHeavy(args)],
  ['vite', (_verb, args) => splitSub(args, EMPTY).sub === 'build'],
  ['next', (_verb, args) => splitSub(args, EMPTY).sub === 'build'],
  ['docker', (_verb, args) => dockerIsHeavy(args)],
  ['docker-compose', (_verb, args) => composeIsHeavy(args)],
  ['git', (_verb, args) => GIT_HEAVY.has(splitSub(args, SUBCOMMAND_FLAGS.get('git')!).sub ?? '')],
  ['cargo', (_verb, args) => cargoIsHeavy(args)],
  ['make', () => true],
  ['gmake', () => true],
]);

function builtInIsHeavy(view: Words): boolean {
  const [verb = '', ...args] = view;
  if (args.length > 0 && args.every((arg) => HELP_WORDS.has(arg))) return false;
  return BUILT_IN.get(verb)?.(verb, args) ?? false;
}

/**
 * Other ways to read one command: `same` names the same program with its own
 * leading flags dropped; `inner` is a program it starts, read again in turn.
 */
function unwrap(words: Words): { same: Words[]; inner: Words[] } {
  const [verb = '', ...args] = words;
  if (RUNNERS.has(verb)) return { same: [], inner: subcommandWords(args, RUNNER_VALUE_FLAGS) };
  if (verb === 'corepack') return { same: [], inner: args.length > 0 ? [args] : [] };
  const flags = SUBCOMMAND_FLAGS.get(verb);
  if (flags === undefined) return { same: [], inner: [] };
  const { sub, rest } = splitSub(args, flags);
  if (sub === undefined) return { same: [], inner: [] };
  const same: Words[] = [[verb, sub, ...rest]];
  if (!PACKAGE_MANAGERS.has(verb)) return { same, inner: [] };
  return { same, inner: packageInner(verb, sub, rest) };
}

function subcommandWords(args: Words, flags: ReadonlySet<string>): Words[] {
  const { sub, rest } = splitSub(args, flags);
  return sub === undefined ? [] : [[sub, ...rest]];
}

/** What a package manager runs: an `exec` program, a `run` script, or a package's own binary. */
function packageInner(verb: string, sub: string, rest: Words): Words[] {
  if (EXEC_SUBCOMMANDS.has(sub)) return subcommandWords(rest, RUNNER_VALUE_FLAGS);
  // `pnpm run build` is the script; `bun run file.ts` may be a program.
  if (RUN_SUBCOMMANDS.has(sub)) return rest[0] === undefined ? [] : [[verb, ...rest], rest];
  if (verb === 'yarn' && sub === 'workspace')
    return rest.length > 1 ? [[verb, ...rest.slice(1)]] : [];
  if (INSTALL_SUBCOMMANDS.has(sub) || TEST_SUBCOMMANDS.has(sub)) return [];
  return [[sub, ...rest]];
}

/** Every reading of one command, outermost first, each named by its program's base name. */
function viewsOf(words: Words, depth = 0): Words[] {
  if (words.length === 0) return [];
  const named: Words = [path.basename(words[0]!), ...words.slice(1)];
  const { same, inner } = unwrap(named);
  const views = [named, ...same];
  if (depth < MAX_UNWRAP_DEPTH) for (const next of inner) views.push(...viewsOf(next, depth + 1));
  return views;
}

function matchesPattern(view: Words, pattern: string): boolean {
  const words = pattern.trim().split(/\s+/).filter(Boolean);
  if (words.length === 0 || words.length > view.length) return false;
  return words.every((word, i) => (i === 0 ? path.basename(word) === view[0] : view[i] === word));
}

/** The heavy program's label for one command, or `null` when it is light. */
function classifyWords(words: Words, overrides: HeavyCommandOverrides): string | null {
  const views = viewsOf(words);
  const has = (patterns: readonly string[], view: Words): boolean =>
    patterns.some((pattern) => matchesPattern(view, pattern));
  if (views.some((view) => has(overrides.remove, view))) return null;
  const added = views.find((view) => has(overrides.add, view));
  if (added) return jobLabel(added[0]!);
  const builtIn = views.find(builtInIsHeavy);
  return builtIn ? jobLabel(builtIn[0]!) : null;
}

/**
 * Classify commands already split by {@link parseShell}. What they run through a
 * shell, `eval` or `$(…)` is read too; segments that already include it (from
 * `readCommand`) are fine, since reading one twice changes nothing.
 *
 * @param segments - The parsed commands.
 * @param overrides - A person's additions to and removals from the built-in list.
 */
export function classifySegments(
  segments: readonly ShellSegment[],
  overrides: HeavyCommandOverrides = NO_OVERRIDES
): Classification {
  for (const segment of withNested([...segments])) {
    const { verb, args } = commandOf(segment);
    if (verb === '') continue;
    const reason = classifyWords([verb, ...args], overrides);
    if (reason !== null) return { heavy: true, reason };
  }
  return { heavy: false };
}

/**
 * Classify one shell command line. Never throws.
 *
 * @param command - The command line, as an agent's shell tool would run it.
 * @param overrides - A person's additions to and removals from the built-in list.
 */
export function classifyCommand(
  command: string,
  overrides: HeavyCommandOverrides = NO_OVERRIDES
): Classification {
  return classifySegments(parseShell(command), overrides);
}
