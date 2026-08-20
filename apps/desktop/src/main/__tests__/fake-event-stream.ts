import http from 'node:http';
import type { AddressInfo } from 'node:net';

/**
 * A stand-in for the server's `GET /api/events`, driven frame by frame.
 *
 * The wire format is the thing every consumer of `event-stream.ts` is tested
 * against, so this speaks it literally rather than through a helper the
 * implementation could share a bug with. Shared by `agent-activity.test.ts`
 * and `notifications.test.ts` — both watch the same shared connection
 * (`event-stream.ts`), so both exercise it through the same fake server.
 */
export class FakeEventStream {
  private server: http.Server;
  private clients: http.ServerResponse[] = [];
  /** Resolvers waiting for the next client to connect. */
  private waiters: (() => void)[] = [];
  port = 0;
  status = 200;
  /** How many times a client has connected — proves reconnection, and that two watchers share one connection. */
  connections = 0;

  constructor() {
    this.server = http.createServer((_req, res) => {
      this.connections += 1;
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
