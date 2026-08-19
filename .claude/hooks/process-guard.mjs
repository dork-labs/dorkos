#!/usr/bin/env node
/**
 * Process Guard Hook
 *
 * PreToolUse(Bash) guard that refuses the process-killing commands that take
 * down processes the caller does not own, and explains what to do instead.
 *
 * WHY THIS IS CODE AND NOT PROSE
 *
 * On 2026-08-18 an agent tearing down its own verification cockpit ran
 * `pkill -f "tsx src/index.ts"`. That pattern also matched the operator's own
 * dev server (`pnpm dev`, port 6242, up ~7 h) and killed it. Nothing was lost,
 * but nothing had told the agent not to, and nothing had stopped it. This
 * repo routinely has several agents and the operator's own servers alive on
 * one machine (`pnpm dev` on 6xxx, the dogfood cockpit on 4242, per-worktree
 * cockpits on 43xx–45xx), all built from the same source tree — so any kill
 * that matches on a NAME rather than a specific PID is a kill of everyone's
 * process at once.
 *
 * WHAT IT BLOCKS
 *   - `pkill ...` in every form. It kills by name/pattern; there is no way to
 *     spell "only mine".
 *   - `killall ...` — same reason.
 *   - `kill` aimed at everything or a process group: `kill -9 -1`, `kill -1`,
 *     `kill 0`, `kill -- -1`, `kill -TERM -<pgid>`. A negative or zero target
 *     is never one process.
 *
 * WHAT IT DELIBERATELY ALLOWS
 *   - `kill <pid> [<pid>...]`, `kill -TERM <pid>`, `kill -9 <pid>`, `kill %1`
 *     — a specific process (or shell job) the caller can name is one it had
 *     to look at first.
 *   - `pgrep ...` — read-only. It is the way to find the PID you own.
 *   - `kill -l`, `kill -L` — lists signals.
 *
 * HOW TO STOP YOUR OWN PROCESS
 *   - Prefer the handle you already have: the PID of the process you started
 *     (`$!`, or the id the Bash tool gave you), or `TaskStop` for a
 *     background task.
 *   - Otherwise find it by the port YOU chose: `lsof -ti :<your port>` (or
 *     `pgrep -lf <pattern>` and read the list), then `kill <that pid>`. Never
 *     kill a process you did not start.
 *
 * WHY THIS IS A HOOK AND NOT `permissions.deny`
 *
 * `Bash(pkill:*)` would work for the bare spelling but, as measured for
 * git-guard, the native prefix matcher does not see `sh -c "pkill ..."`,
 * `$(pkill ...)`, or `cd x && pkill ...` in the general case, and `kill` needs
 * an argument-level rule (block `-1`/`0`, allow `<pid>`) that a prefix matcher
 * cannot express.
 *
 * COVERAGE THIS DOES NOT HAVE (stated plainly, on purpose)
 *
 * It stops the reflex, not a determined bypass. It reads the command string
 * the model submits, so it does not see a kill inside a script on disk, an
 * alias, `eval "$VAR"`, `xargs kill` fed by `pgrep` (that is the
 * documented allowed path — the caller had to read the list — so it is left
 * alone on purpose), or substitutions nested more than one level deep. If you
 * find another hole, add it here even if you do not fix it.
 *
 * Fixtures: scripts/test-process-guard.sh runs every block/allow case through
 * this file's real entry point (a PreToolUse payload on stdin, exit 2 to
 * block).
 */

import path from 'path';
import {
  SHELL_WRAPPERS,
  splitSegments,
  extractSubstitutions,
  tokenize,
  stripCommandPrefixes,
} from './lib/shell-command.mjs';

const { basename } = path;

/** Commands that can only kill by name or pattern. */
const KILL_BY_NAME = new Set(['pkill', 'killall']);

/** `kill` options that consume the next token as their value. */
const KILL_OPTIONS_WITH_VALUE = new Set(['-s', '--signal', '-n']);

/** `kill` options that only print and never signal. */
const KILL_LISTING_FLAGS = new Set(['-l', '-L', '--list', '--table']);

const NAME_MESSAGE = `Blocked: pkill / killall kill by name, and every DorkOS process on this machine shares the same names.
On 2026-08-18 \`pkill -f "tsx src/index.ts"\` meant to stop one verification cockpit also killed the operator's dev server (:6242) — and other agents' worktree cockpits (43xx–45xx) and the dogfood cockpit (:4242) are built from the same source.
Stop the process YOU started, by its PID: the id you already have (\`$!\`, the Bash tool's background id, or TaskStop for a background task), or \`lsof -ti :<your port>\` / \`pgrep -lf <pattern>\` to look first, then \`kill <pid>\`. Never kill a process you did not start.`;

const GROUP_MESSAGE = `Blocked: kill aimed at every process or a whole process group (a negative or zero target).
That signals processes you do not own — other agents' cockpits and the operator's servers included.
Name the one PID you started instead: \`kill <pid>\`; find it with \`lsof -ti :<your port>\` or \`pgrep -lf <pattern>\` if you have lost the handle.`;

/**
 * Decide whether a `kill` invocation targets a group or everything.
 *
 * `kill` accepts `-<signal>`, `-s <sig>`, `--signal <sig>`, `-n <num>`, and
 * `--` before its targets. A target of `0` (own process group) or any negative
 * number (`-1` = everything, `-<pgid>` = that group) is never one process. The
 * ambiguity is `-1`: as an option it is SIGHUP (`kill -1 <pid>`), as a target
 * it is "everything". Resolve it the way kill does — a leading `-<digits>` is a
 * signal when ANY further token follows it (`kill -1 12345`), and a target when
 * it stands alone, comes after `--`, or comes after another signal option. The
 * check does not require the following token to be positive on purpose: if it
 * is itself negative or zero (`kill -9 -1`) it lands in `targets` and the group
 * test below catches it anyway, so `-9` being read as a signal there is
 * harmless.
 *
 * @param {string[]} args - Tokens after the `kill` word.
 * @returns {string | null} A refusal message, or null to allow.
 */
function checkKill(args) {
  if (args.length === 0) return null;
  if (args.some((arg) => KILL_LISTING_FLAGS.has(arg))) return null;

  const targets = [];
  let signalSeen = false;
  let index = 0;
  let pastOptions = false;

  while (index < args.length) {
    const arg = args[index];
    if (!pastOptions) {
      if (arg === '--') {
        pastOptions = true;
        index++;
        continue;
      }
      if (KILL_OPTIONS_WITH_VALUE.has(arg)) {
        signalSeen = true;
        index += 2;
        continue;
      }
      if (arg.startsWith('--signal=')) {
        signalSeen = true;
        index++;
        continue;
      }
      // `-TERM`, `-KILL`, `-SIGTERM`: a named signal.
      if (/^-[A-Za-z]/.test(arg)) {
        signalSeen = true;
        index++;
        continue;
      }
      // `-9`, `-1`: a numeric signal — unless nothing positive follows and no
      // signal was already given, in which case kill treats it as the target.
      if (/^-\d+$/.test(arg) && !signalSeen) {
        const rest = args.slice(index + 1).filter((t) => t !== '--');
        if (rest.length > 0) {
          signalSeen = true;
          index++;
          continue;
        }
      }
    }
    targets.push(arg);
    index++;
  }

  const groupTarget = targets.some((target) => /^-\d+$/.test(target) || target === '0');
  return groupTarget ? GROUP_MESSAGE : null;
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

  if (KILL_BY_NAME.has(name)) return NAME_MESSAGE;
  if (name === 'kill') return checkKill(tokens.slice(1));
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
    // fixture suite in scripts/test-process-guard.sh is what keeps this honest.
    console.error(`process-guard error: ${error.message}`);
    process.exit(0);
  }
}

await main();
