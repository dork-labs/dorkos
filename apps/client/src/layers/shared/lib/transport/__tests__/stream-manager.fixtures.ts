/** Fake durable connections for the StreamManager test files. */
import { vi, type Mock } from 'vitest';
import { createMockTransport } from '@dorkos/test-utils';
import type { ConnectionState } from '@dorkos/shared/types';
import { StreamManager, type DurableStreamConnection } from '../stream-manager';
import type { StreamConnectionOptions } from '../ws-connection';

/** The transport every test StreamManager uses as its HTTP source owner. */
export const transportOwner = createMockTransport();

/** A fake connection that records its options and lets the test push frames. */
export class FakeConnection implements DurableStreamConnection {
  connect: Mock<() => void> = vi.fn();
  disconnect: Mock<() => void> = vi.fn();
  destroy: Mock<() => void> = vi.fn();
  enableVisibilityOptimization: Mock<() => void> = vi.fn();
  constructor(
    readonly url: string,
    readonly opts: StreamConnectionOptions
  ) {}

  private seq = 0;

  /**
   * Push a frame as the server would deliver it (event name + parsed JSON data).
   * A connection with its own decoder (the global stream, whose messages are
   * whole `DorkOsEvent`s) is handed the message as the server writes it and
   * reads it through that decoder, as the real socket does.
   */
  push(eventName: string, data: unknown): void {
    const decode = this.opts.decodeFrame;
    if (!decode) {
      this.opts.eventHandlers[eventName]?.(data);
      return;
    }
    this.seq += 1;
    const at = new Date().toISOString();
    const raw = JSON.stringify({ seq: this.seq, at, type: eventName, payload: data });
    const frame = decode(raw);
    if (frame) this.opts.eventHandlers[frame.event]?.(frame.data);
  }

  /** Drive a connection-state change through onStateChange. */
  emitState(state: ConnectionState, failedAttempts = 0): void {
    this.opts.onStateChange?.(state, failedAttempts);
  }
}

/** Build a StreamManager wired to a factory that records every FakeConnection. */
export function setup(): { manager: StreamManager; connections: FakeConnection[] } {
  const connections: FakeConnection[] = [];
  const createConnection = (
    url: string,
    opts: StreamConnectionOptions
  ): DurableStreamConnection => {
    const conn = new FakeConnection(url, opts);
    connections.push(conn);
    return conn;
  };
  const manager = new StreamManager({ createConnection });
  manager.useHttpSource('/api', transportOwner);
  return { manager, connections };
}
