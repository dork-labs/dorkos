/**
 * The plain-data ↔ MCP-envelope seam for capabilities that wrap a phase-1
 * descriptor handler (spec `capability-registry`, task 2.2).
 *
 * The self-service and marketplace domains migrated onto the registry keep their
 * existing transport-neutral handlers (`operator-tool-handlers.ts`, the
 * marketplace `tool-*.ts` files), which return the MCP text-content envelope
 * `{ content: [{ type: 'text', text: JSON.stringify(payload) }], isError? }`.
 * The registry's `invoke`, by contract, returns PLAIN typed data — never an
 * envelope (see `capability-definition.ts`). {@link unwrapMcpEnvelope} bridges
 * the two: it parses a handler's envelope back to its plain JSON payload so a
 * capability's `invoke` can return that payload, and it re-raises the handler's
 * `isError` path as a {@link CapabilityToolError} so the transport adapter can
 * reproduce the exact `isError` envelope on the wire.
 *
 * This module is transport-neutral (no MCP SDK import): the domains call
 * {@link unwrapMcpEnvelope} from inside `invoke`, and the two MCP adapters
 * (`mcp-projection.ts` and the in-session/external glue) re-wrap the plain
 * result — or catch a {@link CapabilityToolError} — back into an envelope.
 *
 * @module services/core/capabilities/mcp-envelope
 */

/**
 * The MCP text-content envelope a phase-1 descriptor handler returns: one or
 * more text blocks carrying the JSON-encoded payload, plus an optional
 * `isError` flag set on failure paths.
 */
export interface McpTextEnvelope {
  /** One or more text blocks carrying the JSON-encoded payload. */
  content: { type: 'text'; text: string }[];
  /** Set by the handler on failure paths. */
  isError?: boolean;
}

/**
 * A capability handler outcome that must surface to the MCP client as an
 * `isError` result. Carries the plain payload the handler produced (already the
 * structured `{ error, code, ... }` shape) so the transport adapter re-wraps it
 * verbatim.
 *
 * A capability's `invoke` throws this (via {@link unwrapMcpEnvelope}) instead of
 * returning it, so the registry's plain-data contract holds while the exact
 * error payload and the `isError` flag are preserved for the wire.
 */
export class CapabilityToolError extends Error {
  /**
   * @param payload - The plain error payload the handler produced.
   */
  constructor(public readonly payload: unknown) {
    super('Capability invocation returned an error result.');
    this.name = 'CapabilityToolError';
  }
}

/**
 * Unwrap a phase-1 handler's MCP text envelope to its plain JSON payload.
 *
 * Parses the first text block back to the value the handler serialized. When
 * the envelope is flagged `isError`, throws a {@link CapabilityToolError}
 * carrying that payload so the transport adapter reproduces the `isError`
 * envelope; otherwise returns the payload for the capability's `invoke` to hand
 * back as plain data.
 *
 * @param envelope - The handler's MCP text-content result.
 * @returns The plain JSON payload (success path).
 * @throws {CapabilityToolError} When the envelope is flagged `isError`.
 */
export function unwrapMcpEnvelope(envelope: McpTextEnvelope): unknown {
  const payload = JSON.parse(envelope.content[0].text) as unknown;
  if (envelope.isError) {
    throw new CapabilityToolError(payload);
  }
  return payload;
}
