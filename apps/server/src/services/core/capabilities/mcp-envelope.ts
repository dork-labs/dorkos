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
import { CapabilityToolError } from './capability-definition.js';

export interface McpTextEnvelope {
  /** One or more text blocks carrying the JSON-encoded payload. */
  content: { type: 'text'; text: string }[];
  /** Set by the handler on failure paths. */
  isError?: boolean;
}

// The refusal half of the capability contract lives in the port file (capability-definition.ts),
// so a domain takes it from there; this plain re-export keeps existing callers working.
export { CapabilityToolError } from './capability-definition.js';

/**
 * A capability result that carries PIXELS beside its JSON.
 *
 * The plain-data contract is text-shaped by default, and for one verb that is a
 * lie worth fixing rather than living with: a screenshot whose picture arrives
 * as a base64 string inside a JSON blob is a picture the model cannot look at.
 * A capability returns one of these and the MCP adapters emit an image content
 * block followed by the ordinary text block, which is exactly the two-block
 * result `browser_screenshot` has returned since it shipped.
 *
 * A class rather than a shape with a marker key, for the same reason
 * {@link CapabilityToolError} is one: `instanceof` cannot be produced by a wire
 * payload, so no argument a caller sends can make a result claim to be an image.
 */
export class CapabilityImageResult {
  /**
   * Pair one picture with the JSON that describes it.
   *
   * @param image - The picture: base64 bytes and the media type they are.
   * @param payload - The JSON that goes in the text block beside it.
   */
  constructor(
    readonly image: { readonly data: string; readonly mimeType: string },
    readonly payload: unknown
  ) {}
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
