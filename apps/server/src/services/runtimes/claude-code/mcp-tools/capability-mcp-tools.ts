/**
 * Project registry capabilities into in-session `dorkos` MCP tool definitions
 * (spec `capability-registry`, task 2.2).
 *
 * This is the Claude Agent SDK half of the MCP projection. The SDK builds its
 * server from a `tools` array passed to `createSdkMcpServer({ tools })` rather
 * than by mutating a server instance, so — unlike the external adapter's
 * `registerCapabilitiesAsMcpTools(server, registry)` — this returns the tool
 * definitions to spread into that array. The `tool()` helper carries no
 * annotations slot, so only names, descriptions, input shapes, and handlers are
 * projected; all the transport-neutral work lives in
 * `core/capabilities/mcp-projection.ts`.
 *
 * @module services/runtimes/claude-code/mcp-tools/capability-mcp-tools
 */
import { tool } from '@anthropic-ai/claude-agent-sdk';
import type { McpServerId } from '@dorkos/shared/capabilities';

import type {
  CapabilityInvocationContext,
  CapabilityRegistry,
} from '../../../core/capabilities/index.js';
import {
  capabilitiesForMcpServer,
  capabilityInputShape,
  invokeCapabilityAsMcpResult,
} from '../../../core/capabilities/mcp-projection.js';
import type {
  CapabilityApprovalHold,
  CapabilityHoldSession,
} from '../../../core/capabilities/capability-approval-hold.js';
import type { ApprovalService } from '../../../core/approvals/index.js';

/**
 * The in-session hold seam (DOR-939): the live session an inline approval card is
 * rendered into, plus the approval primitive the hold waits on. Absent on the
 * external `/mcp` surface and in tests, which then keep the token/poll flow.
 */
export interface InSessionCapabilityHold {
  /** The live session whose event queue carries the inline card. */
  session: CapabilityHoldSession;
  /** The approval primitive — reads the card and waits for the decision. */
  approvals: Pick<ApprovalService, 'awaitDecision' | 'getPending'>;
}

/**
 * Recover the SDK tool call's abort signal from the MCP handler's `extra`, so a
 * mid-turn interrupt ends any in-session hold. Typed `unknown` by the SDK, so it
 * is narrowed defensively — a surface without one simply holds to its own cap.
 */
function abortSignalOf(extra: unknown): AbortSignal | undefined {
  if (extra && typeof extra === 'object' && 'signal' in extra) {
    const signal = (extra as { signal?: unknown }).signal;
    if (signal instanceof AbortSignal) return signal;
  }
  return undefined;
}

/**
 * Build the in-session `dorkos` server tool definitions for every registry
 * capability advertised on the in-session surface.
 *
 * @param registry - The composed capability registry.
 * @param transport - Which server's tool surface to project (defaults to
 *   `in-session`).
 * @param resolveContext - Optional resolver for the invocation context, awaited
 *   per tool call. This surface has no request to read a token from, so the
 *   caller's identity is derived from the session instead (see
 *   `createInSessionContextResolver`); the resolver memoizes, so many tool calls
 *   in one session cost one lookup. Omitted in tests and introspection paths,
 *   which then invoke unattributed exactly as before.
 * @param hold - Optional in-session hold seam (DOR-939). When present, a fresh
 *   destructive ask HOLDS inline awaiting the operator's decision and resumes on a
 *   grant. Omitted on the external `/mcp` surface and in tests, which keep the
 *   token/poll flow. A per-call {@link CapabilityApprovalHold} is assembled from
 *   it plus the SDK abort signal on each invocation.
 * @returns SDK tool definitions to spread into `createSdkMcpServer({ tools })`.
 */
export function capabilityMcpTools(
  registry: CapabilityRegistry,
  transport: McpServerId = 'in-session',
  resolveContext?: () => Promise<CapabilityInvocationContext | undefined>,
  hold?: InSessionCapabilityHold
) {
  return capabilitiesForMcpServer(registry, transport).map((capability) =>
    tool(
      capability.surfaces.mcp!.toolName,
      capability.description,
      capabilityInputShape(capability),
      async (args: Record<string, unknown>, extra: unknown) => {
        const signal = abortSignalOf(extra);
        const perCall: CapabilityApprovalHold | undefined = hold
          ? {
              approvals: hold.approvals,
              session: hold.session,
              ...(signal ? { signal } : {}),
            }
          : undefined;
        return invokeCapabilityAsMcpResult(
          registry,
          capability.id,
          args,
          await resolveContext?.(),
          perCall
        );
      }
    )
  );
}
