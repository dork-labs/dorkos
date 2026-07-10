import type { StreamEvent } from '@dorkos/shared/types';

/**
 * Shared plumbing for the `demo-*` marketing-capture scenarios
 * (`demo-scenarios.ts`, `demo-scenario-tictactoe.ts`): the session/model
 * identity every demo turn echoes, and the paced word-chunk text streamer that
 * lets a capture run record a genuine streaming animation instead of a
 * zero-latency dump. Split out so both scenario modules share one
 * implementation rather than drifting copies.
 *
 * @module services/runtimes/test-mode/demo-scenario-shared
 */

/** Session id echoed on synthetic status events (mirrors the built-in scenarios). */
export const DEMO_SESSION_ID = 'test-mode';

/** Model label shown on the status strip during demo turns. */
export const DEMO_MODEL = 'claude-sonnet-4-5';

/** Delay between fine-grained text chunks — fast enough to read as live typing. */
export const TEXT_CHUNK_DELAY_MS = 55;

/** Resolve after `ms` milliseconds. */
export function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Emit a body of markdown as word-level `text_delta` chunks, paced for capture. */
export async function* streamText(body: string): AsyncGenerator<StreamEvent> {
  // Split on whitespace boundaries but keep the whitespace so markdown structure
  // (newlines, fences) survives reassembly on the client.
  const chunks = body.match(/\S+\s*/g) ?? [body];
  for (const chunk of chunks) {
    yield { type: 'text_delta', data: { text: chunk } } as StreamEvent;
    await delay(TEXT_CHUNK_DELAY_MS);
  }
}
