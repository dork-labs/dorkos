/**
 * An in-memory socket pair for driving the computer's end of the relay (the
 * dialer) against the home's end (the hub connection) without a network
 * (spec `space-computer-contract` §12, step W3). Frames wait in a queue until
 * the test pumps, as a network would, and {@link Wire.drop} cuts the link with
 * whatever was still in flight.
 *
 * The socket shape is declared here, not imported, so this package never
 * depends on the server: it is the few members both ends read.
 *
 * @module test-utils/relay-socket-pair
 */

/** The few members both relay ends need from a WebSocket. */
export interface WireSocket {
  send(text: string): void;
  /** Bytes queued but not yet written; the dialer reads it to cap a stream. */
  readonly bufferedAmount: number;
  close(code?: number, reason?: string): void;
  on(event: 'open', listener: () => void): void;
  on(event: 'message', listener: (data: unknown, isBinary?: boolean) => void): void;
  on(event: 'close', listener: () => void): void;
  on(event: 'error', listener: (error: Error) => void): void;
}

/** Frames in flight, delivered only when the test pumps, as a network would. */
export class Wire {
  /** Deliveries waiting for {@link Wire.pump}. */
  readonly queue: (() => void)[] = [];
  /** Drop what the computer sends, as a half-open connection does. */
  computerMuted = false;
  /** The computer's socket. */
  readonly computer = new End(this, 'computer');
  /** The home's socket. */
  readonly hub = new End(this, 'hub');

  /** Deliver everything in flight, including what each delivery sends. */
  pump(): void {
    while (this.queue.length > 0) this.queue.shift()!();
  }

  /**
   * Cut the link, as a network drop does: everything still in flight is lost,
   * and both ends hear `close` now, with nothing more delivered after it.
   */
  drop(): void {
    this.queue.length = 0;
    this.computer.lose();
    this.hub.lose();
  }
}

/** One end of the {@link Wire}: a socket to whichever side holds it. */
export class End implements WireSocket {
  bufferedAmount = 0;
  /** Whether this end has closed or lost the link. */
  closed = false;
  /** Every text this end sent, in order. */
  readonly sent: string[] = [];
  private readonly listeners = new Map<string, ((...args: unknown[]) => void)[]>();

  /**
   * Make one end of `wire`, held by `side`.
   *
   * @param wire - The pair this end belongs to.
   * @param side - Which side holds it.
   */
  constructor(
    private readonly wire: Wire,
    private readonly side: 'computer' | 'hub'
  ) {}

  private get peer(): End {
    return this.side === 'computer' ? this.wire.hub : this.wire.computer;
  }

  /** Queue one text for the other end. */
  send(text: string): void {
    if (this.closed) return;
    this.sent.push(text);
    if (this.side === 'computer' && this.wire.computerMuted) return;
    this.wire.queue.push(() => this.peer.fire('message', text, false));
  }

  /** Close this end; the other end hears it at the next pump. */
  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.fire('close');
    this.wire.queue.push(() => this.peer.close());
  }

  /** Lose the link now, with no word to the other end: {@link Wire.drop}. */
  lose(): void {
    if (this.closed) return;
    this.closed = true;
    this.fire('close');
  }

  on = ((event: string, listener: (...args: never[]) => void): void => {
    const stored = listener as (...args: unknown[]) => void;
    this.listeners.set(event, [...(this.listeners.get(event) ?? []), stored]);
  }) as WireSocket['on'];

  /**
   * Call every listener for `event`, as the socket library would.
   *
   * @param event - The event name.
   * @param args - Its arguments.
   */
  fire(event: string, ...args: unknown[]): void {
    for (const listener of this.listeners.get(event) ?? []) listener(...args);
  }
}
