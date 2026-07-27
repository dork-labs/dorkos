#!/usr/bin/env node
/**
 * Git Guard Hook
 *
 * PreToolUse(Bash) guard that refuses the git commands that have destroyed
 * work in this repo, and explains what to do instead.
 *
 * WHY THIS IS CODE AND NOT PROSE
 *
 * On 2026-07-22, in one session:
 *   - An agent ran `git stash -u` in a worktree while a background job was
 *     mid-test-run, reverting its own tree. Its follow-up `git stash pop`
 *     against an already-clean tree popped the USER's 2026-07-22 checkpoint
 *     and started deleting tracked files. Recovered with `git reset --hard`.
 *   - Three separate agents ran `git checkout -- <file>` on uncommitted work
 *     and each silently reverted legitimate edits.
 * Every one of those agents had "do not use these" in its brief. Prose did not
 * hold, so this is a guard.
 *
 * `refs/stash` lives in the COMMON git dir, so one stash stack is shared by
 * the main checkout and every worktree. `create-checkpoint.sh` (Stop hook)
 * keeps the last 10 auto-checkpoints there. A `pop` in any worktree can
 * therefore land another writer's checkpoint on top of your tree.
 *
 * WHAT IT BLOCKS
 *   - `git stash` and every subcommand except the two read-only ones
 *     (`list`, `show`).
 *   - `git checkout -- <path>`, `git checkout HEAD -- <path>`, and the bare
 *     pathspec forms `git checkout .` / `./x` / `../x`.
 *   - `git restore <path>` and `git restore --staged --worktree <path>` when
 *     no source other than HEAD is named.
 *
 * WHAT IT DELIBERATELY ALLOWS
 *   - `git stash list`, `git stash show` — read-only, and the way you prove
 *     nothing was lost.
 *   - `git checkout <branch>`, `-b`, `<sha>`, `git worktree *`, `git clean`,
 *     `git reset --hard <sha>` (the documented recovery path).
 *   - Forms that name a source other than HEAD — `git checkout <sha> -- f`,
 *     `git restore --source=HEAD~1 f`. Those overwrite uncommitted edits too,
 *     but they are a deliberate retrieval of a specific version and git has no
 *     other spelling for it. HEAD is excluded because `--source=HEAD` is a
 *     pure discard of your own work wearing the retrieval spelling.
 *   - `git restore --staged <path>` — unstages only, the working tree is
 *     untouched.
 *   - `--ours` / `--theirs` — merge-conflict resolution, not a blind discard.
 *
 * WHY THIS IS A HOOK AND NOT `permissions.deny`
 *
 * A declarative `Bash(git stash:*)` deny rule was the preferred answer, and it
 * was measured against live headless sessions before being rejected. What the
 * runs showed (Claude Code 2.1.219):
 *   - `cd /tmp && git stash` IS denied. The native matcher splits compound
 *     commands, so that half of the worry was unfounded.
 *   - `git -C somedir stash` is NOT denied. It ran.
 *   - `git stash list` IS denied. That is fatal: the read-only commands are how
 *     you prove nothing was lost, and deny is evaluated before allow with no
 *     exceptions, so no allow rule can carve them back out.
 * The policy is "block git stash EXCEPT list and show", and a prefix matcher
 * with unconditional deny precedence cannot express an exception. Same for
 * checkout: `Bash(git checkout:*)` would block `git checkout main`.
 *
 * COVERAGE THIS DOES NOT HAVE (stated plainly, on purpose)
 * It stops the reflex, not a determined bypass. It reads the command string
 * the model submits, so it does not see:
 *   - a destructive git command inside a script on disk (`./do-it.sh`), a
 *     shell function, an alias, or `eval "$VAR"`;
 *   - `xargs git ...`, `find -exec git ...`, or `git` reached under another
 *     name;
 *   - `$(...)` nested more than one level deep, or inside `$( )` containing
 *     its own parentheses;
 *   - `git checkout <ambiguous-path>` with no `--` and no leading `./`, which
 *     is indistinguishable from `git checkout <branch>` without asking git
 *     what refs exist. Blocking it would also block `git checkout main`, and a
 *     guard that blocks `git checkout main` gets switched off.
 * It does unwrap one level of `sh -c` / `bash -c` and `$(...)`, splits
 * compound commands on shell operators, and ignores anything inside quotes,
 * so `git commit -m "ran git stash"` is not a false positive.
 *
 * It also never sees commands run by OTHER hooks: PreToolUse fires on tool
 * calls in the agentic loop only. That is why `create-checkpoint.sh` can keep
 * calling `git stash create` / `git stash store` from the Stop hook even though
 * this guard refuses both when a model types them. Proved in one live headless
 * session with this guard wired in: the model's `git stash push -u` came back
 * refused, and the Stop hook still wrote `claude-checkpoint: Auto-save at ...`
 * containing the edit. scripts/test-git-guard.sh pins the half it can reach
 * (that the script still produces a checkpoint); the hook wiring itself needs a
 * real session, so re-prove that if you ever change the PreToolUse matcher.
 */

import path from 'path';

const { basename } = path;

/** Shell operators that separate one command from the next. */
const TWO_CHAR_OPERATORS = ['&&', '||', '|&'];
const ONE_CHAR_OPERATORS = [';', '|', '&', '\n'];

/** Wrappers whose `-c` argument is itself a command line. */
const SHELL_WRAPPERS = new Set(['sh', 'bash', 'zsh', 'dash', 'ksh']);

/** Words that can precede the real command without changing it. */
const COMMAND_PREFIXES = new Set(['sudo', 'command', 'env', 'nohup', 'nice', 'time', 'builtin']);

/** git global options that consume the following token when not written with `=`. */
const GIT_GLOBAL_OPTIONS_WITH_VALUE = new Set([
  '-C',
  '-c',
  '--git-dir',
  '--work-tree',
  '--namespace',
  '--exec-path',
  '--super-prefix',
  '--config-env',
]);

/** `git stash` subcommands that only read. Everything else moves work around. */
const READ_ONLY_STASH_SUBCOMMANDS = new Set(['list', 'show']);

const STASH_MESSAGE = `Blocked: git stash

The stash is shared. Every worktree and the main checkout read and write one
stash list, and it holds this project's auto-saved checkpoints of your work.
A stash here can revert a tree someone else is using, and a pop here can drop
another writer's checkpoint on top of your files and delete them. Both of
those happened on 2026-07-22.

Do this instead: copy the files you want to park into your session scratchpad,
then put them back with cp when you are done.

Still allowed: git stash list and git stash show. They only read, and they are
how you check that nothing was lost.`;

const CHECKOUT_MESSAGE = `Blocked: git checkout -- <path>

This throws away your own uncommitted edits, and there is no undo. Three
agents ran it on 2026-07-22 and each one silently reverted work it had just
written.

Check first: run git diff <path> and read what you are about to lose. To park
changes, copy the file to your session scratchpad and bring it back with cp.

Still allowed: git checkout <branch>, git checkout -b <new-branch>, and
git checkout <commit> -- <path> when you name a commit other than HEAD.`;

const RESTORE_MESSAGE = `Blocked: git restore <path>

This is git checkout -- <path> under a newer name: it throws away your own
uncommitted edits with no undo. Three agents lost work to that on 2026-07-22.

Check first: run git diff <path> and read what you are about to lose. To park
changes, copy the file to your session scratchpad and bring it back with cp.

Still allowed: git restore --staged <path>, which only unstages and leaves
your file alone, and git restore --source=<commit> <path> when you name a
commit other than HEAD.`;

/**
 * Split a command line into the individual commands it runs, ignoring
 * operators that appear inside quotes.
 *
 * @param {string} command - Raw command line.
 * @returns {string[]} Non-empty, trimmed command segments.
 */
function splitSegments(command) {
  const segments = [];
  let current = '';
  let quote = null;

  for (let i = 0; i < command.length; i++) {
    const char = command[i];

    if (quote) {
      if (char === '\\' && quote === '"' && i + 1 < command.length) {
        current += char + command[++i];
        continue;
      }
      if (char === quote) quote = null;
      current += char;
      continue;
    }

    if (char === "'" || char === '"') {
      quote = char;
      current += char;
      continue;
    }
    if (char === '\\' && i + 1 < command.length) {
      current += char + command[++i];
      continue;
    }
    if (TWO_CHAR_OPERATORS.includes(command.slice(i, i + 2))) {
      segments.push(current);
      current = '';
      i++;
      continue;
    }
    if (ONE_CHAR_OPERATORS.includes(char)) {
      segments.push(current);
      current = '';
      continue;
    }
    current += char;
  }
  segments.push(current);

  return segments.map((segment) => segment.trim()).filter(Boolean);
}

/**
 * Pull out the bodies of one level of `$(...)` and backtick substitution so
 * `echo $(git stash pop)` is inspected rather than skipped as an `echo`.
 *
 * @param {string} command - Raw command line.
 * @returns {string[]} Substitution bodies, which may be empty.
 */
function extractSubstitutions(command) {
  const bodies = [];
  const pattern = /\$\(([^()]*)\)|`([^`]*)`/g;
  let match;
  while ((match = pattern.exec(command)) !== null) {
    bodies.push(match[1] ?? match[2]);
  }
  return bodies;
}

/**
 * Split a single command segment into arguments, dropping quotes and
 * collapsing runs of whitespace (so `git  stash` reads as `git stash`).
 *
 * @param {string} segment - One command segment.
 * @returns {string[]} Unquoted argument tokens.
 */
function tokenize(segment) {
  const tokens = [];
  let current = '';
  let quoted = false;
  let quote = null;

  for (let i = 0; i < segment.length; i++) {
    const char = segment[i];

    if (quote) {
      if (char === '\\' && quote === '"' && i + 1 < segment.length) {
        current += segment[++i];
        continue;
      }
      if (char === quote) {
        quote = null;
        continue;
      }
      current += char;
      continue;
    }

    if (char === "'" || char === '"') {
      quote = char;
      quoted = true;
      continue;
    }
    if (char === '\\' && i + 1 < segment.length) {
      current += segment[++i];
      continue;
    }
    if (/\s/.test(char)) {
      if (current || quoted) tokens.push(current);
      current = '';
      quoted = false;
      continue;
    }
    current += char;
  }
  if (current || quoted) tokens.push(current);

  return tokens;
}

/**
 * Drop leading `VAR=value` assignments and wrapper words like `sudo`.
 *
 * @param {string[]} tokens - Argument tokens for one segment.
 * @returns {string[]} Tokens starting at the real command name.
 */
function stripCommandPrefixes(tokens) {
  let index = 0;
  while (index < tokens.length) {
    const token = tokens[index];
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(token)) {
      index++;
      continue;
    }
    if (COMMAND_PREFIXES.has(basename(token))) {
      index++;
      continue;
    }
    break;
  }
  return tokens.slice(index);
}

/**
 * Skip git's global options to reach the subcommand and its arguments.
 *
 * @param {string[]} tokens - Tokens after the `git` word.
 * @returns {{ subcommand: string | null, args: string[] }} The subcommand and its arguments.
 */
function readGitSubcommand(tokens) {
  let index = 0;
  while (index < tokens.length) {
    const token = tokens[index];
    if (!token.startsWith('-')) {
      return { subcommand: token, args: tokens.slice(index + 1) };
    }
    const flag = token.split('=')[0];
    if (GIT_GLOBAL_OPTIONS_WITH_VALUE.has(flag) && !token.includes('=')) index++;
    index++;
  }
  return { subcommand: null, args: [] };
}

/**
 * Decide whether a `git stash ...` invocation is one of the two read-only forms.
 *
 * @param {string[]} args - Arguments after `stash`.
 * @returns {string | null} A refusal message, or null to allow.
 */
function checkStash(args) {
  const subcommand = args.find((arg) => !arg.startsWith('-'));
  if (subcommand && READ_ONLY_STASH_SUBCOMMANDS.has(subcommand)) return null;
  return STASH_MESSAGE;
}

/**
 * Decide whether a `git checkout ...` invocation discards uncommitted work.
 *
 * @param {string[]} args - Arguments after `checkout`.
 * @returns {string | null} A refusal message, or null to allow.
 */
function checkCheckout(args) {
  if (args.includes('--ours') || args.includes('--theirs')) return null;

  const separator = args.indexOf('--');
  if (separator !== -1) {
    // Nothing after `--` means no pathspec, so nothing is overwritten.
    if (separator === args.length - 1) return null;
    const source = args.slice(0, separator).find((arg) => !arg.startsWith('-'));
    if (source && source !== 'HEAD') return null;
    return CHECKOUT_MESSAGE;
  }

  // No `--`: only the spellings that cannot be a branch name are treated as a
  // pathspec, so `git checkout main` stays out of the way.
  const positional = args.filter((arg) => !arg.startsWith('-'));
  if (positional.some((arg) => arg === '.' || arg.startsWith('./') || arg.startsWith('../'))) {
    return CHECKOUT_MESSAGE;
  }
  return null;
}

/**
 * Decide whether a `git restore ...` invocation discards uncommitted work.
 *
 * @param {string[]} args - Arguments after `restore`.
 * @returns {string | null} A refusal message, or null to allow.
 */
function checkRestore(args) {
  if (args.includes('--ours') || args.includes('--theirs')) return null;

  const staged = args.includes('--staged') || args.includes('-S');
  const worktree = args.includes('--worktree') || args.includes('-W');
  // `--staged` on its own rewrites the index from HEAD and leaves the file alone.
  if (staged && !worktree) return null;

  let source = null;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg.startsWith('--source=')) source = arg.slice('--source='.length);
    else if (arg === '--source' || arg === '-s') source = args[i + 1] ?? null;
  }
  if (source && source !== 'HEAD') return null;

  return RESTORE_MESSAGE;
}

/**
 * Inspect one command segment, following one level of `sh -c` wrapping.
 *
 * @param {string} segment - A single command segment.
 * @param {number} depth - Current unwrapping depth.
 * @returns {string | null} A refusal message, or null to allow.
 */
function inspectSegment(segment, depth) {
  const tokens = stripCommandPrefixes(tokenize(segment));
  if (tokens.length === 0) return null;

  const name = basename(tokens[0]);

  if (SHELL_WRAPPERS.has(name) && depth < 2) {
    const flagIndex = tokens.indexOf('-c');
    const inner = flagIndex !== -1 ? tokens[flagIndex + 1] : null;
    return inner ? inspectCommand(inner, depth + 1) : null;
  }

  if (name !== 'git') return null;

  const { subcommand, args } = readGitSubcommand(tokens.slice(1));
  if (subcommand === 'stash') return checkStash(args);
  if (subcommand === 'checkout') return checkCheckout(args);
  if (subcommand === 'restore') return checkRestore(args);
  return null;
}

/**
 * Inspect a whole command line, including its substitutions.
 *
 * @param {string} command - Raw command line from the Bash tool.
 * @param {number} [depth] - Current unwrapping depth.
 * @returns {string | null} The first refusal message found, or null to allow.
 */
function inspectCommand(command, depth = 0) {
  if (!command) return null;

  for (const segment of splitSegments(command)) {
    const refusal = inspectSegment(segment, depth);
    if (refusal) return refusal;
  }

  if (depth < 2) {
    for (const body of extractSubstitutions(command)) {
      const refusal = inspectCommand(body, depth + 1);
      if (refusal) return refusal;
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
    const input = await readStdin();
    if (!input.trim()) process.exit(0);

    const payload = JSON.parse(input);
    if (payload.tool_name !== 'Bash') process.exit(0);

    const refusal = inspectCommand(payload.tool_input?.command);
    if (refusal) {
      console.error(refusal);
      process.exit(2);
    }
    process.exit(0);
  } catch (error) {
    // Fail open: a guard that crashes must not block every bash command. The
    // fixture suite in scripts/test-git-guard.sh is what keeps this honest.
    console.error(`git-guard error: ${error.message}`);
    process.exit(0);
  }
}

await main();
