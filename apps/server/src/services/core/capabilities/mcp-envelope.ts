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

// The refusal half of the capability contract lives in the port file (capability-definition.ts),
// so a domain takes it from there; this plain re-export keeps existing callers working.
export { CapabilityToolError, unwrapMcpEnvelope } from './capability-definition.js';
export type { McpTextEnvelope } from './capability-definition.js';

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
