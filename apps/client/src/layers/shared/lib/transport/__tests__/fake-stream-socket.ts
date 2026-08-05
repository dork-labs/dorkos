import { vi } from 'vitest';
import { encodeStreamFrame, STREAM_CLOSE_CODE_BASE } from '@dorkos/shared/stream-socket';

/**
 * A scriptable stand-in for the browser `WebSocket`, for the transport tests
 * that drive durable streams frame by frame.
 *
 * Shared rather than duplicated per file because the two Transport suites
 * (`room-methods`, `session-stream-methods`) script the same wire in the same
 * way, and a second copy is how their idea of a frame drifts apart.
 *
 * @module shared/lib/transport/__tests__/fake-stream-socket
 */

/** One scripted socket, with the levers a test needs to drive a stream. */
export class FakeStreamSocket {
  /** Every socket constructed since the last {@link installFakeStreamSocket}. */
  static instances: FakeStreamSocket[] = [];

  readyState = 0;
  onopen: (() => void) | null = null;
  onmessage: ((event: MessageEvent<unknown>) => void) | null = null;
  onerror: (() => void) | null = null;
  onclose: ((event: CloseEvent) => void) | null = null;

  constructor(readonly url: string) {
    FakeStreamSocket.instances.push(this);
    // Open on a microtask so a consumer that starts iterating synchronously is
    // already listening when the first frame lands — the real ordering.
    queueMicrotask(() => this.open());
  }

  /** Drive the handshake completing. */
  open(): void {
    if (this.readyState !== 0) return;
    this.readyState = 1;
    this.onopen?.();
  }

  /** Deliver one server frame. */
  push(event: string, data?: unknown, id?: string): void {
    this.onmessage?.({
      data: encodeStreamFrame({
        event,
        ...(data === undefined ? {} : { data }),
        ...(id ? { id } : {}),
      }),
    } as MessageEvent<unknown>);
  }

  /** End the stream the way a server that finished would. */
  finish(): void {
    this.emitClose(1000);
  }

  /** End the stream as a refusal carrying an HTTP status. */
  refuse(status: number): void {
    this.emitClose(STREAM_CLOSE_CODE_BASE + status);
  }

  /** End the stream the way a dropped socket does (no close frame). */
  drop(): void {
    this.emitClose(1006);
  }

  /** Called by the code under test. */
  close(): void {
    this.emitClose(1000);
  }

  private emitClose(code: number): void {
    if (this.readyState === 3) return;
    this.readyState = 3;
    this.onclose?.({ code } as CloseEvent);
  }
}

/**
 * Install {@link FakeStreamSocket} as the global `WebSocket` and reset the
 * instance log. Pair with `vi.unstubAllGlobals()` in an `afterEach`.
 */
export function installFakeStreamSocket(): void {
  FakeStreamSocket.instances = [];
  vi.stubGlobal('WebSocket', FakeStreamSocket as unknown as typeof WebSocket);
}

/**
 * Wait for the Nth socket to exist and return it.
 *
 * @param index - Zero-based index into the instance log.
 */
export async function nthSocket(index = 0): Promise<FakeStreamSocket> {
  await vi.waitFor(() => {
    if (!FakeStreamSocket.instances[index]) throw new Error(`socket ${index} not opened yet`);
  });
  return FakeStreamSocket.instances[index]!;
}
