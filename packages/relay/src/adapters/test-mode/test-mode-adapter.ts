/**
 * Permanent Relay adapter for the test-mode runtime.
 *
 * Not for production use. This subclass exists to prove, on every CI run, that
 * the generalized `RuntimeAdapter` composition is genuinely runtime-agnostic.
 *
 * Import-hygiene contract (enforced by the sibling test-mode-adapter.test.ts):
 * this module must stay free of any runtime-specific vendor imports or
 * vocabulary — including the default agent runtime's SDK and sibling adapter
 * directories. If this subclass would need such an import, the base class is
 * leaking and must be fixed instead. See ADR 0257.
 *
 * @module relay/adapters/test-mode/test-mode-adapter
 */

import {
  RuntimeAdapter,
  type RuntimeAdapterContext,
  type RuntimeInboundMessage,
  type RuntimeOutboundEvent,
  type RuntimeSessionHandle,
} from '../runtime-adapter.js';

/**
 * Construction options for `TestModeAdapter`.
 *
 * The adapter is intentionally simple: it takes a fixed list of scripted
 * events to emit for every `streamMessage()` call. A test fixture swaps
 * the list to script a different scenario; the adapter itself never
 * synthesizes events on its own.
 */
export interface TestModeAdapterOptions {
  /** Scripted events emitted for every incoming message. */
  readonly scenarios: readonly RuntimeOutboundEvent[];
  /** Optional fixed latency in ms between yields. Defaults to 0 (deterministic). */
  readonly eventLatencyMs?: number;
}

/**
 * Scripted `RuntimeAdapter` subclass used as a standing CI integration fixture.
 *
 * See module docstring for the import-hygiene contract this subclass exists
 * to enforce.
 */
export class TestModeAdapter extends RuntimeAdapter {
  private readonly options: TestModeAdapterOptions;

  constructor(ctx: RuntimeAdapterContext, options: TestModeAdapterOptions) {
    super(ctx);
    this.options = options;
  }

  protected async openSession(sessionId: string): Promise<RuntimeSessionHandle> {
    return { sessionId };
  }

  protected async *streamEvents(
    _handle: RuntimeSessionHandle,
    _message: RuntimeInboundMessage,
    signal: AbortSignal
  ): AsyncIterable<unknown> {
    for (const event of this.options.scenarios) {
      if (signal.aborted) return;
      if (this.options.eventLatencyMs) {
        await delay(this.options.eventLatencyMs);
      }
      yield event;
    }
  }

  protected async closeSession(_handle: RuntimeSessionHandle): Promise<void> {
    // test-mode has no runtime-side resources to release. Intentionally a no-op.
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
