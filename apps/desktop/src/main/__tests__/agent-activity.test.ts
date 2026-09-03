import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('electron', () => import('./electron-mock'));

import {
  getActiveAgentCount,
  watchAgentActivity,
  type AgentActivityWatch,
} from '../agent-activity';
import { FakeEventStream } from './fake-event-stream';

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

/**
 * Wait for a count the stream will settle on its own.
 *
 * For these the ceiling is not the subject: the stream reaches the count as fast
 * as one loopback frame and one event-loop turn allow, so the wait is over in
 * milliseconds on any machine and the ceiling only ever decides what happens on
 * a starved one. At 2s a busy machine spent the budget and the file went red
 * with no assertion mismatch. Use {@link reconnectsWithin} instead wherever the
 * DELAY is the thing being asserted — a ceiling this wide would not notice one.
 * The package's own `testTimeout` (30s) still bounds a genuine hang.
 */
async function eventually(assertion: () => void): Promise<void> {
  await vi.waitFor(assertion, { timeout: 15_000, interval: 10 });
}

/**
 * Wait for a reconnection, bounded tightly enough to still catch a slow one.
 *
 * **Here the delay IS the assertion.** These cases are the only ones whose
 * subject is how long the shared connection in `event-stream.ts` waits before
 * trying again: it starts at `RECONNECT_BASE_MS` (1s) and doubles to
 * `RECONNECT_MAX_MS` (15s). So a ceiling at that maximum would pass for every
 * backoff this module could ever produce — measured: raising the base delay 12x
 * fails three cases at 2s and passes all sixteen at 15s. Five seconds is the
 * usable middle: several times the one base delay plus whatever a loaded machine
 * adds on top, and still far below where a regressed backoff lands.
 */
async function reconnectsWithin(assertion: () => void): Promise<void> {
  await vi.waitFor(assertion, { timeout: 5_000, interval: 10 });
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
    await reconnectsWithin(() => expect(stream.connections).toBeGreaterThan(1));
  });

  it('keeps trying when the server refuses the stream, without counting anything', async () => {
    stream.status = 403;
    watch = watchAgentActivity({ getPort: () => stream.port, onChange: vi.fn() });

    await reconnectsWithin(() => expect(stream.connections).toBeGreaterThan(1));
    expect(getActiveAgentCount()).toBe(0);
  });

  it('waits for a port rather than connecting to nothing', async () => {
    let port: number | null = null;
    watch = watchAgentActivity({ getPort: () => port, onChange: vi.fn() });

    expect(stream.connections).toBe(0);
    port = stream.port;

    await reconnectsWithin(() => expect(stream.connections).toBe(1));
  });

  it('stops for good once stopped', async () => {
    const onChange = await start();
    stream.sendStatus('session-a', 'streaming');
    await eventually(() => expect(getActiveAgentCount()).toBe(1));

    watch?.stop();

    expect(getActiveAgentCount()).toBe(0);
    const connectionsAtStop = stream.connections;
    const callsAtStop = onChange.mock.calls.length;

    // Nothing the server says after the stop is heard — this is the assertion
    // that fails if `stop()` forgets the count but leaves the subscription
    // open. Without it the leak only showed up as collateral damage in whatever
    // case happened to run next (DOR-1730).
    stream.sendStatus('session-b', 'streaming');
    await new Promise((resolve) => setTimeout(resolve, 100));

    expect(getActiveAgentCount()).toBe(0);
    expect(onChange).toHaveBeenCalledTimes(callsAtStop);
    expect(stream.connections).toBe(connectionsAtStop);
  });
});
