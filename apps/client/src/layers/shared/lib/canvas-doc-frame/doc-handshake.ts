/** Dedicated Doc handshake; actual host load and immutable binding precede every transfer. */
import {
  CanvasDocHandshakeSchema,
  CanvasDocCommandSchema,
  CanvasDocResultSchema,
  parseCanvasDocWire,
  type CanvasDocHandshake,
  type CanvasDocResult,
} from '@dorkos/shared/canvas-doc-frame-wire';
import type { BoundDocPort } from './bound-doc-port';
import { DocFrameQueue, type DocQueueScheduler } from './doc-queue';
/** Projection payload without host-only correlation fields. */
export type DocHostPayload = CanvasDocResult extends infer T
  ? T extends CanvasDocResult
    ? Omit<T, Exclude<keyof CanvasDocHandshake, 'kind'>>
    : never
  : never;
/** Browser channel ports are supplied explicitly; tests may use real MessageChannel. */
export interface DocHandshakePorts {
  nonce(): string;
  channel(): { port1: MessagePort; port2: MessagePort };
  scheduler: DocQueueScheduler;
  offline(): void;
  /**
   * The boot nonce the host put on this served document's frame `src`, or `null`
   * for a preview. Every served document shares the opaque origin `null` and the
   * frame's one window, so the nonce is the only thing that tells the document
   * DorkOS navigated to from one the frame reached by a link or redirect.
   */
  boot: string | null;
}
/** What the host tells a page whose port it closes. */
export type DocHostClosure = 'offline' | 'revoked';
/** Host handshake with one dedicated transfer and idempotent valid acknowledgements. */
export class DocFrameHandshake {
  private readonly challenge: CanvasDocHandshake;
  private readonly queue: DocFrameQueue;
  private readonly detach: () => void;
  private timer: unknown;
  private port: MessagePort | null = null;
  private connected = false;
  private closed = false;
  private started = false;
  private readonly pending = new Map<string, string>();
  constructor(
    private readonly bound: BoundDocPort,
    private readonly ports: DocHandshakePorts
  ) {
    if (
      !bound.current() ||
      typeof ports?.nonce !== 'function' ||
      typeof ports.channel !== 'function' ||
      typeof ports.offline !== 'function'
    )
      throw new Error('Current loaded Doc binding and explicit handshake ports required.');
    // Fail closed: a served document without a boot nonce could never be told
    // apart from an outside page in the same frame.
    if (
      bound.binding.observation.eligibility === 'served-document'
        ? typeof ports.boot !== 'string' || ports.boot.length === 0
        : ports.boot !== null
    )
      throw new Error('A served document needs its boot nonce; a preview has none.');
    this.challenge = CanvasDocHandshakeSchema.parse({
      protocol: 'dorkos-doc',
      v: 1,
      kind: 'challenge',
      nonce: ports.nonce(),
      requestToken: ports.nonce(),
      loadToken: bound.binding.observation.token,
      generation: bound.binding.incarnation.generation,
    });
    this.queue = new DocFrameQueue(bound, ports.scheduler);
    this.detach = bound.onRetire(() => this.close());
  }
  /** Send only to captured actualWindow after the host observed its real load. */
  start(): void {
    if (!this.bound.current() || this.closed || this.started) return;
    this.started = true;
    const observation = this.bound.binding.observation;
    try {
      const timer = this.ports.scheduler.schedule(() => {
        this.close();
      }, 5000);
      // close() may have completed before the scheduler returns this handle.
      if (!this.bound.current() || this.closed) {
        try {
          this.ports.scheduler.cancel(timer);
        } finally {
          this.close();
        }
        return;
      }
      this.timer = timer;
      observation.frame!.postMessage(
        this.challenge,
        observation.exactOrigin === 'null' ? '*' : observation.exactOrigin!
      );
    } catch {
      this.close();
    }
  }
  /** Only exact source/origin and the current challenge ACK may transfer one port. */
  receive(event: Pick<MessageEvent, 'source' | 'origin' | 'data' | 'ports'>): boolean {
    if (
      !this.started ||
      this.closed ||
      !this.bound.current() ||
      event.source !== this.bound.binding.observation.frame ||
      event.origin !== this.bound.binding.observation.exactOrigin ||
      event.ports.length !== 0
    )
      return false;
    const ack = parseCanvasDocWire(CanvasDocHandshakeSchema, event.data);
    if (!ack || ack.kind !== 'ack' || !this.matches(ack) || !this.booted(ack)) return false;
    if (this.connected) return true;
    this.connected = true;
    let channel: { port1: MessagePort; port2: MessagePort } | undefined;
    // Private composition callbacks may retire synchronously. Check after each one,
    // before transferring authority, and drain pairs returned after old cleanup ran.
    const current = () => this.bound.current() && !this.closed;
    const refuse = () => {
      for (const key of ['port1', 'port2'] as const) {
        try {
          channel?.[key].close();
        } catch {
          /* Independently drain its sibling. */
        }
      }
      this.close();
      return false;
    };
    try {
      if (this.timer !== undefined) this.ports.scheduler.cancel(this.timer);
      this.timer = undefined;
      if (!current()) return refuse();
      channel = this.ports.channel();
      if (!current()) return refuse();
      this.port = channel.port1;
      this.port.onmessage = (event) => {
        if (event.ports.length) return;
        this.command(event.data);
      };
      if (!current()) return refuse();
      this.port.start();
      if (!current()) return refuse();
      // A served document's origin is opaque (`null`), and `postMessage` has
      // no way to name an opaque origin: `'*'` is the only target that reaches
      // it, and nothing can pin delivery to "the document that acked". So if
      // the frame navigates between the ack and this post, the port (and the
      // correlation it rides with) lands in whatever document is there now,
      // which could use it until that document's own load event retires this
      // binding and closes the port. The window is the one message hop between
      // the booted page's ack and this synchronous reply, and only a page that
      // navigates itself at that instant opens it. A preview names its exact
      // minted origin instead, so its port can only ever reach that origin.
      this.bound.binding.observation.frame!.postMessage(
        { ...this.challenge, kind: 'connect' },
        this.bound.binding.observation.exactOrigin === 'null'
          ? '*'
          : this.bound.binding.observation.exactOrigin!,
        [channel.port2]
      );
      if (!current()) return refuse();
    } catch {
      return refuse();
    }
    return true;
  }
  /** Send only strict durable projection/status data for this still-current binding. */
  publish(result: DocHostPayload): void {
    this.send({ ...result, ...this.challenge, kind: result.kind } as CanvasDocResult);
  }
  /**
   * Retire queue/ports/timers independently; sent requests remain explicitly unconfirmed.
   *
   * @param status - What the page is told: `offline` (it may reconnect) or
   *   `revoked` (its document no longer accepts events from it).
   */
  close(status: DocHostClosure = 'offline'): void {
    if (this.closed) return;
    this.closed = true;
    try {
      this.port?.postMessage({
        ...this.challenge,
        kind: 'status',
        status,
        unconfirmed: true,
      });
    } catch {
      /* Retirement cannot claim no server effect. */
    }
    try {
      this.queue.retire();
    } catch {
      /* Continue closing sibling resources. */
    }
    try {
      if (this.timer !== undefined) this.ports.scheduler.cancel(this.timer);
    } catch {
      /* Continue. */
    }
    this.timer = undefined;
    try {
      this.port?.close();
    } catch {
      /* No authority remains. */
    }
    this.port = null;
    this.pending.clear();
    this.detach?.();
    try {
      this.ports.offline();
    } catch {
      /* A UI observer cannot preserve the port. */
    }
  }
  private matches(
    value:
      | CanvasDocHandshake
      | { nonce: string; requestToken: string; loadToken: number; generation: string }
  ): boolean {
    return (
      value.nonce === this.challenge.nonce &&
      value.requestToken === this.challenge.requestToken &&
      value.loadToken === this.challenge.loadToken &&
      value.generation === this.challenge.generation
    );
  }
  /** A served document must present the nonce its frame was navigated with. */
  private booted(ack: CanvasDocHandshake & { kind: 'ack' }): boolean {
    return this.ports.boot === null || ack.boot === this.ports.boot;
  }
  private send(value: unknown): void {
    if (!this.closed && this.connected && this.bound.current()) {
      const result = parseCanvasDocWire(CanvasDocResultSchema, value);
      if (result) {
        try {
          this.port?.postMessage(result);
        } catch {
          this.close();
        }
      }
    }
  }
  private command(value: unknown): void {
    if (this.closed || !this.connected || !this.bound.current()) return;
    const command = parseCanvasDocWire(CanvasDocCommandSchema, value);
    if (!command || !this.matches(command)) return;
    if (command.kind === 'retire') {
      this.bound.retireObservation();
      this.close();
      return;
    }
    if (this.pending.has(command.requestId) || this.pending.size >= 100) return;
    this.pending.set(command.requestId, command.event.id);
    void this.queue.emit(command.event).then((outcome) => {
      if (
        !this.bound.current() ||
        this.closed ||
        this.pending.get(command.requestId) !== command.event.id
      )
        return;
      this.pending.delete(command.requestId);
      this.send(
        outcome.kind === 'accepted'
          ? {
              ...this.challenge,
              kind: 'receipt',
              requestId: command.requestId,
              receipt: outcome.receipt,
            }
          : {
              ...this.challenge,
              kind: 'refused',
              requestId: command.requestId,
              outcome: outcome.kind,
            }
      );
    });
  }
}
