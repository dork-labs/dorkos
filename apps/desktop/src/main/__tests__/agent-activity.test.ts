import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import http from 'node:http';
import type { AddressInfo } from 'node:net';

vi.mock('electron', () => import('./electron-mock'));

import {
  getActiveAgentCount,
  watchAgentActivity,
  type AgentActivityWatch,
} from '../agent-activity';

/**
 * A stand-in for the server's `GET /api/events`, driven frame by frame.
 *
 * The wire format is the thing under test, so this speaks it literally rather
 * than through a helper the implementation could share a bug with.
 */
class FakeEventStream {
  private server: http.Server;
  private clients: http.ServerResponse[] = [];
  /** Resolvers waiting for the next client to connect. */
  private waiters: (() => void)[] = [];
  port = 0;
  status = 200;
  /** How many times a client has connected — proves reconnection. */
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

  /** Push a `session_status` event, exactly as `session-list-broadcaster.ts` writes it. */
  sendStatus(sessionId: string, lifecycle: string): void {
    const payload = JSON.stringify({ type: 'session_status', sessionId, status: { lifecycle } });
    this.send(`event: session_status\ndata: ${payload}\n\n`);
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

let stream: FakeEventStream;
let watch: AgentActivityWatch | null = null;

beforeEach(async () => {
  stream = new FakeEventStream();
  await stream.listen();
});

afterEach(async () => {
  watch?.stop();
  watch = null;
  await stream.close();
});

/** Start watching the fake stream and wait until it is connected. */
async function start(onChange = vi.fn()): Promise<ReturnType<typeof vi.fn>> {
  watch = watchAgentActivity({ getPort: () => stream.port, onChange });
  await stream.connected();
  return onChange;
}

/** Wait for a condition the stream will satisfy on its own. */
async function eventually(assertion: () => void): Promise<void> {
  await vi.waitFor(assertion, { timeout: 2_000, interval: 10 });
}

describe('watchAgentActivity', () => {
  it('starts at zero, because nothing is running when the server has just come up', async () => {
    await start();
    expect(getActiveAgentCount()).toBe(0);
  });

  it('counts a session that starts streaming', async () => {
    const onChange = await start();

    stream.sendStatus('session-a', 'streaming');

    await eventually(() => expect(getActiveAgentCount()).toBe(1));
    expect(onChange).toHaveBeenLastCalledWith({ streaming: 1, blocked: 0 });
  });

  it('counts a session blocked on you — mid-turn is mid-turn, but apart from streaming', async () => {
    const onChange = await start();

    stream.sendStatus('session-a', 'blocked');

    await eventually(() => expect(getActiveAgentCount()).toBe(1));
    expect(onChange).toHaveBeenLastCalledWith({ streaming: 0, blocked: 1 });
  });

  it('moves a session between the streaming and blocked counts as its lifecycle changes', async () => {
    const onChange = await start();
    stream.sendStatus('session-a', 'streaming');
    await eventually(() => expect(onChange).toHaveBeenLastCalledWith({ streaming: 1, blocked: 0 }));

    stream.sendStatus('session-a', 'blocked');

    await eventually(() => expect(onChange).toHaveBeenLastCalledWith({ streaming: 0, blocked: 1 }));
    // Still exactly one agent mid-run — it just changed which count it's in.
    expect(getActiveAgentCount()).toBe(1);
  });

  it.each(['idle', 'error', 'interrupted'])(
    'stops counting a session that goes %s',
    async (lifecycle) => {
      await start();
      stream.sendStatus('session-a', 'streaming');
      await eventually(() => expect(getActiveAgentCount()).toBe(1));

      stream.sendStatus('session-a', lifecycle);

      await eventually(() => expect(getActiveAgentCount()).toBe(0));
    }
  );

  it('counts each session once, however many transitions it reports', async () => {
    await start();

    stream.sendStatus('session-a', 'streaming');
    stream.sendStatus('session-a', 'blocked');
    stream.sendStatus('session-b', 'streaming');

    await eventually(() => expect(getActiveAgentCount()).toBe(2));
  });

  it('stops counting a session that is removed while it was working', async () => {
    await start();
    stream.sendStatus('session-a', 'streaming');
    await eventually(() => expect(getActiveAgentCount()).toBe(1));

    stream.send(
      `event: session_removed\ndata: ${JSON.stringify({ type: 'session_removed', sessionId: 'session-a' })}\n\n`
    );

    await eventually(() => expect(getActiveAgentCount()).toBe(0));
  });

  it('only reports a change when either count actually changed', async () => {
    const onChange = await start();

    stream.sendStatus('session-a', 'streaming');
    await eventually(() => expect(onChange).toHaveBeenCalledTimes(1));
    // Re-announcing the same lifecycle for the same session is a no-op, and so
    // is a session going idle that was never counted in the first place.
    stream.sendStatus('session-a', 'streaming');
    stream.sendStatus('session-b', 'idle');
    stream.sendStatus('session-b', 'streaming');

    await eventually(() => expect(onChange).toHaveBeenCalledTimes(2));
    expect(onChange.mock.calls).toEqual([
      [{ streaming: 1, blocked: 0 }],
      [{ streaming: 2, blocked: 0 }],
    ]);
  });

  it('ignores heartbeats, connect frames and anything else on the stream', async () => {
    const onChange = await start();

    stream.send('event: heartbeat\ndata: \n\n');
    stream.send('event: relay_message\ndata: {"foo":1}\n\n');
    stream.send('event: session_status\ndata: not json\n\n');
    stream.send('event: session_status\ndata: {"sessionId":"a"}\n\n');
    stream.sendStatus('session-a', 'streaming');

    await eventually(() => expect(getActiveAgentCount()).toBe(1));
    expect(onChange).toHaveBeenCalledTimes(1);
  });

  it('reassembles an event split across two chunks', async () => {
    await start();
    const payload = JSON.stringify({
      type: 'session_status',
      sessionId: 'session-a',
      status: { lifecycle: 'streaming' },
    });

    stream.send(`event: session_status\ndata: ${payload.slice(0, 20)}`);
    await new Promise((resolve) => setTimeout(resolve, 20));
    stream.send(`${payload.slice(20)}\n\n`);

    await eventually(() => expect(getActiveAgentCount()).toBe(1));
  });

  it('reconnects after the stream drops, and forgets what it can no longer verify', async () => {
    const onChange = await start();
    stream.sendStatus('session-a', 'streaming');
    await eventually(() => expect(getActiveAgentCount()).toBe(1));

    stream.dropClients();

    // A stale count that never clears would nag about agents that finished
    // long ago and block quitting forever, so a lost stream resets to zero.
    await eventually(() => expect(getActiveAgentCount()).toBe(0));
    expect(onChange).toHaveBeenLastCalledWith({ streaming: 0, blocked: 0 });
    await eventually(() => expect(stream.connections).toBeGreaterThan(1));
  });

  it('keeps trying when the server refuses the stream, without counting anything', async () => {
    stream.status = 403;
    watch = watchAgentActivity({ getPort: () => stream.port, onChange: vi.fn() });

    await eventually(() => expect(stream.connections).toBeGreaterThan(1));
    expect(getActiveAgentCount()).toBe(0);
  });

  it('waits for a port rather than connecting to nothing', async () => {
    let port: number | null = null;
    watch = watchAgentActivity({ getPort: () => port, onChange: vi.fn() });

    expect(stream.connections).toBe(0);
    port = stream.port;

    await eventually(() => expect(stream.connections).toBe(1));
  });

  it('stops for good once stopped', async () => {
    await start();
    stream.sendStatus('session-a', 'streaming');
    await eventually(() => expect(getActiveAgentCount()).toBe(1));

    watch?.stop();

    expect(getActiveAgentCount()).toBe(0);
    const connectionsAtStop = stream.connections;
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(stream.connections).toBe(connectionsAtStop);
  });
});
