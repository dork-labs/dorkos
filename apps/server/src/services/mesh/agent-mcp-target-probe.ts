/**
 * The port {@link AgentMcpOAuthService} dials a signed-in server through, and the
 * two rules for reading its answer (DOR-1003).
 *
 * Split out of `agent-mcp-oauth-service.ts` for the same reason
 * `agent-mcp-token-refresher.ts` was: the engine file owns the OAuth lifecycle,
 * and this is a small, self-contained question asked of something outside it.
 *
 * It is a PORT rather than an import because the thing that can answer it —
 * `AgentMcpServerService.test` — is constructed with the OAuth engine as its own
 * token provider. Injecting the call keeps that edge at boot instead of turning
 * it into a cycle between two services.
 *
 * @module services/mesh/agent-mcp-target-probe
 */
import type { Logger } from '@dorkos/shared/logger';

/** One `(agentId, serverName, serverUrl)` OAuth target — the shape a probe is asked about. */
export interface McpProbeTarget {
  /** The agent whose manifest owns the server. */
  agentId: string;
  /** The managed server's name (unique within the agent). */
  serverName: string;
  /** The MCP server URL the OAuth flow authorizes against. */
  serverUrl: string;
}

/**
 * What one dial of a signed-in target found — structurally what
 * `AgentMcpServerService.test` returns, which is what boot wires in.
 *
 * Two questions at once, and both matter: how many tools the operator just
 * unlocked (the payoff), and whether the token DorkOS holds is actually accepted
 * (the honesty check behind `alreadyConnected`).
 */
export interface McpTargetProbeResult {
  /** Whether the server connected and listed its tools. */
  ok: boolean;
  /** How many tools it exposes, when reachable. */
  toolCount?: number;
  /** True when the server answered 401 — the held token does not work. */
  needsAuth?: boolean;
}

/** Dial a target with whatever credentials DorkOS currently holds for it. */
export type McpTargetProbe = (target: McpProbeTarget) => Promise<McpTargetProbeResult>;

/**
 * Run a probe if one is wired, and never let it throw.
 *
 * "No answer" and "no probe" collapse to the same `undefined` on purpose: both
 * mean DorkOS has no opinion, and every caller treats no opinion as "carry on".
 * That is what keeps a flaky second round trip from turning a sign-in that
 * genuinely succeeded into a reported failure.
 *
 * @param probe - The injected probe, or `undefined` when none is wired.
 * @param target - The agent, server, and server URL to dial.
 * @param logger - Diagnostic sink for a probe that threw.
 */
export async function probeTarget(
  probe: McpTargetProbe | undefined,
  target: McpProbeTarget,
  logger: Pick<Logger, 'warn'>
): Promise<McpTargetProbeResult | undefined> {
  if (!probe) return undefined;
  try {
    return await probe(target);
  } catch (err) {
    logger.warn(
      `[mcp-oauth] could not probe ${target.serverName}: ${err instanceof Error ? err.message : String(err)}`
    );
    return undefined;
  }
}

/**
 * The tool count a probe result is allowed to publish, or `undefined`.
 *
 * A count only counts when the server actually answered: a failed probe that
 * happened to carry a number would otherwise publish it as the payoff. Absent is
 * "not counted", never zero — which is why the poll reports the connection
 * either way.
 *
 * @param result - The probe result, or `undefined` when there was no answer.
 */
export function toolCountFrom(result: McpTargetProbeResult | undefined): number | undefined {
  return result?.ok ? result.toolCount : undefined;
}

/**
 * Whether a probe positively said the held credential is refused.
 *
 * Deliberately not "anything other than ok": an unreachable server is not a
 * revoked sign-in, and treating it as one would throw away a working token every
 * time the network hiccupped.
 *
 * @param result - The probe result, or `undefined` when there was no answer.
 */
export function tokenWasRefused(result: McpTargetProbeResult | undefined): boolean {
  return result?.needsAuth === true;
}
