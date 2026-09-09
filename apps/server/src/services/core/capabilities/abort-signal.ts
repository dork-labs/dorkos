/**
 * Reading the abort signal off an MCP tool handler's `extra` argument.
 *
 * Four call sites needed this identical five lines — the in-session and external
 * capability projections, the connector runtime server, and the hand-registered
 * tool gate — so it lives once (`.claude/rules/conventions.md`: same logic three
 * times or more, extract it).
 *
 * ## Why `unknown` rather than the SDK's own type
 *
 * Two of the four callers sit outside the runtime-SDK confinement rule (Hard Rule
 * 2), so they cannot import `@modelcontextprotocol/sdk`'s `RequestHandlerExtra`
 * to name the shape. Typing the parameter `unknown` and narrowing here is what
 * lets one helper serve all four rather than one per side of that fence.
 *
 * The SDK does pass a signal: its `Protocol` builds a per-request
 * `{ signal: abortController.signal, … }` and hands it to every tool handler. So
 * this is a live read, not a defensive stub — the narrowing exists because the
 * TYPE is unavailable here, not because the value is doubtful.
 *
 * @module services/core/capabilities/abort-signal
 */

/**
 * The abort signal of an in-flight tool call, when the caller passed one.
 *
 * @param extra - The second argument an MCP tool handler receives.
 * @returns The signal, or `undefined` when there is none to read.
 */
export function abortSignalOf(extra: unknown): AbortSignal | undefined {
  if (!extra || typeof extra !== 'object' || !('signal' in extra)) return undefined;
  const signal = (extra as { signal?: unknown }).signal;
  return signal instanceof AbortSignal ? signal : undefined;
}
