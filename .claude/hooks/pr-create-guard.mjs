#!/usr/bin/env node
/**
 * PR Create Guard Hook
 *
 * PreToolUse(Bash) guard that refuses opening a pull request any way but
 * `scripts/open-pr.sh`, and says what to run instead.
 *
 * WHY THIS IS CODE AND NOT PROSE
 *
 * PRs were opened with a raw `gh pr create`, following the
 * creating-pull-requests skill plus coordinator briefs, and the two drifted:
 * on 2026-11-20 a brief told agents to open security-path PRs with `hold`,
 * while the arm script refuses `hold` and never lifts it, and 19 PRs sat for
 * 9 hours. scripts/open-pr.sh now holds every rule for opening a PR (the cap,
 * the computed labels, the provenance line, a hold only with a reason), pinned
 * by scripts/test-open-pr.sh. This guard is what makes it the only road.
 *
 * WHAT IT BLOCKS
 *   - `gh pr create` and its alias `gh pr new`, with `-R`/`--repo` anywhere gh
 *     accepts it.
 *   - `gh api` that POSTs to `.../pulls` (the REST create endpoint): an
 *     explicit `-X POST`/`--method POST`, or no method at all with a field or
 *     `--input`, which gh sends as a POST.
 *   - `gh api graphql` whose query names the `createPullRequest` mutation.
 *   - Each of those behind a runner (`timeout`, `env`, `xargs`, ...), inside
 *     `sh -c`/`eval`, in a substitution, or in text piped into a shell, read
 *     the same way merge-guard.mjs reads them.
 *
 * WHAT IT DELIBERATELY ALLOWS (keep it narrow)
 *   - `scripts/open-pr.sh` itself: it runs `gh pr create` inside a script,
 *     which this hook never sees.
 *   - Every other `gh pr` subcommand: view, edit, list, checks, comment,
 *     ready, merge, diff, close.
 *   - `gh api .../pulls` as a GET (no method and no fields, or `-X GET`), and
 *     POSTs to anything under a PR (`.../pulls/12/comments`, reviews).
 *   - `gh stack submit`, which opens stacked layers through its own code.
 *   - Text that names `gh pr create`: a commit message, a PR body, an echo, a
 *     grep, a heredoc written to a file.
 *
 * COVERAGE THIS DOES NOT HAVE
 *
 * It reads command text only, like merge-guard.mjs: a `gh pr create` inside a
 * script on disk, an alias, `curl` with a token, or a harness that does not
 * run Claude hooks walks past it. For Codex and OpenCode agents the backstop
 * is .github/workflows/hold-reason.yml, which flags a `hold` with no reason.
 *
 * It fails CLOSED when node cannot start (run-node-hook.sh) and OPEN when it
 * crashes on a payload, like its siblings.
 *
 * Fixtures: scripts/test-pr-create-guard.sh.
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

const PR_CREATE_MESSAGE = `Blocked: open pull requests with scripts/open-pr.sh, not gh pr create.

The script is the one place the rules for opening a PR live: the open-PR cap,
review:light or review:deep from the security paths, skip-changelog and
needs-design from the diff, the provenance line, and a hold only with a reason
(a hold with no reason left 19 PRs stuck for 9 hours on 2026-11-20).

Run this instead (push the branch first):

  scripts/open-pr.sh --title "<type>(<scope>): <summary>" --body-file <file> \\
    [--draft] [--hold "<reason>"] [--extra-label <label>] [--dry-run]

--dry-run prints the labels and the exact gh command without running it.
The guide: .agents/skills/creating-pull-requests/SKILL.md.`;

/** `gh api` options that consume the next token as their value. */
const API_OPTIONS_WITH_VALUE = new Set([
  '-X',
  '--method',
  '-H',
  '--header',
  '-f',
  '--raw-field',
  '-F',
  '--field',
  '--input',
  '-q',
  '--jq',
  '-t',
  '--template',
  '--hostname',
  '-p',
  '--preview',
  '--cache',
]);

/** `gh api` options that send a body, which makes gh default to POST. */
const API_BODY_OPTIONS = new Set(['-f', '--raw-field', '-F', '--field', '--input']);

/** `gh api` options whose value can carry a GraphQL query. */
const API_FIELD_OPTIONS = new Set(['-f', '--raw-field', '-F', '--field']);

/** The REST create endpoint: `[/]repos/<o>/<r>/pulls`, optional query string. */
const REST_CREATE_ENDPOINT = /(?:^|\/)pulls\/?(?:\?.*)?$/;

/** The GraphQL mutation that opens a pull request. */
const GRAPHQL_CREATE_MUTATION = /\bcreatePullRequest\b/;

/** gh flags that consume the next token when written without `=`. */
const GH_FLAGS_WITH_VALUE = new Set(['-R', '--repo', '--hostname']);

/** Words that run the rest of their arguments as a command (as merge-guard). */
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
  'ssh',
  'parallel',
]);

/** Commands that execute text fed to them on stdin or as their argument. */
const STDIN_SHELLS = new Set([
  'sh',
  'bash',
  'zsh',
  'dash',
  'ksh',
  'fish',
  'ssh',
  'eval',
  'source',
  '.',
]);

/**
 * Skip flags (and the value a `-R` style flag takes) to reach the next word.
 *
 * @param {string[]} tokens - Tokens to walk.
 * @returns {string[]} Tokens from the first word that is not a flag or its value.
 */
function skipFlags(tokens) {
  let index = 0;
  while (index < tokens.length && tokens[index].startsWith('-')) {
    index += GH_FLAGS_WITH_VALUE.has(tokens[index]) ? 2 : 1;
  }
  return tokens.slice(index);
}

/**
 * Decide whether a `gh api ...` invocation opens a pull request.
 *
 * @param {string[]} args - Arguments after `api`.
 * @returns {string | null} A refusal message, or null to allow.
 */
function checkApi(args) {
  let method = null;
  let sendsBody = false;
  const positionals = [];
  const fieldValues = [];

  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    if (arg === '-X' || arg === '--method') {
      method = args[index + 1] ?? null;
      index++;
      continue;
    }
    if (arg.startsWith('--method=')) {
      method = arg.slice('--method='.length);
      continue;
    }
    if (/^-X./.test(arg)) {
      method = arg.slice(2);
      continue;
    }
    if (API_BODY_OPTIONS.has(arg)) {
      sendsBody = true;
      if (API_FIELD_OPTIONS.has(arg)) fieldValues.push(args[index + 1] ?? '');
      index++;
      continue;
    }
    const equals = arg.indexOf('=');
    if (arg.startsWith('--') && equals !== -1) {
      const name = arg.slice(0, equals);
      if (API_BODY_OPTIONS.has(name)) sendsBody = true;
      if (API_FIELD_OPTIONS.has(name)) fieldValues.push(arg.slice(equals + 1));
      continue;
    }
    // Attached short values: `-ftitle=x`, `-Fbody=@f`.
    if (/^-[fF]./.test(arg)) {
      sendsBody = true;
      fieldValues.push(arg.slice(2));
      continue;
    }
    if (API_OPTIONS_WITH_VALUE.has(arg)) {
      index++;
      continue;
    }
    if (arg.startsWith('-')) continue;
    positionals.push(arg);
  }

  const [endpoint] = positionals;
  if (!endpoint) return null;

  if (endpoint === 'graphql') {
    return fieldValues.some((value) => GRAPHQL_CREATE_MUTATION.test(value))
      ? PR_CREATE_MESSAGE
      : null;
  }

  if (!REST_CREATE_ENDPOINT.test(endpoint)) return null;
  const effective = method ? method.toUpperCase() : sendsBody ? 'POST' : 'GET';
  return effective === 'POST' ? PR_CREATE_MESSAGE : null;
}

/**
 * Decide whether an already-tokenized command opens a pull request.
 *
 * @param {string[]} tokens - Tokens of one command, prefixes stripped.
 * @param {number} depth - Current unwrapping depth.
 * @returns {string | null} A refusal message, or null to allow.
 */
function inspectTokens(tokens, depth) {
  if (tokens.length === 0) return null;
  const name = basename(tokens[0]);

  if (RUNNERS.has(name) || /^-|=/.test(tokens[0])) {
    for (let k = 1; k < tokens.length; k++) {
      const refusal = inspectTokens(tokens.slice(k), depth);
      if (refusal) return refusal;
      if (depth < 2 && /\s/.test(tokens[k])) {
        const nested = inspectCommand(tokens[k], depth + 1, true);
        if (nested) return nested;
      }
    }
    return null;
  }

  if (name !== 'gh') return null;

  const [command, ...afterCommand] = skipFlags(tokens.slice(1));
  const [subcommand] = skipFlags(afterCommand);
  if (command === 'pr' && (subcommand === 'create' || subcommand === 'new')) {
    return PR_CREATE_MESSAGE;
  }
  if (command === 'api') return checkApi(afterCommand);
  return null;
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

  const wrapped = readWrappedCommand(segment);
  if (wrapped !== null) return depth < 2 ? inspectCommand(wrapped, depth + 1, true) : null;

  return inspectTokens(tokens, depth);
}

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
 * quoted heredoc body unless a shell executes it. Same reading as
 * merge-guard.mjs `commandSegments`, which explains each step.
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
function inspectCommand(command, depth = 0, strict = false) {
  if (!command) return null;

  const segments = commandSegments(command, strict);
  for (const segment of segments) {
    const refusal = inspectSegment(segment, depth);
    if (refusal) return refusal;
  }

  if (depth < 2 && segments.some(feedsAShell)) {
    for (const segment of segments) {
      for (const token of tokenize(segment)) {
        if (!/\s/.test(token)) continue;
        const refusal = inspectCommand(token, depth + 1, true);
        if (refusal) return refusal;
      }
    }
  }

  if (depth < 2) {
    for (const body of extractSubstitutions(command)) {
      const refusal = inspectCommand(body, depth + 1, strict);
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
    // Fail open: a guard that crashes must not block every bash command.
    console.error(`pr-create-guard error: ${error.message}`);
    process.exit(0);
  }
}

await main();
