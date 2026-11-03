/**
 * The shell's route to protected files (DOR-3300, part 2 of DOR-3299).
 *
 * Claude Code runs read-only shell commands (`grep -r`, `rg -uu`, `head`, `sed -n`) without asking,
 * and before `canUseTool` is ever called. So this is a `PreToolUse` hook, and it does two things:
 *
 * - **Reads ask.** Below Full, a command that names a protected read path that exists, or searches
 *   a folder that holds one, goes to a person (`ask`), also when chained after an allowed command.
 *   At Never ask the CLI turns that `ask` into a refusal. At Full nothing changes: `cat` still
 *   reads, the stated limit of that level.
 * - **Setup writes are refused.** At every level, a command that plainly writes an agent's setup
 *   files (`AGENT_HOME_SELF_GRANT_PATHS` and the rest of its `.claude/`) is refused and audited,
 *   because the file-tool denies never covered the shell (DOR-3300, two cases on 2026-11-01). An
 *   agent a person opened its own folder to (`own-folder-open.ts`) may still write its own, except
 *   its `.dork/agent.json`. A script that only mentions such a file is not refused: a false refusal
 *   at Full has no way past it.
 *
 * **A mitigation, not a boundary.** This reads command text. A path built while the command runs
 * (`$(printf …)`, base64, a script file) gets through; `shell-path-guard.test.ts` records such
 * cases as the known limit. The real boundary is agents running as a separate OS user (DOR-3053).
 *
 * @module services/runtimes/claude-code/shell-guard/shell-path-guard
 */
import { readdirSync, statSync } from 'node:fs';
import { readdir } from 'node:fs/promises';
import path from 'node:path';
import type { HookCallback } from '@anthropic-ai/claude-agent-sdk';
import type { PermissionModeId } from '@dorkos/shared/schemas';
import {
  AGENT_HOME_SELF_GRANT_PATHS,
  PROTECTED_PATHS,
  type ProtectedPath,
} from '../../shared/policy/protected-paths.js';
import { chosenFullAutonomy, gatePermissionMode, type CeilingedMode } from '../turn-permission.js';
import { realLocation } from '../tool-gate/held-turn-reads.js';
import {
  commandOf,
  INTERPRETERS,
  pathExists,
  readCommand,
  scriptTexts,
  SHELLS,
} from './shell-command.js';
import type { ShellSegment } from './shell-words.js';

/** What the model is told when a shell read is put to a person. */
export const SHELL_READ_ASK_REASON =
  'This command reaches a protected file, so a person decides whether it runs.';

/** What the model is told when a shell write to setup files is refused. */
export const SHELL_WRITE_DENY_REASON =
  'An agent’s shell can’t change an agent’s setup files. Post the change for a person to apply.';

/** A command this long is not read at all: reads ask, and the write check is skipped. */
const MAX_COMMAND = 256 * 1024;
/** The most paths one command may name before it counts as unreadable. */
const MAX_CHECKED = 5_000;
/** A tree search looks at this many entries, for this long, before it counts as protected. */
const MAX_TREE_ENTRIES = 50_000;
const MAX_TREE_MS = 1_500;
/** Folders a tree search does not walk: packages and git objects, not an agent's secrets. */
const UNWALKED = new Set(['node_modules', '.git']);

/** Grep's recursive flags. */
const GREP_RECURSIVE =
  /^(-[A-Za-z]*[rR][A-Za-z]*|--recursive|--dereference-recursive|--directories=recurse)$/;
/** Commands that search a tree when asked to, and the flags that ask. */
const RECURSIVE_WHEN: Readonly<Record<string, RegExp>> = {
  grep: GREP_RECURSIVE,
  egrep: GREP_RECURSIVE,
  fgrep: GREP_RECURSIVE,
  find: /^-(exec|execdir|ok|okdir)$/,
  cp: /^(-[A-Za-z]*[rRa][A-Za-z]*|--recursive|--archive)$/,
  scp: /^-[A-Za-z]*r[A-Za-z]*$/,
};
/** Commands that always read a whole tree. */
const ALWAYS_RECURSIVE = new Set(['rg', 'ag', 'ack', 'tar', 'zip', 'rsync']);
/** Commands whose first operand is a pattern, and that search here when no folder is named. */
const SEARCHERS = new Set(['grep', 'egrep', 'fgrep', 'rg', 'ag', 'ack']);
/** Flags that say the pattern is not the first operand. */
const PATTERN_FLAG = /^(-[A-Za-z]*[ef]|--regexp(=.*)?|--file(=.*)?)$/;
/** `rg`, `ag` and `ack` skip hidden files unless a flag like one of these says otherwise. */
const SEES_HIDDEN = /^(-[A-Za-z.]*[u.a][A-Za-z.]*|--hidden|--all-types|--unrestricted)$/;

/** Commands that change every file they name. */
const WRITERS = new Set([
  'rm',
  'rmdir',
  'unlink',
  'shred',
  'tee',
  'touch',
  'ln',
  'mkdir',
  'chmod',
  'chown',
  'truncate',
]);
/** Commands that write only to their last operand, or to the folder a flag names. */
const COPIERS = new Set(['cp', 'rsync', 'install', 'scp']);
/** The flags that name where a command writes. */
const OUTPUT_FLAGS: Readonly<Record<string, readonly string[]>> = {
  cp: ['-t', '--target-directory'],
  tar: ['-C', '--directory'],
  unzip: ['-d'],
  curl: ['-o', '--output'],
  wget: ['-O', '--output-document'],
};
/** The `git` subcommands that rewrite files in the working tree. */
const GIT_WRITERS = new Set(['checkout', 'restore', 'mv', 'rm', 'apply', 'clean']);
/**
 * Calls in a script that write files. Without one, a named path is only a mention. Named narrowly:
 * a hard refusal has no way past it, and `.replace(` or `stdout.write(` writes no file.
 */
const SCRIPT_WRITES =
  /(?<!stdout|stderr)\.write\(|\b(write_text|write_bytes|writeFile\w*|appendFile\w*|copyFile\w*|unlink\w*|rename\w*|rmdir\w*|rmSync|rmtree|mkdir\w*|truncate\w*|symlink\w*|os\.remove|fs\.rm|shutil\.\w+)\b|\bopen\s*\([^)]*['"][rbt]*[wax+][rwaxbt+]*['"]/;
/** The tools that take a shell command. */
export const SHELL_TOOLS: ReadonlySet<string> = new Set(['Bash', 'Monitor', 'PowerShell']);

/** A path rule: a compiled test below a fixed folder. */
interface RootRule {
  base: string;
  test: RegExp;
  /** The part of the rule's path before any wildcard, for telling which trees can hold a match. */
  fixed: string;
}

/** The folders a launch's protected paths are measured from. */
export interface ShellGuardRoots {
  /** The turn's working folder. */
  cwd: string;
  /** DorkOS's data folder. */
  dorkHome: string;
  /** The person's home folder. */
  home: string;
  /** Every Claude Code account folder DorkOS knows of. */
  accounts: readonly string[];
  /** The variables the command's shell starts with. */
  env: Readonly<Record<string, string | undefined>>;
  /** Every registered agent's home, read per call so a new agent is covered. */
  agentHomes: () => readonly string[];
  /** The agent home a person opened to its own agent, whose setup it may change. */
  openHome?: string;
}

/** A shared path's name as a regex body: `*` stays inside one name. */
function nameBody(entry: Pick<ProtectedPath, 'path' | 'kind'>): string {
  const escaped = entry.path
    .split('*')
    .map((part) => part.replace(/[.+?^${}()|[\]\\]/g, '\\$&'))
    .join('[^/]*');
  return `${escaped}${entry.kind === 'folder' ? '(?:/.*)?' : ''}`;
}

/** The read entries named at any depth, wherever they sit, as one test. */
const ANY_DEPTH_READS = new RegExp(
  `(?:^|/)(?:${PROTECTED_PATHS.filter(
    (entry) => entry.deny === 'read' && (entry.root === 'anywhere' || entry.root === 'agent-folder')
  )
    .map(nameBody)
    .join('|')})$`,
  'i'
);

/** A folder's spellings: as given and where it really is. */
function spellings(folder: string): string[] {
  const resolved = path.resolve(folder);
  return [...new Set([resolved, realLocation(resolved)])];
}

/** Whether `child` is `parent` or below it. */
function within(parent: string, child: string): boolean {
  const relative = path.relative(parent, child);
  return relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

/** The read entries measured from a fixed folder, compiled for this launch. */
function fixedReadRules(roots: ShellGuardRoots): RootRule[] {
  return PROTECTED_PATHS.filter((entry) => entry.deny === 'read').flatMap((entry) => {
    const bases =
      entry.root === 'data'
        ? [roots.dorkHome]
        : entry.root === 'home'
          ? [roots.home]
          : entry.root === 'account'
            ? roots.accounts
            : [];
    const literal = entry.path.split('/').filter((part, i, all) => {
      return !all.slice(0, i + 1).some((one) => one.includes('*'));
    });
    return bases.flatMap(spellings).map((base) => ({
      base,
      test: new RegExp(`^${nameBody(entry)}$`, 'i'),
      fixed: path.join(base, ...literal),
    }));
  });
}

/** Whether `target` falls under a rule. */
function underRule(target: string, rule: RootRule): boolean {
  if (!within(rule.base, target)) return false;
  return rule.test.test(path.relative(rule.base, target));
}

/**
 * Whether a resolved path, as named or where it really is, is a protected read. A path that isn't
 * there can't be read: it is a pattern, a word in a message or a `jq` key, so nobody is asked.
 */
function isProtectedRead(target: string, rules: readonly RootRule[]): boolean {
  if (!pathExists(target)) return false;
  const named = (candidate: string): boolean =>
    ANY_DEPTH_READS.test(candidate) || rules.some((rule) => underRule(candidate, rule));
  return named(target) || named(realLocation(target));
}

/** Whether a word names a folder, as any spelling the command reaches. */
function isFolder(target: string): boolean {
  try {
    return statSync(target).isDirectory();
  } catch {
    return false;
  }
}

/**
 * Whether searching a tree reaches a protected read: a fixed one in it, a name at any depth, or a
 * link to one. Follows linked folders, as `grep -R` and `rg -L` do. Walks without blocking the
 * server, and a tree too big to finish counts as yes.
 */
async function treeReachesRead(
  folder: string,
  rules: readonly RootRule[],
  hidden: boolean
): Promise<boolean> {
  const inTree = rules.filter((rule) => within(folder, rule.fixed) || within(rule.fixed, folder));
  const deadline = Date.now() + MAX_TREE_MS;
  const pending = [folder];
  const seen = new Set<string>();
  let entries = 0;
  while (pending.length > 0) {
    if (Date.now() > deadline) return true;
    const current = pending.pop()!;
    const real = realLocation(current);
    if (seen.has(real)) continue;
    seen.add(real);
    let listed;
    try {
      listed = await readdir(current, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of listed) {
      if (!hidden && entry.name.startsWith('.')) continue;
      if (++entries > MAX_TREE_ENTRIES) return true;
      const full = path.join(current, entry.name);
      if (entry.isSymbolicLink()) {
        if (isProtectedRead(full, rules)) return true;
        if (isFolder(full) && !UNWALKED.has(entry.name)) pending.push(realLocation(full));
      } else if (ANY_DEPTH_READS.test(full) || inTree.some((rule) => underRule(full, rule))) {
        return true;
      } else if (entry.isDirectory() && !UNWALKED.has(entry.name)) {
        pending.push(full);
      }
    }
  }
  return false;
}

/** Whether a command searches a whole tree, given the line it is part of. */
function isRecursive(verb: string, args: readonly string[], line: string): boolean {
  if (ALWAYS_RECURSIVE.has(verb)) return true;
  // `find x | xargs cat` and `cat $(find x)`: find names the files, and the other command reads.
  if (verb === 'find' && /\bxargs\b|\$\(\s*find\b|`\s*find\b/.test(line)) return true;
  if (verb === 'git') return args.includes('grep') && args.includes('--no-index');
  if (args.some((arg) => RECURSIVE_WHEN[verb]?.test(arg))) return true;
  return SEARCHERS.has(verb) && args.some((arg, i) => arg === 'recurse' && args[i - 1] === '-d');
}

/** The words a command would search, leaving out a searcher's pattern. */
function searchedWords(verb: string, args: readonly string[]): string[] {
  const operands = args.filter((arg) => !arg.startsWith('-'));
  if (!SEARCHERS.has(verb)) return operands;
  return args.some((arg) => PATTERN_FLAG.test(arg)) ? operands : operands.slice(1);
}

/**
 * Whether a command reaches a protected read, by naming it or by searching a folder above it.
 * On any doubt the answer is yes: a person is asked.
 *
 * @param command - The command line.
 * @param roots - This launch's folders.
 */
export async function commandReachesProtectedRead(
  command: string,
  roots: ShellGuardRoots
): Promise<boolean> {
  if (command.length > MAX_COMMAND) return true;
  const rules = fixedReadRules(roots);
  const { segments, resolve } = readCommand(command, roots);
  const checked = new Set<string>();
  for (const { segment, cwd } of segments) {
    const { verb, args } = commandOf(segment);
    const scripted = INTERPRETERS.has(verb);
    // A word with spaces is a message or a script, or one path with spaces in it. Only a program
    // that runs it, or a `$(…)` inside it, makes its inner words paths: a commit message that
    // mentions `deploy.pem` reads nothing.
    const words: [string, boolean][] = [...segment.words, ...segment.redirects].map((word) => [
      word,
      scripted || !/\s/.test(word) || /\$\(|`/.test(word),
    ]);
    for (const script of scriptTexts(segment)) words.push([script, true]);
    for (const [word, pieces] of words) {
      const paths = resolve(word, { pieces });
      if (paths === null) return true;
      for (const target of paths) {
        if (checked.has(target)) continue;
        checked.add(target);
        if (checked.size > MAX_CHECKED) return true;
        if (isProtectedRead(target, rules)) return true;
      }
    }
    if (!isRecursive(verb, args, command)) continue;
    const skipsHidden = verb === 'rg' || verb === 'ag' || verb === 'ack';
    const hidden = !skipsHidden || args.some((arg) => SEES_HIDDEN.test(arg));
    const named = searchedWords(verb, args).flatMap(
      (word) => resolve(word, { pieces: false }) ?? []
    );
    const folders = named.filter(isFolder);
    // A searcher naming nothing that exists searches where it stands (`grep -r -A 1 x` has `1` for
    // a pattern as far as this can tell). Naming a real file means no tree.
    const here =
      (SEARCHERS.has(verb) && !named.some(pathExists)) || (verb === 'git' && folders.length === 0);
    for (const folder of here ? [cwd] : folders) {
      if (await treeReachesRead(realLocation(folder), rules, hidden)) return true;
    }
  }
  return false;
}

/** The setup paths below one agent home. */
const SETUP = new RegExp(
  `^(?:${[...AGENT_HOME_SELF_GRANT_PATHS, { path: '.claude', kind: 'folder' as const }]
    .map(nameBody)
    .join('|')})$`,
  'i'
);
/** What stays a person's even in a home opened to its own agent (`own-folder-open.ts`). */
const OPEN_HOME_KEEPS = /^\.dork\/agent\.json$/i;

/** A word a command writes to. */
interface WrittenWord {
  word: string;
  /** Whether it removes the whole folder it names, and so every home inside it. */
  whole: boolean;
  /** Whether to look inside the word, for a script's named paths. */
  pieces: boolean;
  /** For a copy or a move: what lands in the word, when it is a folder. */
  sources?: readonly string[];
}

/** The words of a `find` that would change files: its starting folders and what it looks for. */
function findTargets(args: readonly string[]): string[] {
  const execAt = args.findIndex((arg) => /^-(exec|execdir|ok|okdir)$/.test(arg));
  const execVerb = execAt === -1 ? '' : path.basename(args[execAt + 1] ?? '');
  if (!args.includes('-delete') && !WRITERS.has(execVerb) && !INTERPRETERS.has(execVerb)) return [];
  const firstFlag = args.findIndex((arg) => arg.startsWith('-'));
  const starts = args.slice(0, firstFlag === -1 ? args.length : firstFlag);
  const names = args.filter((_, i) => /^-i?name$/.test(args[i - 1] ?? ''));
  return [...starts, ...starts.flatMap((start) => names.map((name) => `${start}/${name}`))];
}

/** The words of a command that it would write to. */
function writtenWords(segment: ShellSegment, previous?: ShellSegment): WrittenWord[] {
  const { verb, args, viaXargs } = commandOf(segment);
  const plain = (word: string, whole = false): WrittenWord => ({ word, whole, pieces: false });
  const operands = args.filter((arg) => !arg.startsWith('-'));
  const recursive = args.some((arg) => /^(-[A-Za-z]*[rR][A-Za-z]*|--recursive)$/.test(arg));
  const written: WrittenWord[] = segment.redirects.map((word) => plain(word));
  if (WRITERS.has(verb)) {
    written.push(...operands.map((word) => plain(word, verb === 'rm' && recursive)));
    // `echo x | xargs rm`: the names come down the pipe.
    if (viaXargs && previous) written.push(...previous.words.map((word) => plain(word)));
  }
  if (COPIERS.has(verb) || verb === 'mv') {
    const last = operands.at(-1);
    if (last !== undefined) written.push({ ...plain(last), sources: operands.slice(0, -1) });
  }
  if (verb === 'mv') written.push(...operands.slice(0, -1).map((word) => plain(word)));
  if (verb === 'find') written.push(...findTargets(args).map((word) => plain(word)));
  const inPlace = /^(-[A-Za-z]*i[A-Za-z]*|--in-place(=.*)?)$/;
  if ((verb === 'sed' || verb === 'perl') && args.some((arg) => inPlace.test(arg))) {
    written.push(...operands.map((word) => plain(word)));
  }
  if (verb === 'dd') {
    for (const arg of args) if (arg.startsWith('of=')) written.push(plain(arg.slice(3)));
  }
  if (verb === 'patch') written.push(...operands.map((word) => plain(word)));
  if (verb === 'git') {
    const rest = args[0] === '-C' ? args.slice(2) : args;
    const sub = rest.find((arg, i) => !arg.startsWith('-') && !/^-c$/.test(rest[i - 1] ?? ''));
    const indexOnly =
      rest.some((arg) => /^(--staged|-S|--cached)$/.test(arg)) &&
      !rest.some((arg) => /^(--worktree|-W)$/.test(arg));
    if (sub !== undefined && GIT_WRITERS.has(sub) && !indexOnly) {
      written.push(...rest.filter((arg) => !arg.startsWith('-')).map((word) => plain(word)));
    }
  }
  const outputFlags = OUTPUT_FLAGS[verb] ?? [];
  args.forEach((arg, i) => {
    if (outputFlags.includes(args[i - 1] ?? '')) written.push(plain(arg));
    for (const flag of outputFlags) {
      if (arg.startsWith(`${flag}=`)) written.push(plain(arg.slice(flag.length + 1)));
    }
  });
  // A shell's script was already read as commands of its own, so only other programs' scripts.
  if (!SHELLS.has(verb)) {
    for (const script of scriptTexts(segment)) {
      if (SCRIPT_WRITES.test(script)) written.push({ word: script, whole: false, pieces: true });
    }
  }
  return written;
}

/** What a copy of `source` puts in a folder: its name, or for `dir/` and `dir/.` what it holds. */
function namesLanding(source: string, word: string): string[] {
  if (!word.endsWith('/') && !word.endsWith('/.')) return [path.basename(source)];
  try {
    return readdirSync(source);
  } catch {
    return [];
  }
}

/**
 * Whether a command plainly writes an agent's setup files. Reads and mentions don't count: `cat` of
 * one, a commit message naming one, or a script that only opens one to read it, is fine.
 *
 * @param line - The command line. Past the length a read check gives up at, the rest goes unread.
 * @param roots - This launch's folders.
 */
export function commandWritesAgentSetup(line: string, roots: ShellGuardRoots): boolean {
  const command = line.slice(0, MAX_COMMAND);
  const open = roots.openHome ? spellings(roots.openHome) : [];
  const homes = roots.agentHomes().flatMap(spellings);
  const agentsFolders = spellings(path.join(roots.dorkHome, 'agents'));
  /** Whether a home's own setup is touched by a write to `target`. */
  const inHome = (home: string, target: string, whole: boolean): boolean => {
    if (whole && within(target, home)) return true;
    if (!within(home, target)) return false;
    const relative = path.relative(home, target).split(path.sep).join('/');
    return (open.includes(home) ? OPEN_HOME_KEEPS : SETUP).test(relative);
  };
  const reaches = (target: string, whole: boolean): boolean => {
    if (homes.some((home) => inHome(home, target, whole))) return true;
    // A home the registry hasn't noticed yet is still a home.
    return agentsFolders.some((agents) => {
      if (!within(agents, target) || target === agents) return whole && within(target, agents);
      const owner = path.relative(agents, target).split(path.sep)[0]!;
      return inHome(path.join(agents, owner), target, whole);
    });
  };
  const { segments, resolve } = readCommand(command, roots);
  return segments.some(({ segment, cwd }, index) =>
    writtenWords(segment, segments[index - 1]?.segment).some(({ word, whole, pieces, sources }) =>
      (resolve(word, { pieces, writingFrom: cwd }) ?? []).some((target) => {
        if (reaches(target, whole) || reaches(realLocation(target), whole)) return true;
        if (!sources || !isFolder(target)) return false;
        return sources.some((source) =>
          (resolve(source, { pieces: false, writingFrom: cwd }) ?? []).some((from) =>
            namesLanding(from, source).some((name) => reaches(path.join(target, name), false))
          )
        );
      })
    )
  );
}

/** Called with the call a shell write to setup files was refused for. */
export type ShellRefusalRecorder = (call: {
  toolUseId: string;
  command: string;
  agentId?: string;
}) => void;

/** What the hook needs beyond the session. */
export interface ShellGuardOptions {
  /** This launch's folders, read at each call. */
  roots: () => ShellGuardRoots;
  /** Writes the refused call to the audit log. */
  recordRefusal: ShellRefusalRecorder;
  /** Reports what the hook decided. */
  log: { info(message: string, data: Record<string, unknown>): void };
}

/**
 * The hook. Read at call time from the session: a warm process serves many turns.
 *
 * @param session - The session's chosen mode and both ceilings.
 * @param options - The folders, the audit recorder and the log.
 */
export function createShellPathGuardHook(
  session: CeilingedMode<PermissionModeId>,
  options: ShellGuardOptions
): HookCallback {
  const { roots, recordRefusal, log } = options;
  return async (hookInput) => {
    if (hookInput.hook_event_name !== 'PreToolUse') return {};
    if (!SHELL_TOOLS.has(hookInput.tool_name)) return {};
    const input = hookInput.tool_input as { command?: unknown } | null;
    const command = input?.command;
    if (typeof command !== 'string') return {};
    let writes: boolean;
    try {
      writes = commandWritesAgentSetup(command, roots());
    } catch {
      // Refusing on a bug here would stop every shell command; the read check below still asks.
      writes = false;
    }
    if (writes) {
      // Never the command in the log: it may hold a token. The audit writer sweeps its own copy.
      log.info('[ShellGuard] refused a shell write to agent setup files', {});
      recordRefusal({
        toolUseId: hookInput.tool_use_id,
        command,
        ...(hookInput.agent_id ? { agentId: hookInput.agent_id } : {}),
      });
      return decision('deny', SHELL_WRITE_DENY_REASON);
    }
    // At Full the shell reads what it names: the stated limit of that level.
    if (chosenFullAutonomy(session) || gatePermissionMode(session) === 'bypassPermissions') {
      return {};
    }
    let reaches: boolean;
    try {
      reaches = await commandReachesProtectedRead(command, roots());
    } catch {
      reaches = true;
    }
    if (!reaches) return {};
    log.info('[ShellGuard] a shell command reaches a protected file; asking', {});
    return decision('ask', SHELL_READ_ASK_REASON);
  };
}

/** A `PreToolUse` answer. */
function decision(permissionDecision: 'ask' | 'deny', permissionDecisionReason: string) {
  return {
    hookSpecificOutput: {
      hookEventName: 'PreToolUse' as const,
      permissionDecision,
      permissionDecisionReason,
    },
  };
}
