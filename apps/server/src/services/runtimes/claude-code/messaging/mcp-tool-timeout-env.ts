/**
 * Keep an inherited `MCP_TOOL_TIMEOUT` from cutting an in-session approval hold
 * short (DOR-987).
 *
 * The turn's SDK subprocess inherits the whole of `process.env` (see the env
 * block in `message-sender.ts`). `MCP_TOOL_TIMEOUT` is a supported claude CLI
 * variable — a hard wall-clock limit per MCP tool call, defaulting to ~27.8h —
 * and an operator has a real reason to lower it: a flaky external MCP server
 * that hangs. Lowered below the hold cap, it would kill every held destructive
 * call mid-wait and return an ERROR to the model, which is strictly worse than
 * the poll flow the hold replaced. That is the one outcome the whole feature is
 * written to avoid.
 *
 * So the value is FLOORED rather than honored or erased:
 *
 * - Below the floor, it is raised to it. The operator's shorter limit is lost,
 *   which is the tradeoff: the variable is global to every MCP server in the
 *   subprocess, so there is no way to keep it for their flaky external server
 *   without also applying it to the in-session `dorkos` server the hold rides.
 *   Between "an external tool hangs longer than asked" and "every approval a
 *   person takes a minute to answer fails", the first is the recoverable one.
 * - At or above the floor, it passes through untouched.
 * - Absent, unparseable, or below the CLI's own 1000ms minimum (which the CLI
 *   ignores, falling back to its ~27.8h default), nothing is written — the
 *   subprocess keeps exactly what it would have had.
 *
 * @module services/runtimes/claude-code/messaging/mcp-tool-timeout-env
 */
import { CAPABILITY_APPROVAL_HOLD_CAP_MS } from '../../../core/capabilities/capability-approval-hold.js';
import { CAPABILITY_HOLD_PAUSE_GRACE_MS } from '../../../session/session-state-projector.js';
import { logger } from '../../../../lib/logger.js';

/** The env var the claude CLI reads as its per-call MCP tool timeout. */
const MCP_TOOL_TIMEOUT = 'MCP_TOOL_TIMEOUT';

/**
 * Values below this are IGNORED by the CLI (documented on the per-server
 * `timeout` option: "values below 1000ms are ignored"), so they fall through to
 * its own default and cannot shorten a hold.
 */
const CLI_MIN_TOOL_TIMEOUT_MS = 1_000;

/**
 * The shortest per-call MCP timeout a held approval can survive: the hold's own
 * cap plus the grace, which leaves the post-grant re-invoke (consume + the real
 * capability call) inside the same tool call.
 */
export const MCP_TOOL_TIMEOUT_FLOOR_MS =
  CAPABILITY_APPROVAL_HOLD_CAP_MS + CAPABILITY_HOLD_PAUSE_GRACE_MS;

/**
 * The `MCP_TOOL_TIMEOUT` override to spread into the SDK subprocess env, after
 * the inherited `process.env`.
 *
 * @param env - The environment to read (defaults to this process's).
 * @returns A one-key override when the inherited value would cut a hold short,
 *   or an empty object when there is nothing to correct.
 */
export function mcpToolTimeoutFloorEnv(
  // eslint-disable-next-line no-restricted-syntax -- MCP_TOOL_TIMEOUT is the claude CLI's own variable, not a DorkOS config value env.ts models (same rationale as claude-config-dir.ts)
  env: NodeJS.ProcessEnv = process.env
): Record<string, string> {
  const raw = env[MCP_TOOL_TIMEOUT];
  if (raw === undefined) return {};
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) return {};
  if (parsed < CLI_MIN_TOOL_TIMEOUT_MS || parsed >= MCP_TOOL_TIMEOUT_FLOOR_MS) return {};
  logger.warn(
    '[sendMessage] raising an inherited MCP_TOOL_TIMEOUT that would cut approvals short',
    {
      inherited: parsed,
      using: MCP_TOOL_TIMEOUT_FLOOR_MS,
    }
  );
  return { [MCP_TOOL_TIMEOUT]: String(MCP_TOOL_TIMEOUT_FLOOR_MS) };
}
