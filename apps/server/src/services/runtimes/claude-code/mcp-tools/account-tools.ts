/**
 * MCP tools about the Claude (and other runtimes') accounts DorkOS runs work
 * on: `accounts_usage`, how much of each account is used (spec
 * `claude-account-fleet` D2), and `accounts_probe`, which reads one idle Claude
 * account's usage without running a turn (D3).
 *
 * The single source for the tool's name, description and input schema on BOTH
 * MCP servers: the external `/mcp` server projects these through
 * `registerFromDefinitions` (see `core/external-mcp/account-tools.ts`).
 *
 * @module services/runtimes/claude-code/mcp-tools/account-tools
 */
import { tool } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import {
  AccountUsageUnavailableError,
  probeAccount,
  UnknownAccountError,
} from '../accounts/account-probe.js';
import { getAccountUsageStore } from '../../../core/usage/current-usage-store.js';
import type { McpToolDeps } from './types.js';
import { jsonContent, structuredJsonContent } from './types.js';
import { hasMarks } from '../../../core/turn-power/turn-marks.js';
import { marksOf } from '../../../core/turn-power/turn-levels.js';
import type { TaskProvenanceResolver } from './task-tools.js';

/**
 * Refused in a turn that read words DorkOS cannot vouch for (a stranger's line
 * in a room, a teammate's), ceiling or not (Security on #3201, DOR-3289): the
 * answer carries account ids, plan, credits and spend, and the turn could post
 * it where the stranger reads. Read from the turn's own marks (`marksOf`).
 */
const MARKED_TURN_REFUSAL = {
  error: 'This turn read words from outside your team, so it can’t read account usage.',
  code: 'MARKED_TURN',
};

/** Whether the calling turn is marked, when a session is known. */
function callerIsMarked(resolveProvenance: TaskProvenanceResolver | undefined): boolean {
  if (!resolveProvenance) return false;
  const p = resolveProvenance();
  return hasMarks(marksOf(p.sessionId, p.agentPath));
}

/**
 * Handler for `accounts_usage`: every account of every runtime, from the usage
 * store's memory. A window with no current reading is left out, and an account
 * with nothing to go on reads `unknown`, never zero.
 *
 * @param marked - Whether the calling turn is marked (refused when it is).
 */
export async function handleAccountsUsage(marked = false) {
  if (marked) return jsonContent(MARKED_TURN_REFUSAL, true);
  const store = getAccountUsageStore();
  if (!store) return jsonContent({ error: 'Account usage is not available yet.' }, true);
  return structuredJsonContent({ accounts: store.list() });
}

/**
 * Handler for `accounts_probe`: read one Claude account's usage by booting the
 * CLI on an idle prompt, with no turn. An unknown id is an error; a probe that
 * could not read anything says so in `probe` and records nothing.
 *
 * @param args - The tool input.
 * @param args.account - A registry id, or `default`.
 * @param marked - Whether the calling turn is marked (refused when it is).
 */
export async function handleAccountsProbe(args: { account: string }, marked = false) {
  if (marked) return jsonContent(MARKED_TURN_REFUSAL, true);
  try {
    return jsonContent(await probeAccount(args.account));
  } catch (err) {
    if (err instanceof UnknownAccountError || err instanceof AccountUsageUnavailableError) {
      return jsonContent({ error: err.message }, true);
    }
    throw err;
  }
}

/**
 * The account tool definitions.
 *
 * @param _deps - Shared MCP tool dependencies (unused: the store is process-wide).
 * @param resolveProvenance - The calling session and agent, in a session; absent
 *   on the sessionless external server, which has no turn to be marked.
 */
export function getAccountTools(_deps: McpToolDeps, resolveProvenance?: TaskProvenanceResolver) {
  return [
    tool(
      'accounts_usage',
      "Read how much of each account DorkOS runs work on is used: every runtime's accounts " +
        "(registered ones, plus this computer's own sign-in as `default` when it is not " +
        'registered), each with its usage windows (used percent, reset time, status), a state ' +
        '(ok, warning, limited, unknown) and the window that limited it, if any. From memory, ' +
        'so it is cheap. Unknown is never reported as 0%.',
      {},
      () => handleAccountsUsage(callerIsMarked(resolveProvenance))
    ),
    tool(
      'accounts_probe',
      "Check one Claude account's usage without running a turn: starts Claude Code on that " +
        "account's own folder with nothing to answer, asks it for its usage, and closes it, so " +
        'nothing is billed and no transcript is left. Use it for an account that reads unknown ' +
        '(nobody has worked on it lately). Returns the account (as the account usage tool lists it) ' +
        'and `probe`: ok (new readings recorded), unavailable (the account runs on an API key ' +
        'or a cloud platform, not a Claude plan, so it has no plan limits), failed (nothing recorded, with a reason) or throttled ' +
        '(an account is probed at most once a minute).',
      {
        account: z
          .string()
          .min(1)
          .describe(
            "The account's id, as the account usage tool lists it, or `default` for this computer's sign-in."
          ),
      },
      (args) => handleAccountsProbe(args, callerIsMarked(resolveProvenance))
    ),
  ];
}
