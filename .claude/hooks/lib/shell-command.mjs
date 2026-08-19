/**
 * Shell command-line parsing shared by the PreToolUse(Bash) guard hooks.
 *
 * `git-guard.mjs` and `process-guard.mjs` both need the same three things
 * before they can decide anything: split a command line into the commands it
 * runs (respecting quotes), pull out `$(...)` / backtick bodies so a command
 * hiding inside a substitution is still inspected, and turn one segment into
 * unquoted argument tokens with the `sudo`/`env`/loop-keyword prefixes
 * stripped. Keeping one copy here means a hole found in one guard's parsing is
 * fixed for both — the fixture suites in `scripts/test-git-guard.sh` and
 * `scripts/test-process-guard.sh` both run against this module.
 *
 * Coverage limits are the guards' own contract (see the header comment in
 * git-guard.mjs): this reads the command string the model submits and one
 * level of substitution, and does not see scripts on disk, aliases, `eval`,
 * `xargs`, or substitutions nested more than one level deep.
 */

import path from 'path';

const { basename } = path;

/** Shell operators that separate one command from the next. */
const TWO_CHAR_OPERATORS = ['&&', '||', '|&'];
const ONE_CHAR_OPERATORS = [';', '|', '&', '\n'];

/** Wrappers whose `-c` argument is itself a command line. */
const SHELL_WRAPPERS = new Set(['sh', 'bash', 'zsh', 'dash', 'ksh']);

/** Words that can precede the real command without changing it. */
const COMMAND_PREFIXES = new Set([
  'sudo',
  'command',
  'env',
  'nohup',
  'nice',
  'time',
  'builtin',
  // Shell grouping and control keywords. Without these, the command inside a
  // loop body or a subshell reads as a command named `do` or `(git`, and the
  // whole segment is skipped. `for f in ...; do git checkout -- $f; done` is a
  // spelling agents reach for unprompted.
  'then',
  'do',
  'else',
  'elif',
  '!',
  '(',
  '{',
]);

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

  // Strip the grouping punctuation that can sit flush against the command:
  // `(git stash pop)` tokenizes as `(git` ... `pop)`, and without this the
  // first token is not `git` and the segment is skipped entirely. The trailing
  // half matters just as much in the other direction — leaving `)` attached to
  // `list` in `(git stash list)` would turn a read-only command into a block.
  const rest = tokens.slice(index);
  if (rest.length > 0) {
    rest[0] = rest[0].replace(/^[({]+/, '');
    const last = rest.length - 1;
    rest[last] = rest[last].replace(/[)};]+$/, '');
    if (rest[0] === '') rest.shift();
  }
  return rest;
}

export {
  SHELL_WRAPPERS,
  COMMAND_PREFIXES,
  splitSegments,
  extractSubstitutions,
  tokenize,
  stripCommandPrefixes,
};
