/**
 * The watchdog holds only the child's silence against it, never DorkOS's own
 * stall (DOR-4785), on a fake clock. The real-process half is in
 * `isolated-lifecycle.integration.test.ts`.
 */
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import { startWatchdog, type Watchdog } from '../watchdog.js';

const PING = 5_000;
const TIMEOUT = 15_000;

/** Let the verdict an interval tick queued run (setImmediate is left real). */
const nextImmediate = () => new Promise<void>((resolve) => setImmediate(resolve));

describe('the isolated child watchdog', () => {
  let ping: Mock<() => void>;
  let onSilent: Mock<() => void>;
  let onHostStall: Mock<(ms: number) => void>;
  let dog: Watchdog;

  beforeEach(() => {
    // Timers and Date are fake; setImmediate stays real, so a test decides
    // what happens between a tick and its verdict.
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'Date'] });
    ping = vi.fn<() => void>();
    onSilent = vi.fn<() => void>();
    onHostStall = vi.fn<(ms: number) => void>();
    dog = startWatchdog({
      pingIntervalMs: PING,
      pongTimeoutMs: TIMEOUT,
      ping,
      onSilent,
      onHostStall,
    });
  });

  afterEach(() => {
    dog.stop();
    vi.useRealTimers();
  });

  /** One on-time tick, then its verdict. */
  async function tick(): Promise<void> {
    vi.advanceTimersByTime(PING);
    await nextImmediate();
  }

  it('pings an answering child and never kills it', async () => {
    for (let i = 0; i < 10; i++) {
      await tick();
      dog.pong();
    }
    expect(ping).toHaveBeenCalledTimes(10);
    expect(onSilent).not.toHaveBeenCalled();
  });

  it('kills a child silent past the timeout while DorkOS was awake, once', async () => {
    for (let i = 0; i < 5; i++) await tick();
    expect(onSilent).toHaveBeenCalledTimes(1);
    // Stopped: no more pings, no second kill.
    const pings = ping.mock.calls.length;
    for (let i = 0; i < 3; i++) await tick();
    expect(ping).toHaveBeenCalledTimes(pings);
    expect(onSilent).toHaveBeenCalledTimes(1);
  });

  it('does not kill an answering child when DorkOS itself stalls past the timeout', async () => {
    await tick();
    dog.pong();
    // DorkOS's loop blocks for 22 s: the clock moves, no timer runs.
    vi.setSystemTime(Date.now() + 22_000);
    await tick();
    expect(onSilent).not.toHaveBeenCalled();
    expect(onHostStall).toHaveBeenCalledWith(22_000);
    // The first tick after the stall pings again; the child answers.
    expect(ping).toHaveBeenCalledTimes(2);
    dog.pong();
    for (let i = 0; i < 4; i++) {
      await tick();
      dog.pong();
    }
    expect(onSilent).not.toHaveBeenCalled();
  });

  it('reads a pong already waiting before it judges', async () => {
    // 15 s of real silence; the next tick would kill, but the child's answer
    // arrives in the same loop turn.
    for (let i = 0; i < 3; i++) await tick();
    vi.advanceTimersByTime(PING);
    // The pong is read in the same loop turn, after the timer and before its verdict.
    dog.pong();
    await nextImmediate();
    expect(onSilent).not.toHaveBeenCalled();
  });

  it('discounts host lag between the timer tick and its deferred verdict', async () => {
    await tick();
    dog.pong();
    vi.advanceTimersByTime(PING);
    // The timer ran, but DorkOS stalls before the queued immediate can judge.
    vi.setSystemTime(Date.now() + 22_000);
    await nextImmediate();
    expect(onSilent).not.toHaveBeenCalled();
    expect(onHostStall).toHaveBeenCalledWith(22_000);
    // Crediting that stall once must not keep a genuinely silent child alive.
    for (let i = 0; i < 4; i++) await tick();
    expect(onSilent).toHaveBeenCalledTimes(1);
  });

  it('still kills a hung child when DorkOS stalls as well', async () => {
    await tick();
    vi.setSystemTime(Date.now() + 22_000);
    await tick();
    expect(onSilent).not.toHaveBeenCalled();
    // From here the host is awake and the child never answers: killed within the timeout.
    for (let i = 0; i < 4; i++) await tick();
    expect(onSilent).toHaveBeenCalledTimes(1);
  });

  it('drops a verdict still waiting once it is stopped', async () => {
    for (let i = 0; i < 3; i++) await tick();
    vi.advanceTimersByTime(PING);
    dog.stop();
    await nextImmediate();
    expect(onSilent).not.toHaveBeenCalled();
  });
});
