import http from 'node:http';
import type { AddressInfo } from 'node:net';
import type { EventStreamHandlers, EventStreamSubscription, GetServerPort } from '../event-stream';

/**
 * A stand-in for the server's `GET /api/events`, driven frame by frame.
 *
 * The wire format is the thing every consumer of `event-stream.ts` is tested
 * against, so this speaks it literally rather than through a helper the
 * implementation could share a bug with. This directory's own
 * `event-stream.test.ts` drives the transport through it throughout;
 * `agent-activity.test.ts` and `notifications/__tests__/index.test.ts` reach
 * for it once each, for the single socket test that proves their
 * {@link FakeEventSource} seam is wired to something real.
 */
export class FakeEventStream {
  private server: http.Server;
  private clients: http.ServerResponse[] = [];
  /** Resolvers waiting for the next client to connect. */
  private waiters: (() => void)[] = [];
  /** Resolvers waiting for the connection count to reach a threshold. */
  private connectionWaiters: { at: number; resolve: () => void }[] = [];
  port = 0;
  status = 200;
  /** How many times a client has connected — proves reconnection, and that two watchers share one connection. */
  connections = 0;

  constructor() {
    this.server = http.createServer((_req, res) => {
      this.connections += 1;
      this.settleConnectionWaiters();
      if (this.status !== 200) {
        res.writeHead(this.status).end();
        return;
      }
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write('event: connected\ndata: {"connectedAt":"2026-07-26T00:00:00.000Z"}\n\n');
      this.clients.push(res);
      for (const waiter of this.waiters.splice(0)) waiter();
    });
  }

  async listen(): Promise<void> {
    await new Promise<void>((resolve) => this.server.listen(0, '127.0.0.1', resolve));
    this.port = (this.server.address() as AddressInfo).port;
  }

  /** Resolve once a client is connected (immediately if one already is). */
  async connected(): Promise<void> {
    if (this.clients.length > 0) return;
    await new Promise<void>((resolve) => this.waiters.push(resolve));
  }

  /**
   * Resolve once this server has been reached `count` times — refusals included.
   *
   * The barrier a test waits on instead of polling a deadline for
   * {@link connections} to move (DOR-1727): the resolver is tripped by the
   * production code's own request arriving, so a starved machine makes the wait
   * longer and never makes it wrong. A reconnect that never comes is caught by
   * the package's `testTimeout`, which is what that bound is for. Counts every
   * connection, unlike {@link connected}, so it also works when `status` is set
   * to a refusal and no client is ever added.
   *
   * @param count - How many connections to wait for, in total, since this
   *   server started.
   */
  async connectionsReach(count: number): Promise<void> {
    if (this.connections >= count) return;
    await new Promise<void>((resolve) => this.connectionWaiters.push({ at: count, resolve }));
  }

  /** Release every waiter whose threshold the latest connection reached. */
  private settleConnectionWaiters(): void {
    const reached = this.connectionWaiters.filter((waiter) => waiter.at <= this.connections);
    this.connectionWaiters = this.connectionWaiters.filter(
      (waiter) => waiter.at > this.connections
    );
    for (const waiter of reached) waiter.resolve();
  }

  /** Push one raw SSE frame to every connected client. */
  send(frame: string): void {
    for (const client of this.clients) client.write(frame);
  }

  /** Push one named event with a JSON payload, exactly as `eventFanOut.broadcast` writes it. */
  sendEvent(name: string, payload: unknown): void {
    this.send(`event: ${name}\ndata: ${JSON.stringify(payload)}\n\n`);
  }

  /** Push a `session_status` event, exactly as `session-list-broadcaster.ts` writes it. */
  sendStatus(sessionId: string, lifecycle: string): void {
    this.sendEvent('session_status', {
      type: 'session_status',
      sessionId,
      status: { lifecycle },
    });
  }

  /** Drop every open stream without closing the server, as a server restart would. */
  dropClients(): void {
    for (const client of this.clients.splice(0)) client.end();
  }

  async close(): Promise<void> {
    this.dropClients();
    await new Promise<void>((resolve) => this.server.close(() => resolve()));
  }
}

/** One subscription made through {@link FakeEventSource}, as the source sees it. */
export interface FakeSubscription {
  /** What the subscriber wants to hear about the stream. */
  readonly handlers: EventStreamHandlers;
  /** The accessor it subscribed with, so a test can prove it was passed through. */
  readonly getPort: GetServerPort;
  /** Whether the subscriber has let go. */
  unsubscribed: boolean;
}

/**
 * The event stream with the wire taken out of it.
 *
 * Stands in for `subscribeEventStream` itself, so frames are delivered by a
 * direct call and a test asserts on the very next line rather than waiting for
 * a socket to get around to it — which is the whole point (DOR-1727, DOR-1826):
 * what the files that use this are about is which frames do what, and that
 * question has no time in it. The frame shape is `ServerEventFrame`, exactly
 * what `event-stream.ts` hands its subscribers after parsing the wire; that the
 * real transport really does produce these from real SSE text is the job of
 * `event-stream.test.ts`, and of the one socket test each of those files keeps.
 *
 * Install it behind a `vi.mock` of `../event-stream` that swaps only
 * `subscribeEventStream` — everything else that module exports (notably
 * `parseEventPayload`, which decides whether a payload is JSON at all) must
 * stay real: this fakes where the frames arrive from, never what they mean.
 */
export class FakeEventSource {
  /** Every subscription made since this source was created, in order. */
  readonly subscriptions: FakeSubscription[] = [];

  /**
   * Stand in for `subscribeEventStream`.
   *
   * @param options - Where the subscriber would find the server's port.
   * @param handlers - Its frame and connection-lost callbacks.
   */
  subscribe = (
    options: { getPort: GetServerPort },
    handlers: EventStreamHandlers
  ): EventStreamSubscription => {
    const subscription: FakeSubscription = {
      handlers,
      getPort: options.getPort,
      unsubscribed: false,
    };
    this.subscriptions.push(subscription);
    return {
      unsubscribe: () => {
        subscription.unsubscribed = true;
      },
    };
  };

  /** The subscriptions that have not let go — nothing is delivered to the rest. */
  get live(): FakeSubscription[] {
    return this.subscriptions.filter((subscription) => !subscription.unsubscribed);
  }

  /**
   * Deliver one frame to every live subscriber, synchronously.
   *
   * @param name - The event name, as the SSE `event:` line carried it.
   * @param data - The raw payload, still JSON text — or deliberately not JSON.
   */
  emit(name: string, data: string): void {
    for (const subscription of this.live) subscription.handlers.onFrame({ name, data });
  }

  /**
   * Deliver one named event with a JSON payload, as `eventFanOut.broadcast` writes it.
   *
   * @param name - The event name.
   * @param payload - The object to serialise into the frame's `data`.
   */
  emitEvent(name: string, payload: unknown): void {
    this.emit(name, JSON.stringify(payload));
  }

  /**
   * Deliver a `session_status` event, exactly as `session-list-broadcaster.ts` writes it.
   *
   * @param sessionId - Which session changed.
   * @param lifecycle - What it changed to.
   */
  sendStatus(sessionId: string, lifecycle: string): void {
    this.emitEvent('session_status', { type: 'session_status', sessionId, status: { lifecycle } });
  }

  /** Tell every live subscriber the connection is gone, as a server restart would. */
  dropConnection(): void {
    for (const subscription of this.live) subscription.handlers.onConnectionLost?.();
  }
}

/** A promise plus the handle that settles it — the barrier shape these tests wait on. */
export interface Deferred {
  /** The promise a test awaits. */
  readonly promise: Promise<void>;
  /** Settles {@link promise}. Safe to call more than once; later calls are no-ops. */
  resolve(): void;
}

/**
 * Create a {@link Deferred}.
 *
 * A test resolves one from inside a callback the production code makes — a
 * frame arriving, a count reaching a value — and awaits it, so the wait ends
 * the instant the thing happened and has no budget to run out of. This is what
 * replaced the `vi.waitFor` ceilings these files used to poll on a machine that
 * was too busy to answer in time (DOR-1727).
 *
 * @returns A fresh deferred.
 */
export function deferred(): Deferred {
  let settle: () => void = () => {};
  const promise = new Promise<void>((resolve) => {
    settle = resolve;
  });
  return { promise, resolve: () => settle() };
}
