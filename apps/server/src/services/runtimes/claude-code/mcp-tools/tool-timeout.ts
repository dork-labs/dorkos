/**
 * How long one call to a DorkOS in-session MCP tool may run before the CLI
 * gives up on it (DOR-987, moved off the environment at SDK 0.3.248).
 *
 * TWO calls here legitimately run for minutes, and the ceiling has to clear
 * each or it truncates one of them:
 *
 * - A destructive capability that HOLDS, rendering an inline approval card and
 *   waiting for a person to answer it. A ceiling shorter than the hold kills the
 *   held call mid-wait and hands the model an ERROR where the poll payload used
 *   to be — strictly worse than the flow the hold replaced, and the one outcome
 *   that feature is written to avoid.
 * - An agent's access request (`connectors.request_connection`, which rides
 *   this server in Claude Code), held open for the person's answer for
 *   `CONNECTOR_REQUEST_LIVE_HOLD_MS`.
 *
 * So the value is DERIVED from both budgets by name, never chosen: the larger of
 * the two, plus the grace the projector already keeps past the hold — which
 * leaves the post-grant re-invoke (consume + the real capability call) inside the
 * same tool call, and doubles as slack for whichever budget is the larger one.
 * Raise either budget and the ceiling rises with it.
 *
 * **Why it is a per-server option and no longer an environment floor.** Until
 * 0.3.248 the only lever was `MCP_TOOL_TIMEOUT`, which the CLI applies to EVERY
 * MCP server in the subprocess. DorkOS raised an inherited value to this floor,
 * and that rewrite cost the operator the thing they had set it for: the variable
 * is lowered to cut off a flaky EXTERNAL server that hangs, and there was no way
 * to keep it for that server without also cutting the hold. `createSdkMcpServer`
 * now takes a timeout of its own, so the `dorkos` server states its bound
 * directly and an operator's `MCP_TOOL_TIMEOUT` reaches their own servers
 * untouched. The floor is gone rather than kept beside this, because a rewrite
 * of somebody else's setting that protects nothing is not a belt — it is just a
 * setting nobody can use.
 *
 * @module services/runtimes/claude-code/mcp-tools/tool-timeout
 */
import { CAPABILITY_APPROVAL_HOLD_CAP_MS } from '../../../core/capabilities/capability-approval-hold.js';
import { CAPABILITY_HOLD_PAUSE_GRACE_MS } from '../../../session/session-state-projector.js';
import { CONNECTOR_REQUEST_LIVE_HOLD_MS } from '../../../connectors/runtime-capability-scope.js';

/**
 * The per-call ceiling declared on the in-session `dorkos` MCP server: the
 * longest a legitimate DorkOS tool call can take, which is the largest of the
 * minutes-long budgets above plus the projector's grace.
 *
 * Comfortably above the SDK's 1000ms floor, below which a per-server timeout is
 * ignored and the server would silently fall back to `MCP_TOOL_TIMEOUT`.
 */
export const DORKOS_MCP_TOOL_TIMEOUT_MS =
  Math.max(CAPABILITY_APPROVAL_HOLD_CAP_MS, CONNECTOR_REQUEST_LIVE_HOLD_MS) +
  CAPABILITY_HOLD_PAUSE_GRACE_MS;
