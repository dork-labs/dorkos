/**
 * The commands a project script runs (DOR-5261): `pnpm run lint`, `npm test`, `yarn build` read
 * the script from `package.json` where they stand (with its `pre` and `post` scripts), and `make`
 * reads the target's recipe lines, and its direct prerequisites', from the Makefile. The text is
 * then judged as a command line of its own, at one level: the commands in the script.
 *
 * A file past the line's allowance of files, over {@link MAX_SCRIPT_BYTES}, a pipe or a device
 * marks, as does a recipe whose variables open past that size. Make's variables set in the file
 * are put in; one still unknown as a recipe's program could be any program, so it reads as one
 * (`$NAME`), and `$(shell …)` reads as the command it runs.
 *
 * @module services/runtimes/shared/tools/project-scripts
 */
import path from 'node:path';
import { commandOf, pathExists } from '../../claude-code/shell-guard/shell-command.js';
import type { ShellSegment } from '../../claude-code/shell-guard/shell-words.js';
import { MAX_SCRIPT_BYTES, readScript, type ScriptFileBudget } from './shell-script-files.js';

/** A project script found for a command: its text, and the folder it runs in. */
export interface ProjectScript {
  /** The commands, one per line. */
  text: string;
  /** Where they run. */
  cwd: string;
}

/** The package managers whose `run` reads `package.json`. */
const PACKAGE_MANAGERS: ReadonlySet<string> = new Set(['npm', 'pnpm', 'yarn', 'bun']);
/** Their words that run a script by name. */
const RUN_WORDS: ReadonlySet<string> = new Set(['run', 'run-script', 'rum', 'urn']);
/** npm's own commands that run the script of the same name. */
const NPM_SCRIPT_COMMANDS: Readonly<Record<string, string>> = {
  test: 'test',
  t: 'test',
  tst: 'test',
  start: 'start',
  stop: 'stop',
  restart: 'restart',
};
/** Flags naming the folder a package manager runs in. */
const FOLDER_FLAGS: ReadonlySet<string> = new Set(['-C', '--dir', '--prefix', '--cwd']);
/** Flags that run a script across packages: such a command is judged by its own words. */
const OTHER_PACKAGES = /^(?:-r|--recursive|-F|--filter|-w|--workspace|--workspaces)(?:=|$)/;

/** Each package manager's own commands, which run no script of the project's by that name. */
const BUILTINS: Readonly<Record<string, ReadonlySet<string>>> = {
  pnpm: new Set([
    ...['install', 'i', 'add', 'remove', 'rm', 'uninstall', 'update', 'up', 'exec', 'dlx', 'why'],
    ...['list', 'ls', 'outdated', 'audit', 'store', 'config', 'init', 'create', 'link', 'unlink'],
    ...['prune', 'rebuild', 'publish', 'pack', 'patch', 'root', 'bin', 'import', 'fetch'],
    ...['dedupe', 'deploy', 'env', 'setup', 'licenses', 'server', 'approve-builds', 'help'],
  ]),
  yarn: new Set([
    ...['install', 'add', 'remove', 'up', 'upgrade', 'exec', 'dlx', 'why', 'explain', 'list'],
    ...['outdated', 'audit', 'cache', 'config', 'init', 'create', 'link', 'unlink', 'pack'],
    ...['patch', 'bin', 'import', 'dedupe', 'node', 'npm', 'plugin', 'rebuild', 'set', 'unplug'],
    ...['version', 'workspace', 'workspaces', 'constraints', 'info', 'login', 'logout', 'help'],
    ...['global', 'licenses', 'owner', 'publish', 'tag', 'team', 'check', 'autoclean'],
  ]),
  bun: new Set([
    ...['install', 'i', 'add', 'remove', 'rm', 'update', 'upgrade', 'link', 'unlink', 'pm'],
    ...['init', 'create', 'x', 'build', 'test', 'publish', 'outdated', 'patch', 'audit', 'info'],
    ...['why', 'repl', 'exec', 'help'],
  ]),
};

/** A script that could not be read: it could run anything, so it reads as an unknown program. */
const UNREAD = '$UNREAD';

/**
 * A text file's contents: `none` when nothing is there, `unread` when it cannot be read (the
 * line's allowance is spent, or it is over {@link MAX_SCRIPT_BYTES}, a pipe or a device).
 */
function readText(file: string, budget: ScriptFileBudget): string | 'none' | 'unread' {
  if (budget.files <= 0) return 'unread';
  budget.files -= 1;
  const read = readScript(file);
  if (read.kind === 'none') return 'none';
  return read.kind === 'text' && read.text.length <= MAX_SCRIPT_BYTES ? read.text : 'unread';
}

/** The folder a flag names, or where the command stands. */
function folderOf(
  args: readonly string[],
  flags: ReadonlySet<string>,
  cwd: string,
  pathOf: (word: string) => string | null
): string | null {
  for (let at = 0; at < args.length; at += 1) {
    const [flag, value] = args[at]!.split(/=(.*)/s, 2) as [string, string | undefined];
    if (!flags.has(flag)) continue;
    const named = value ?? args[at + 1];
    return named === undefined ? null : pathOf(named);
  }
  return cwd;
}

/** The script a package manager runs from `package.json`, with its `pre` and `post` scripts. */
function packageScript(
  verb: string,
  args: readonly string[],
  cwd: string,
  pathOf: (word: string) => string | null,
  budget: ScriptFileBudget
): ProjectScript | undefined {
  if (args.some((arg) => OTHER_PACKAGES.test(arg))) return undefined;
  const positionals = args.filter(
    (arg, at) => !arg.startsWith('-') && !FOLDER_FLAGS.has(args[at - 1] ?? '')
  );
  const [first, second] = positionals;
  if (first === undefined || BUILTINS[verb]?.has(first)) return undefined;
  if (verb === 'npm' && !RUN_WORDS.has(first) && NPM_SCRIPT_COMMANDS[first] === undefined) {
    return undefined;
  }
  const folder = folderOf(args, FOLDER_FLAGS, cwd, pathOf);
  if (folder === null) return { text: UNREAD, cwd };
  const text = readText(path.join(folder, 'package.json'), budget);
  if (text === 'none') return undefined;
  if (text === 'unread') return { text: UNREAD, cwd: folder };
  let scripts: Record<string, unknown>;
  try {
    scripts = (JSON.parse(text) as { scripts?: Record<string, unknown> }).scripts ?? {};
  } catch {
    return undefined;
  }
  const byRun = RUN_WORDS.has(first);
  const name = byRun
    ? second
    : verb === 'npm'
      ? NPM_SCRIPT_COMMANDS[first]
      : Object.hasOwn(scripts, first)
        ? first
        : undefined;
  const main = name === undefined ? undefined : scripts[name];
  if (name === undefined || typeof main !== 'string') return undefined;
  // What follows the name is handed to the script.
  const extra = args.slice(args.indexOf(byRun ? name : first) + 1).filter((arg) => arg !== '--');
  const around = [scripts[`pre${name}`], scripts[`post${name}`]];
  const [pre, post] = around.map((line) => (typeof line === 'string' ? [line] : []));
  return { text: [...pre!, [main, ...extra].join(' '), ...post!].join('\n'), cwd: folder };
}

/** Make's flags that take the next word as their value. */
const MAKE_VALUES: ReadonlySet<string> = new Set([
  ...['-C', '-f', '-I', '-o', '-W', '--directory', '--file', '--makefile', '--include-dir'],
  ...['--old-file', '--what-if', '--assume-old', '--assume-new', '--new-file'],
]);
/** Make's names for its file, in the order it looks for them. */
const MAKEFILES = ['GNUmakefile', 'makefile', 'Makefile'];
/** Make's own variables, as a recipe sees them by default. */
const MAKE_DEFAULTS: Readonly<Record<string, string>> = {
  MAKE: 'make',
  CC: 'cc',
  CXX: 'c++',
  CPP: 'cc -E',
  AR: 'ar',
  AS: 'as',
  LD: 'ld',
  RM: 'rm -f',
  INSTALL: 'install',
  SHELL: '/bin/sh',
};

/** One rule of a Makefile: what it needs first, and its recipe lines. */
interface MakeRule {
  prerequisites: string[];
  recipe: string[];
}

/** A Makefile read as rules and variables. */
interface Makefile {
  /** Each target's rules (a target may have several). */
  rules: Map<string, MakeRule[]>;
  /** The default target: the first that does not start with a dot. */
  first: string | undefined;
  vars: Record<string, string>;
}

/** A variable set in a Makefile: `NAME = value`, `:=`, `?=`, `+=`, `export NAME = value`. */
const MAKE_ASSIGNMENT = /^(?:export\s+)?([A-Za-z_][\w.-]*)\s*([:+?!]?:?=)\s*(.*)$/;

/** A rule's first line read as its targets, prerequisites and inline recipe, or `undefined`. */
function ruleLine(line: string): { targets: string[]; rule: MakeRule } | undefined {
  const colon = line.indexOf(':');
  if (colon <= 0 || line[colon + 1] === '=') return undefined;
  const head = line.slice(0, colon);
  if (/[=#]/.test(head) || /^\s/.test(line)) return undefined;
  const after = line.slice(line[colon + 1] === ':' ? colon + 2 : colon + 1);
  const semicolon = after.indexOf(';');
  const needs = (semicolon === -1 ? after : after.slice(0, semicolon)).split('#', 1)[0]!;
  const inline = semicolon === -1 ? '' : after.slice(semicolon + 1).trim();
  return {
    targets: head.trim().split(/\s+/),
    rule: { prerequisites: needs.split(/\s+/).filter(Boolean), recipe: inline ? [inline] : [] },
  };
}

/** A Makefile's rules and variables, in one pass over its lines. */
function readMakefile(text: string): Makefile {
  const rules: Makefile['rules'] = new Map();
  const vars: Record<string, string> = { ...MAKE_DEFAULTS };
  let first: string | undefined;
  let current: string[] | undefined;
  for (const line of text.replace(/\\\r?\n/g, ' ').split(/\r?\n/)) {
    if (line.startsWith('\t')) {
      current?.push(line.slice(1));
      continue;
    }
    if (/^\s*(?:#|$)/.test(line)) continue;
    current = undefined;
    const assigned = MAKE_ASSIGNMENT.exec(line);
    if (assigned) {
      const [, name, operator, value] = assigned as unknown as [string, string, string, string];
      if (operator === '+=') vars[name] = `${vars[name] ?? ''} ${value}`.trim();
      else if (operator !== '?=' || vars[name] === undefined) vars[name] = value;
      continue;
    }
    const read = ruleLine(line);
    if (!read) continue;
    for (const target of read.targets) {
      rules.set(target, [...(rules.get(target) ?? []), read.rule]);
      if (first === undefined && !target.startsWith('.')) first = target;
    }
    current = read.rule.recipe;
  }
  return { rules, first, vars };
}

/** What one `make` call's recipe text may still grow by, spent as variables are put in. */
interface RecipeRoom {
  bytes: number;
}

/**
 * A recipe line as the shell gets it: make's variables put in, its `@`, `-` and `+` dropped.
 * What the variables add is counted before it is built, and past the room the line reads as
 * {@link UNREAD}.
 */
function recipeLine(
  line: string,
  target: string,
  vars: Readonly<Record<string, string>>,
  room: RecipeRoom
): string {
  const spend = (value: string): string | undefined => {
    room.bytes -= value.length;
    return room.bytes < 0 ? undefined : value;
  };
  // `$$` is the shell's own `$`, set aside while make's are read.
  let text = line
    .replace(/^[\s@+-]+/, '')
    .replace(/\$\$/g, '\0')
    .replace(/\$\(shell\s/g, '$(');
  // Twice, so a variable set from another is put in; a third level stays as written.
  for (let round = 0; round < 2; round += 1) {
    text = text.replace(/\$[({]([A-Za-z_][\w.-]*)[)}]/g, (whole, name: string) =>
      room.bytes < 0 || !Object.hasOwn(vars, name) ? whole : (spend(vars[name]!) ?? whole)
    );
    // Grown past what is read: it could run anything.
    if (room.bytes < 0) return UNREAD;
  }
  text = text
    .replace(/\$[({]([A-Za-z_][\w.-]*)[)}]/g, (_, name: string) => `$${name.replace(/\W/g, '_')}`)
    .replace(/\$@/g, () => (room.bytes < 0 ? '' : (spend(target) ?? '')))
    .replace(/\$[<^?*+|]/g, '')
    .replace(/\0/g, '$');
  return room.bytes < 0 ? UNREAD : text;
}

/** The recipe lines `make` runs for the targets named, and for their direct prerequisites. */
function makeScript(
  args: readonly string[],
  cwd: string,
  pathOf: (word: string) => string | null,
  budget: ScriptFileBudget
): ProjectScript | undefined {
  const folder = folderOf(args, new Set(['-C', '--directory']), cwd, pathOf);
  if (folder === null) return { text: UNREAD, cwd };
  const named =
    args.find((_, at) => ['-f', '--file', '--makefile'].includes(args[at - 1] ?? '')) ??
    args.find((arg) => /^--(?:file|makefile)=/.test(arg))?.split('=', 2)[1];
  const file =
    named !== undefined
      ? pathOf(named)
      : MAKEFILES.map((name) => path.join(folder, name)).find(pathExists);
  if (file === null) return { text: UNREAD, cwd: folder };
  if (file === undefined) return undefined;
  // One read: the file make would use.
  const text = readText(file, budget);
  if (text === 'none') return undefined;
  if (text === 'unread') return { text: UNREAD, cwd: folder };
  const makefile = readMakefile(text);
  const targets = args.filter(
    (arg, at) =>
      !arg.startsWith('-') &&
      !arg.includes('=') &&
      !MAKE_VALUES.has(args[at - 1] ?? '') &&
      !(args[at - 1] === '-j' && /^\d+$/.test(arg))
  );
  const asked = targets.length > 0 ? targets : makefile.first ? [makefile.first] : [];
  const vars = { ...makefile.vars };
  for (const arg of args) {
    const set = /^([A-Za-z_][\w.-]*)=(.*)$/s.exec(arg);
    if (set) vars[set[1]!] = set[2]!;
  }
  const lines: string[] = [];
  const room: RecipeRoom = { bytes: MAX_SCRIPT_BYTES };
  const recipeOf = (target: string): string[] =>
    (makefile.rules.get(target) ?? []).flatMap((rule) => rule.recipe);
  for (const target of asked) {
    const needs = (makefile.rules.get(target) ?? []).flatMap((rule) => rule.prerequisites);
    for (const run of [...needs, target]) {
      for (const line of recipeOf(run)) {
        // The line's own text counts against the room too.
        room.bytes -= line.length;
        const read = room.bytes < 0 ? UNREAD : recipeLine(line, run, vars, room);
        // Past what is read: it could run anything.
        if (read === UNREAD) return { text: UNREAD, cwd: folder };
        lines.push(read);
      }
    }
  }
  return lines.length > 0 ? { text: lines.join('\n'), cwd: folder } : undefined;
}

/**
 * The project script one command runs, when it runs one that can be read.
 *
 * @param segment - The command.
 * @param cwd - Where it stands.
 * @param pathOf - Turns a word into the absolute path it names, or `null`.
 * @param budget - The command line's allowance of files, spent here.
 */
export function projectScriptOf(
  segment: ShellSegment,
  cwd: string,
  pathOf: (word: string) => string | null,
  budget: ScriptFileBudget
): ProjectScript | undefined {
  const { verb, args } = commandOf(segment);
  if (PACKAGE_MANAGERS.has(verb)) return packageScript(verb, args, cwd, pathOf, budget);
  if (verb === 'make' || verb === 'gmake') return makeScript(args, cwd, pathOf, budget);
  return undefined;
}
