#!/usr/bin/env node
/**
 * Heavy Command Guard Hook
 *
 * PreToolUse(Bash) guard that sends a raw heavy command into DorkOS's load gate
 * (DOR-4209): it refuses the command as typed and says the one line to run
 * instead, `pnpm heavy <command>`, which waits its turn in the gate.
 *
 * WHY THIS IS CODE AND NOT PROSE
 *
 * The gate is the one line for heavy jobs on this computer. An agent in a
 * DorkOS chat is already held by it (the server's own hook), and the root
 * `build`, `test`, `typecheck` and `verify` scripts join it through
 * scripts/heavy-run-lock.sh. What walked past it was a heavy command typed
 * straight into a bare `claude` session: a whole `vitest run`, a
 * `playwright test`, a `turbo build`. On 2026-11-11 and 11-19 the load reached
 * 93 and 80 on 14 cores, and every agent that skipped a brief's "run uptime
 * first" rule made it worse. A rule in a brief is the thing that failed; this
 * guard is what makes the gate the only road.
 *
 * WHAT IT REFUSES (each also behind `pnpm`, `pnpm exec`, `npx`, `pnpm dlx`,
 * `yarn`, `bunx`, a runner such as `env` or `timeout`, `sh -c`, or a `$(…)`)
 *   - `vitest` given no path at all (the whole suite, or watch mode), given a
 *     directory or a name filter (vitest runs every file it matches), given
 *     more than MAX_FREE_TEST_FILES test files, or fed its paths by `xargs`.
 *   - `playwright test`.
 *   - `turbo` running `build`, `typecheck`, `test`, `lint` or `e2e`, with or
 *     without `run`.
 *   - `tsc` in any spelling (`tsc`, `npx tsc`, `pnpm exec tsc`, `node …/tsc`),
 *     except --help, --version, --init and --showConfig.
 *   - A package's own heavy script (build, typecheck, test*, lint*, e2e,
 *     verify, check*): `pnpm --filter <pkg> typecheck`, `-F`, `-C`/`--dir`,
 *     `-r`/`--recursive`, `npm --workspace`, `yarn workspace <pkg> …`, or a
 *     `pnpm <script>` after `cd apps/…` / `cd packages/…` (or with the hook's
 *     cwd there). Only the root build/test/typecheck/verify scripts join the
 *     gate on their own; the root `lint` and `lint:fix` run turbo lint raw.
 *   - A raised Node heap (`NODE_OPTIONS=--max-old-space-size=…`, `export
 *     NODE_OPTIONS=…`, `node --max-old-space-size=…`) outside `pnpm heavy`.
 *     Nov 25: the Mac panicked twice on an exhausted memory compressor while
 *     about 600 typechecks (often with an 8 GB heap) and 2,200 vitest runs
 *     walked around the gate through exactly these spellings.
 *
 * WHAT IT DELIBERATELY ALLOWS (keep it narrow)
 *   - `vitest` given up to MAX_FREE_TEST_FILES test files by name
 *     (`pnpm vitest run apps/server/src/x.test.ts`): the targeted run AGENTS.md
 *     asks for. A file is a path ending in .test or .spec plus a JS/TS
 *     extension.
 *   - The wrappers that already join the gate: `pnpm heavy …`,
 *     `bash scripts/heavy-run-lock.sh …`, and the root `pnpm build`, `pnpm test`,
 *     `pnpm typecheck`, `pnpm verify` and `pnpm test:browser` scripts.
 *   - `turbo dev`, `turbo watch`, and `--help` or `--version` of anything.
 *   - Text that names a heavy command: a commit message, an echo, a grep.
 *   - Every command in a DorkOS chat (`DORKOS_SESSION_ID` is set in the CLI's
 *     own environment, which a command cannot change): the server's hook holds
 *     those in the gate itself, and refusing them here would only add a step.
 *
 * COVERAGE THIS DOES NOT HAVE
 *
 * It reads command text only: a heavy command inside a script on disk, an
 * alias, or a harness that runs no Claude hooks (bare Codex or OpenCode) walks
 * past it. Under DorkOS those runtimes are held by the server's gate instead.
 *
 * It fails CLOSED when node cannot start (run-node-hook.sh) and OPEN when it
 * crashes on a payload, like its siblings. It kills nothing and runs nothing.
 *
 * Fixtures: scripts/test-heavy-command-guard.sh.
 */

import path from 'path';
import {
  splitSegments,
  maskUnexpandedText,
  extractSubstitutions,
  tokenize,
  stripCommandPrefixes,
  readWrappedCommand,
} from './lib/shell-command.mjs';

const { basename } = path;

/**
 * The refusal, naming the command as the agent should type it.
 *
 * @param {string} what - What was refused, in a few words.
 * @returns {string} The message.
 */
function refusal(what) {
  return `Blocked: ${what} is a heavy job, so it waits its turn in DorkOS's load gate.

Run it through the gate instead:

  pnpm heavy <the same command>

It waits while the computer is busy (exit 75 means "try again later", not a
failure), then runs exactly as typed. A coordinator's order line is
\`bash scripts/heavy-run-lock.sh --label <label> <command>\`.
To test one file instead, give vitest its path: pnpm vitest run <file>.
The guide: contributing/ci.md, "Heavy local runs".`;
}

/** How many named test files a vitest run may take outside the gate. */
const MAX_FREE_TEST_FILES = 3;

/** A path vitest runs as one file, not as a directory or a name filter. */
const TEST_FILE = /\.(test|spec)\.[cm]?[jt]sx?$/;

/** Package scripts that are heavy when a package runs its own copy. */
const HEAVY_SCRIPT = /^(build|typecheck|tsc|test|lint|e2e|verify|check)(:.*)?$/;

/** Root scripts that run a heavy job without joining the gate themselves. */
const UNGATED_ROOT_SCRIPTS = new Set(['lint', 'lint:fix']);

/** A raised V8 heap: `--max-old-space-size` (or its `max_old_space_size` spelling). */
const HEAP_FLAG = /max[-_]old[-_]space[-_]size/;

/** turbo tasks that are heavy. */
const HEAVY_TURBO_TASKS = new Set(['build', 'typecheck', 'test', 'lint', 'e2e']);

/** Words that run the rest of their arguments as a command. */
const RUNNERS = new Set([
  'timeout',
  'gtimeout',
  'exec',
  'xargs',
  'env',
  'nice',
  'nohup',
  'sudo',
  'doas',
  'command',
  'time',
  'stdbuf',
  'ionice',
  'caffeinate',
  'watch',
  'parallel',
]);

/** Commands that execute text fed to them on stdin or as their argument. */
const STDIN_SHELLS = new Set(['sh', 'bash', 'zsh', 'dash', 'ksh', 'fish', 'eval', 'source', '.']);

/** Package-manager flags that take the next word as their value. */
const PM_FLAGS_WITH_VALUE = new Set([
  '-C',
  '--dir',
  '--filter',
  '-F',
  '--cwd',
  '--workspace',
  '-w',
]);

/** vitest options that take the next word as their value. */
const VITEST_FLAGS_WITH_VALUE = new Set([
  '--project',
  '--config',
  '-c',
  '--root',
  '-r',
  '--dir',
  '--reporter',
  '--shard',
  '--testNamePattern',
  '-t',
  '--pool',
  '--environment',
  '--maxWorkers',
  '--minWorkers',
  '--mode',
  '--outputFile',
  '--exclude',
]);

/**
 * Drop leading flags (and the value a flag like `--filter` takes).
 *
 * @param {string[]} tokens - Tokens to walk.
 * @param {Set<string>} withValue - Flags that consume the next token.
 * @returns {string[]} Tokens from the first word that is not a flag or its value.
 */
function skipFlags(tokens, withValue) {
  let index = 0;
  while (index < tokens.length && tokens[index].startsWith('-')) {
    index += withValue.has(tokens[index]) ? 2 : 1;
  }
  return tokens.slice(index);
}

/** Whether a command only asks for help or a version. */
const asksHelp = (args) => args.some((arg) => /^(--help|-h|--version|-v|-V)$/.test(arg));

/**
 * Decide a vitest invocation: heavy when it names no path at all.
 *
 * @param {string[]} args - Arguments after `vitest`.
 * @returns {string | null} A refusal message, or null to allow.
 */
function checkVitest(args, fed = false) {
  if (asksHelp(args)) return null;
  if (fed) return refusal('vitest fed its paths by xargs (any number of files)');
  const positionals = [];
  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    if (arg === '--') continue;
    if (arg.startsWith('-')) {
      if (VITEST_FLAGS_WITH_VALUE.has(arg)) index++;
      continue;
    }
    positionals.push(arg);
  }
  // `run`, `watch`, `dev` and `related` are subcommands, not paths.
  const paths = positionals.filter((word) => !['run', 'watch', 'dev', 'bench'].includes(word));
  if (paths.length === 0) return refusal('a whole vitest suite (no test file named)');
  const notFile = paths.find((word) => !TEST_FILE.test(word));
  if (notFile) {
    return refusal(
      `vitest given ${notFile} (a directory or a name filter runs every test file it matches)`
    );
  }
  if (paths.length > MAX_FREE_TEST_FILES) {
    return refusal(`vitest given ${paths.length} test files (more than ${MAX_FREE_TEST_FILES})`);
  }
  return null;
}

/**
 * Decide a tsc invocation: every compile is heavy here.
 *
 * @param {string[]} args - Arguments after `tsc`.
 * @returns {string | null} A refusal message, or null to allow.
 */
function checkTsc(args) {
  const light = args.some((arg) =>
    /^(--help|-h|--version|-v|--init|--showConfig|--all)$/.test(arg)
  );
  return light ? null : refusal('tsc (a TypeScript compile or typecheck)');
}

/**
 * Decide a package-manager script: heavy when a package's own heavy script
 * runs (scoped by a flag, or from inside a package's folder), or when it is a
 * root script that does not join the gate.
 *
 * @param {string} script - The script name.
 * @param {boolean} scoped - True when the script is a package's, not the root's.
 * @returns {string | null} A refusal message, or null to allow.
 */
function checkScript(script, scoped) {
  if (!script) return null;
  if (scoped && HEAVY_SCRIPT.test(script)) return refusal(`a package's own \`${script}\` script`);
  if (!scoped && UNGATED_ROOT_SCRIPTS.has(script))
    return refusal(`the root \`${script}\` script (turbo lint)`);
  return null;
}

/**
 * Decide a turbo invocation: heavy when any task it runs is a heavy one.
 *
 * @param {string[]} args - Arguments after `turbo`.
 * @returns {string | null} A refusal message, or null to allow.
 */
function checkTurbo(args) {
  if (asksHelp(args)) return null;
  const words = args.filter((arg) => !arg.startsWith('-'));
  const tasks = words[0] === 'run' ? words.slice(1) : words.slice(0, 1);
  const heavy = tasks.find((task) => HEAVY_TURBO_TASKS.has(task));
  return heavy ? refusal(`turbo ${heavy}`) : null;
}

/**
 * Decide a program and its arguments, following package-manager runners.
 *
 * @param {string} name - The program's base name.
 * @param {string[]} args - Its arguments.
 * @param {number} depth - How many runners were followed.
 * @returns {string | null} A refusal message, or null to allow.
 */
function checkProgram(name, args, depth, ctx = {}) {
  if (depth > 4) return null;
  if (name === 'vitest') return checkVitest(args, ctx.fed);
  if (name === 'tsc' || name === 'vue-tsc' || name === 'tsgo') return checkTsc(args);
  if (name === 'node') {
    if (args.some((arg) => HEAP_FLAG.test(arg)))
      return refusal('node with a raised heap (--max-old-space-size)');
    const script = args.find((arg) => !arg.startsWith('-'));
    if (script && /(^|\/)(tsc|typescript\/bin\/tsc|vitest(\.mjs)?)$/.test(script)) {
      const rest = args.slice(args.indexOf(script) + 1);
      return /tsc$/.test(script) ? checkTsc(rest) : checkVitest(rest, ctx.fed);
    }
    return null;
  }
  if (name === 'turbo') return checkTurbo(args);
  if (name === 'playwright') {
    const [sub, ...rest] = skipFlags(args, new Set());
    return sub === 'test' && !asksHelp(rest) ? refusal('playwright test') : null;
  }
  if (name === 'npx' || name === 'bunx') {
    const [program, ...rest] = skipFlags(args, PM_FLAGS_WITH_VALUE);
    return program ? checkProgram(basename(program), rest, depth + 1, ctx) : null;
  }
  if (name === 'pnpm' || name === 'yarn' || name === 'npm' || name === 'bun') {
    const lead = args.slice(0, args.length - skipFlags(args, PM_FLAGS_WITH_VALUE).length);
    const [sub, ...rest] = skipFlags(args, PM_FLAGS_WITH_VALUE);
    if (!sub) return null;
    // Already in the gate, or a root script that joins it on its own.
    if (sub === 'heavy') return null;
    // A package's copy: a filter or directory flag (npm's -w is --workspace;
    // pnpm's -w is the workspace root), recursive, or a cwd inside a package.
    const scopedFlag = lead.some(
      (flag) =>
        /^(-C|--dir|--filter|-F|--cwd|--workspace|-r|--recursive)(=|$)/.test(flag) ||
        (flag === '-w' && name === 'npm')
    );
    const scoped = scopedFlag || Boolean(ctx.inPackage);
    if (sub === 'exec' || sub === 'dlx' || sub === 'x') {
      const [program, ...after] = skipFlags(rest, PM_FLAGS_WITH_VALUE);
      return program ? checkProgram(basename(program), after, depth + 1, ctx) : null;
    }
    // `pnpm vitest …`, `pnpm turbo …`, `pnpm playwright …`, `pnpm tsc …` run the local binary.
    if (['vitest', 'turbo', 'playwright', 'tsc'].includes(sub)) {
      return checkProgram(sub, rest, depth + 1, ctx);
    }
    if (name === 'yarn' && sub === 'workspace') {
      const [, script, ...more] = rest;
      return script === 'run' ? checkScript(more[0], true) : checkScript(script, true);
    }
    if (sub === 'run' || sub === 'run-script') {
      const [script] = skipFlags(rest, PM_FLAGS_WITH_VALUE);
      return checkScript(script, scoped);
    }
    if (sub === 'test' || sub === 't') return checkScript('test', scoped);
    return checkScript(sub, scoped);
  }
  return null;
}

/**
 * Decide one already-tokenized command.
 *
 * @param {string[]} tokens - Tokens of one command, prefixes stripped.
 * @param {number} depth - Current unwrapping depth.
 * @returns {string | null} A refusal message, or null to allow.
 */
function inspectTokens(tokens, depth, ctx = {}) {
  if (tokens.length === 0) return null;
  const name = basename(tokens[0]);
  if (RUNNERS.has(name)) {
    // xargs and parallel append words read from stdin, so the paths are unknown.
    const inner = name === 'xargs' || name === 'parallel' ? { ...ctx, fed: true } : ctx;
    // A runner's own arguments (`timeout 600`, `nice -n 5`) come before the command it
    // starts, so every later word is tried as that command, as merge-guard.mjs does.
    for (let k = 1; k < tokens.length; k++) {
      if (/^-|=/.test(tokens[k])) continue;
      const found = inspectTokens(tokens.slice(k), depth, inner);
      if (found) return found;
    }
    return null;
  }
  return checkProgram(name, tokens.slice(1), 0, ctx);
}

/**
 * Inspect one command segment, following one level of `sh -c` wrapping.
 *
 * @param {string} segment - A single command segment.
 * @param {number} depth - Current unwrapping depth.
 * @returns {string | null} A refusal message, or null to allow.
 */
function inspectSegment(segment, depth, ctx = {}) {
  const wrapped = readWrappedCommand(segment);
  if (wrapped !== null) return depth < 2 ? inspectCommand(wrapped, depth + 1, true, ctx) : null;
  const raw = tokenize(segment);
  const tokens = stripCommandPrefixes(raw);
  if (inGate(tokens)) return null;
  // A raised heap set for this command (`NODE_OPTIONS=… cmd`) or for the rest of
  // the shell (`export NODE_OPTIONS=…`), outside the gate.
  const heapSet = raw.some((token) => /^NODE_OPTIONS=/.test(token) && HEAP_FLAG.test(token));
  const heapExported =
    ['export', 'declare', 'typeset'].includes(raw[0]) &&
    raw.some((token) => /^NODE_OPTIONS=/.test(token) && HEAP_FLAG.test(token));
  if (heapSet || heapExported)
    return refusal('a raised Node heap (NODE_OPTIONS=--max-old-space-size)');
  return inspectTokens(tokens, depth, ctx);
}

/**
 * Whether a command already runs inside the gate (`pnpm heavy …` or the lock script).
 *
 * @param {string[]} tokens - Tokens of one command, prefixes stripped.
 * @returns {boolean} True when the gate wraps this command.
 */
function inGate(tokens) {
  if (tokens.length === 0) return false;
  const name = basename(tokens[0]);
  if (name === 'pnpm') return skipFlags(tokens.slice(1), PM_FLAGS_WITH_VALUE)[0] === 'heavy';
  if (/^(ba|z|da|k)?sh$/.test(name))
    return tokens.slice(1).some((t) => /heavy-run-lock\.sh$/.test(t));
  return /heavy-run-lock\.sh$/.test(tokens[0]);
}

/**
 * Whether a `cd` target is inside one package (apps/<x> or packages/<x>).
 *
 * @param {string | undefined} target - The directory `cd` was given.
 * @returns {boolean} True for a package folder.
 */
const isPackageDir = (target) => Boolean(target) && /(^|\/)(apps|packages)\/[^/]+/.test(target);

/**
 * Whether a segment hands text to a shell (a shell word is one of its tokens).
 *
 * @param {string} segment - One command segment.
 * @returns {boolean} True when the segment runs text through a shell.
 */
function feedsAShell(segment) {
  return tokenize(segment).some((token) => STDIN_SHELLS.has(basename(token)));
}

/** Shell operators that end one command, longest first. */
const SEGMENT_OPERATORS = ['&&', '||', '|&', ';', '|', '&', '\n'];

/**
 * Split a command line into the commands it runs, leaving out the lines of a
 * quoted heredoc body unless a shell executes it. The same reading as
 * pr-create-guard.mjs and merge-guard.mjs `commandSegments`, which explain it.
 *
 * @param {string} command - Raw command line.
 * @param {boolean} strict - True when a shell will execute this text.
 * @returns {string[]} Non-empty, trimmed command segments.
 */
function commandSegments(command, strict) {
  if (strict) return splitSegments(command);
  const masked = maskUnexpandedText(command);
  if (masked === null) return splitSegments(command);

  const segments = [];
  const keep = (start, end) => {
    if (masked.slice(start, end).trim()) segments.push(command.slice(start, end).trim());
  };
  let start = 0;
  let quote = null;
  for (let i = 0; i < masked.length; i++) {
    const char = masked[i];
    if (quote) {
      if (char === '\\' && quote === '"') i++;
      else if (char === quote) quote = null;
      continue;
    }
    if (char === "'" || char === '"') {
      quote = char;
      continue;
    }
    if (char === '\\') {
      i++;
      continue;
    }
    const operator = SEGMENT_OPERATORS.find((op) => masked.startsWith(op, i));
    if (operator) {
      keep(start, i);
      i += operator.length - 1;
      start = i + 1;
    }
  }
  keep(start, masked.length);
  return segments.some(feedsAShell) ? splitSegments(command) : segments;
}

/**
 * Inspect a whole command line, including its substitutions.
 *
 * @param {string} command - Raw command line from the Bash tool.
 * @param {number} [depth] - Current unwrapping depth.
 * @param {boolean} [strict] - True when this text is run by a shell.
 * @returns {string | null} The first refusal message found, or null to allow.
 */
function inspectCommand(command, depth = 0, strict = false, ctx = {}) {
  if (!command) return null;
  const segments = commandSegments(command, strict);
  let here = { ...ctx };
  for (const segment of segments) {
    // `cd apps/server && pnpm typecheck` runs the package's own script.
    const words = stripCommandPrefixes(tokenize(segment));
    if (basename(words[0] ?? '') === 'cd' || basename(words[0] ?? '') === 'pushd') {
      here = { ...here, inPackage: isPackageDir(words[1]) };
      continue;
    }
    const found = inspectSegment(segment, depth, here);
    if (found) return found;
  }
  if (depth < 2) {
    for (const body of extractSubstitutions(command)) {
      const found = inspectCommand(body, depth + 1, strict, ctx);
      if (found) return found;
    }
  }
  return null;
}

/**
 * Read the hook payload from stdin.
 *
 * @returns {Promise<string>} The raw payload.
 */
async function readStdin() {
  let data = '';
  process.stdin.setEncoding('utf8');
  for await (const chunk of process.stdin) data += chunk;
  return data;
}

/**
 * Entry point: block the tool call with exit 2 + stderr, per the hook contract.
 *
 * @returns {Promise<void>} Resolves once the process decision is made.
 */
async function main() {
  try {
    // In a DorkOS chat the server's own hook holds heavy commands in the gate.
    if (process.env.DORKOS_SESSION_ID) process.exit(0);
    const input = await readStdin();
    if (!input.trim()) process.exit(0);

    const payload = JSON.parse(input);
    if (payload.tool_name !== 'Bash') process.exit(0);

    const cwd = typeof payload.cwd === 'string' ? payload.cwd : '';
    const found = inspectCommand(payload.tool_input?.command, 0, false, {
      inPackage: isPackageDir(cwd.replace(/^.*?\/(apps|packages)\//, '$1/')),
    });
    if (found) {
      console.error(found);
      process.exit(2);
    }
    process.exit(0);
  } catch (error) {
    // Fail open: a guard that crashes must not block every bash command.
    console.error(`heavy-command-guard error: ${error.message}`);
    process.exit(0);
  }
}

await main();
