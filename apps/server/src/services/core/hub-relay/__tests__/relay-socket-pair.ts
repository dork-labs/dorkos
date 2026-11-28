/**
 * An in-memory socket pair for driving a REAL computer end (`RelayDialer`)
 * against a REAL hub end (`HubComputerConnection`) without a network: frames
 * wait in a queue until the test pumps, as a network would. Step W3 of spec
 * `space-computer-contract` lifts this into `packages/test-utils`.
 */
import type { RelaySocket } from '../../session-relay/relay-dialer.js';
import type { HubRelaySocket } from '../computer-connection.js';

/** Frames in flight, delivered only when the test pumps, as a network would. */
export class Wire {
  readonly queue: (() => void)[] = [];
  /** Drop what the computer sends, as a half-open connection does. */
  computerMuted = false;
  readonly computer = new End(this, 'computer');
  readonly hub = new End(this, 'hub');
  pump(): void {
    while (this.queue.length > 0) this.queue.shift()!();
  }
}

/** One end of the {@link Wire}: a socket to whichever side holds it. */
export class End implements RelaySocket, HubRelaySocket {
  bufferedAmount = 0;
  closed = false;
  readonly sent: string[] = [];
  private readonly listeners = new Map<string, ((...args: unknown[]) => void)[]>();
  constructor(
    private readonly wire: Wire,
    private readonly side: 'computer' | 'hub'
  ) {}
  private get peer(): End {
    return this.side === 'computer' ? this.wire.hub : this.wire.computer;
  }
  send(text: string): void {
    if (this.closed) return;
    this.sent.push(text);
    if (this.side === 'computer' && this.wire.computerMuted) return;
    this.wire.queue.push(() => this.peer.fire('message', text, false));
  }
  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.fire('close');
    this.wire.queue.push(() => this.peer.close());
  }
  on = ((event: string, listener: (...args: never[]) => void): void => {
    const stored = listener as (...args: unknown[]) => void;
    this.listeners.set(event, [...(this.listeners.get(event) ?? []), stored]);
  }) as RelaySocket['on'] & HubRelaySocket['on'];
  fire(event: string, ...args: unknown[]): void {
    for (const listener of this.listeners.get(event) ?? []) listener(...args);
  }
}
