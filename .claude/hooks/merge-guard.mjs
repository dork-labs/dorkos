#!/usr/bin/env node
/**
 * Merge Guard Hook
 *
 * PreToolUse(Bash) guard that refuses the merge spellings which step around
 * the merge queue on an admin account, and explains what to do instead.
 *
 * WHY THIS IS CODE AND NOT PROSE
 *
 * Merges into `main` are fully autonomous (ADR "Merges are fully autonomous;
 * machine gates are the only gates"): no human approves anything, so the
 * required checks the merge queue runs are the only thing between an agent and
 * `main`. Every agent on this machine runs as the operator's GitHub account,
 * which holds the admin role, and ruleset 19893973 lets that role bypass the
 * ruleset when it merges a pull request. So one command, typed out of
 * impatience with a slow queue, lands code no required check ever ran against.
 * A sentence in a skill does not hold that line; this guard is the reflex stop.
 *
 * WHAT IT BLOCKS
 *   - `gh pr merge ... --admin` (also `--admin=true`), in any argument order.
 *     gh documents `--admin` as "use administrator privileges to merge a pull
 *     request that does not meet requirements".
 *   - `gh api` with method PUT on `.../pulls/<n>/merge`: the REST merge
 *     endpoint, which merges immediately and never enters the queue. Every
 *     spelling of the method: `-X PUT`, `-XPUT`, `--method PUT`,
 *     `--method=PUT`, any case.
 *   - `gh api graphql` whose query names the `mergePullRequest` mutation, which
 *     is the same direct merge through GraphQL (and what `gh pr merge --admin`
 *     sends).
 *
 * WHAT IT DELIBERATELY ALLOWS
 *   - `gh pr merge --auto <n>` (with or without a strategy flag) and a plain
 *     `gh pr merge <n>`: on a branch with a merge queue both add the pull
 *     request to the queue, so every required check still runs.
 *   - `gh pr merge --disable-auto <n>`.
 *   - `gh api .../pulls/<n>/merge` with no method (GET: "has it merged?").
 *   - Any other `gh api` PUT, and any GraphQL query or mutation that is not
 *     `mergePullRequest` (the `dequeuePullRequest` recipe in the
 *     creating-pull-requests skill included).
 *   - Text that merely names these commands: a commit message, a PR body, an
 *     `echo`, a `grep` for them. Only a segment whose command word is `gh`
 *     is read, so prose inside another command's arguments never matches.
 *
 * WHERE THE REAL PATH IS
 *
 * An admin merge is reserved for the break-glass path of CI Steward phase 1b
 * (`/ci:break-glass`), which does not exist yet. Until it does, no agent has a
 * sanctioned admin merge at all. The guide is `contributing/ci.md`.
 *
 * WHY THIS IS A HOOK AND NOT `permissions.deny`
 *
 * The policy is argument-level ("`gh pr merge` yes, with `--admin` no";
 * "`gh api` yes, PUT to one endpoint no"), and a prefix matcher cannot express
 * an exception to its own prefix. Measured for git-guard: the native matcher
 * also misses `sh -c` payloads and substitutions.
 *
 * COVERAGE THIS DOES NOT HAVE (stated plainly, on purpose)
 *
 * This is the paved road, not the fence. Every agent here runs as the admin
 * account, and anything that does not show the command text to this hook
 * walks past it:
 *   - a merge inside a script on disk, an alias, a shell function, or
 *     `eval "$VAR"`;
 *   - `curl` (or any HTTP client) with a token from `gh auth token`;
 *   - a GraphQL query read from a file (`gh api graphql -F query=@merge.graphql`);
 *   - any harness that does not run this hook. Codex reads the generated,
 *     gitignored, trust-gated `.codex/hooks.json` that `dorkos harness sync`
 *     writes from settings.json; whether its tool payload ever reaches this
 *     guard is unverified, so treat it as unguarded;
 *   - substitutions nested more than one level deep (the shared parser's
 *     limit, see lib/shell-command.mjs).
 * The fence is server-side and arrives in phase 1b: a detector for any commit
 * on `main` with no merge-queue provenance, and an automatic revert. If you
 * find another hole, add it here even if you do not fix it.
 *
 * THE MATCHER SEES COMMAND TEXT AND NOTHING ELSE. Outside the text-taker
 * exemption in lib/shell-command.mjs, a line that runs one of these commands
 * inside a substitution is refused whether or not it would have run. When you
 * need to write the words, use the Write tool or a payload file on disk.
 *
 * It fails CLOSED when it cannot start: settings.json runs it through
 * .claude/hooks/run-node-hook.sh, which refuses the tool call (exit 2) when
 * node cannot be resolved (DOR-2121). It fails OPEN when it crashes on a
 * payload, like its siblings, so a parser bug cannot block every Bash call.
 *
 * Fixtures: scripts/test-merge-guard.sh runs every block/allow case through
 * this file's real entry point (a PreToolUse payload on stdin, exit 2 to
 * block); scripts/test-run-node-hook.sh covers the fail-closed wrapper.
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

/** `gh api` options whose value can carry a GraphQL query. */
const API_FIELD_OPTIONS = new Set(['-f', '--raw-field', '-F', '--field']);

/** The REST merge endpoint: `[/]repos/<o>/<r>/pulls/<n>/merge`, optional query string. */
const REST_MERGE_ENDPOINT = /(?:^|\/)pulls\/[^/\s]+\/merge\/?(?:\?.*)?$/;

/** The GraphQL mutation that merges a pull request directly. */
const GRAPHQL_MERGE_MUTATION = /\bmergePullRequest\b/;

const ADMIN_MERGE_MESSAGE = `Blocked: an admin merge skips the merge queue.

Merges into main are fully autonomous, so the required checks the queue runs
are the only thing standing between a change and main. Your gh account is an
admin, and --admin (or the REST merge endpoint, or the mergePullRequest
mutation) lands the change without any of those checks.

Admin merges are reserved for the CI Steward break-glass path (/ci:break-glass,
phase 1b, not built yet). Until it exists, no agent has a sanctioned admin
merge.

Do this instead: gh pr merge --auto <number>, or let merge-tail arm the PR
within about 10 minutes. If the queue itself is broken, say so and leave the
PR alone. The guide: contributing/ci.md.`;

/**
 * Split gh's leading global words from the command and its arguments.
 *
 * @param {string[]} tokens - Tokens after the `gh` word.
 * @returns {string[]} Tokens starting at the first non-flag word.
 */
function skipLeadingFlags(tokens) {
  let index = 0;
  while (index < tokens.length && tokens[index].startsWith('-')) index++;
  return tokens.slice(index);
}

/**
 * Decide whether a `gh pr merge ...` invocation asks for administrator privileges.
 *
 * @param {string[]} args - Arguments after `merge`.
 * @returns {string | null} A refusal message, or null to allow.
 */
function checkPrMerge(args) {
  const admin = args.some(
    (arg) => arg === '--admin' || (arg.startsWith('--admin=') && arg !== '--admin=false')
  );
  return admin ? ADMIN_MERGE_MESSAGE : null;
}

/**
 * Decide whether a `gh api ...` invocation merges a pull request directly.
 *
 * @param {string[]} args - Arguments after `api`.
 * @returns {string | null} A refusal message, or null to allow.
 */
function checkApi(args) {
  let method = null;
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
    if (API_FIELD_OPTIONS.has(arg)) {
      fieldValues.push(args[index + 1] ?? '');
      index++;
      continue;
    }
    const equals = arg.indexOf('=');
    if (arg.startsWith('--') && equals !== -1) {
      if (API_FIELD_OPTIONS.has(arg.slice(0, equals))) fieldValues.push(arg.slice(equals + 1));
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
    return fieldValues.some((value) => GRAPHQL_MERGE_MUTATION.test(value))
      ? ADMIN_MERGE_MESSAGE
      : null;
  }

  if (method?.toUpperCase() === 'PUT' && REST_MERGE_ENDPOINT.test(endpoint)) {
    return ADMIN_MERGE_MESSAGE;
  }
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
  if (wrapped !== null) return depth < 2 ? inspectCommand(wrapped, depth + 1) : null;

  if (basename(tokens[0]) !== 'gh') return null;

  const [command, subcommand, ...rest] = skipLeadingFlags(tokens.slice(1));
  if (command === 'pr' && subcommand === 'merge') return checkPrMerge(rest);
  if (command === 'api') return checkApi(subcommand === undefined ? [] : [subcommand, ...rest]);
  return null;
}

/** Shell operators that end one command, longest first. */
const SEGMENT_OPERATORS = ['&&', '||', '|&', ';', '|', '&', '\n'];

/**
 * Split a command line into the commands it runs, leaving out the lines of a
 * quoted heredoc body.
 *
 * A heredoc body is data to bash, never a command, but `splitSegments` breaks
 * on every newline, so a line reading `gh pr merge --admin 12` inside
 * `cat > notes.md <<'EOF'` would be refused as if it ran. This guard is about
 * a command people write ABOUT constantly (docs, PR bodies, this file), so it
 * reads the body as what it is. It only does that when
 * `maskUnexpandedText` vouches for the line: that reader blanks exactly the
 * quoted heredoc bodies and single-quoted strings, keeps every index, and
 * returns null for anything it does not model. The split runs over the masked
 * copy (so a body line is blank and drops out) and each segment is then cut
 * from the ORIGINAL text, so a single-quoted argument keeps its real content.
 * When the reader returns null, this is exactly `splitSegments`: the strict
 * reading its siblings use. An UNQUOTED heredoc body is left visible (the
 * reader does not blank it, because its substitutions are live), so a body
 * line there that starts with an admin merge is still refused: a false
 * positive, and the cheaper direction to be wrong in.
 *
 * @param {string} command - Raw command line.
 * @returns {string[]} Non-empty, trimmed command segments.
 */
function commandSegments(command) {
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
  return segments;
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

  for (const segment of commandSegments(command)) {
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
    // fixture suite in scripts/test-merge-guard.sh is what keeps this honest.
    console.error(`merge-guard error: ${error.message}`);
    process.exit(0);
  }
}

await main();
