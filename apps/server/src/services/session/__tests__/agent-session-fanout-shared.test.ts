/**
 * The machine-wide fan-out answers a burst of identical asks with ONE scan.
 *
 * Every open window re-asks for the Recent list when any chat changes, and one
 * scan reads every agent folder across every runtime. When each ask ran its own
 * scan, they stacked up faster than they finished and the whole server slowed to
 * seconds per request (2026-10-13). These cases pin the property that stopped it:
 * asks that overlap share a scan, a fresh answer is reused for a short window, a
 * failed scan is never reused, and no caller can change another caller's rows.
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import { FakeAgentRuntime } from '@dorkos/test-utils';
import type { Session } from '@dorkos/shared/types';
import {
  AGENT_SESSION_FANOUT_FRESH_MS,
  fanOutAgentSessions,
  markAgentSessionsChanged,
  resetAgentSessionFanoutCache,
  setAgentSessionSources,
} from '../agent-session-fanout.js';

function session(id: string, cwd: string): Session {
  return {
    id,
    title: `Session ${id}`,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    permissionMode: 'default',
    runtime: 'fake',
    cwd,
  };
}

/** A runtime that answers every folder after a tick, counting each listing. */
function countingRuntime(): FakeAgentRuntime {
  const runtime = new FakeAgentRuntime('fake');
  runtime.listSessions.mockImplementation(
    (dir: string) => new Promise((resolve) => setTimeout(() => resolve([session(dir, dir)]), 5))
  );
  return runtime;
}

const PATHS = Array.from({ length: 37 }, (_, i) => `/agents/a${i}`);

describe('fanOutAgentSessions — one scan per burst', () => {
  afterEach(() => {
    vi.useRealTimers();
    resetAgentSessionFanoutCache();
  });

  it('runs one scan for ten callers asking at once', async () => {
    // Red when every ask scans on its own: ten asks then cost 370 listings.
    const runtime = countingRuntime();
    const answers = await Promise.all(
      Array.from({ length: 10 }, () =>
        fanOutAgentSessions({ runtimes: [runtime], agentPaths: PATHS })
      )
    );
    expect(runtime.listSessions).toHaveBeenCalledTimes(PATHS.length);
    for (const answer of answers) expect(answer.perPath).toHaveLength(PATHS.length);
  });

  it('reuses a fresh answer, and scans again once it is stale', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const runtime = countingRuntime();
    await fanOutAgentSessions({ runtimes: [runtime], agentPaths: PATHS });
    await fanOutAgentSessions({ runtimes: [runtime], agentPaths: [...PATHS].reverse() });
    expect(runtime.listSessions).toHaveBeenCalledTimes(PATHS.length);

    vi.advanceTimersByTime(AGENT_SESSION_FANOUT_FRESH_MS);
    await fanOutAgentSessions({ runtimes: [runtime], agentPaths: PATHS });
    expect(runtime.listSessions).toHaveBeenCalledTimes(PATHS.length * 2);
  });

  it('never shares between different questions', async () => {
    const one = countingRuntime();
    const two = countingRuntime();
    await fanOutAgentSessions({ runtimes: [one], agentPaths: ['/agents/a0'] });
    await fanOutAgentSessions({ runtimes: [one], agentPaths: ['/agents/a1'] });
    await fanOutAgentSessions({ runtimes: [two], agentPaths: ['/agents/a0'] });
    expect(one.listSessions).toHaveBeenCalledTimes(2);
    expect(two.listSessions).toHaveBeenCalledTimes(1);
  });

  it('gives each caller its own rows', async () => {
    // The routes overlay settings onto the rows they are handed, in place.
    const runtime = countingRuntime();
    const [first, second] = await Promise.all([
      fanOutAgentSessions({ runtimes: [runtime], agentPaths: ['/agents/a0'] }),
      fanOutAgentSessions({ runtimes: [runtime], agentPaths: ['/agents/a0'] }),
    ]);
    first.perPath[0]!.members[0]!.title = 'changed by the first caller';
    expect(second.perPath[0]!.members[0]!.title).toBe('Session /agents/a0');
  });

  it('does not reuse a scan that failed', async () => {
    // Red when a rejected scan is kept: every caller then gets the same error
    // until the window passes, though the next scan would have worked.
    const runtime = countingRuntime();
    runtime.getInternalSessionId.mockImplementationOnce(() => {
      throw new Error('store unreadable');
    });
    await expect(
      fanOutAgentSessions({ runtimes: [runtime], agentPaths: ['/agents/a0'] })
    ).rejects.toThrow('store unreadable');
    const again = await fanOutAgentSessions({ runtimes: [runtime], agentPaths: ['/agents/a0'] });
    expect(again.perPath[0]!.members).toHaveLength(1);
    expect(runtime.listSessions).toHaveBeenCalledTimes(2);
  });

  it('never hands a caller who asks after a change a scan from before it', async () => {
    // Red when a running scan is joined regardless of changes: a chat created
    // mid-scan is then missing from the very answer its own event asked for.
    const runtime = new FakeAgentRuntime('fake');
    let store = ['old'];
    // Each listing is held open until the test releases it, so the first scan
    // is provably still running when the change lands.
    const releases: Array<() => void> = [];
    runtime.listSessions.mockImplementation((dir: string) => {
      const snapshot = [...store];
      return new Promise((resolve) =>
        releases.push(() => resolve(snapshot.map((id) => session(id, dir))))
      );
    });

    const before = fanOutAgentSessions({ runtimes: [runtime], agentPaths: ['/agents/a0'] });
    await vi.waitFor(() => expect(releases).toHaveLength(1));
    store = ['old', 'new'];
    markAgentSessionsChanged();
    const afterOne = fanOutAgentSessions({ runtimes: [runtime], agentPaths: ['/agents/a0'] });
    const afterTwo = fanOutAgentSessions({ runtimes: [runtime], agentPaths: ['/agents/a0'] });
    releases[0]!();
    await vi.waitFor(() => expect(releases).toHaveLength(2));
    releases[1]!();

    const ids = async (p: typeof before) => (await p).perPath[0]!.members.map((s) => s.id);
    expect(await ids(before)).toEqual(['old']);
    expect(await ids(afterOne)).toEqual(['old', 'new']);
    expect(await ids(afterTwo)).toEqual(['old', 'new']);
    // One scan before the change, ONE after it, shared — never one per caller.
    expect(runtime.listSessions).toHaveBeenCalledTimes(2);
  });

  it('runs one scan at a time, however many changes arrive', async () => {
    // Red when every change starts its own scan beside the running one: that
    // is the pile-up that froze the server.
    let inFlight = 0;
    let peak = 0;
    const runtime = new FakeAgentRuntime('fake');
    runtime.listSessions.mockImplementation((dir: string) => {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      return new Promise((resolve) =>
        setTimeout(() => {
          inFlight -= 1;
          resolve([session(dir, dir)]);
        }, 10)
      );
    });
    const asks = [];
    for (let i = 0; i < 10; i++) {
      markAgentSessionsChanged();
      asks.push(fanOutAgentSessions({ runtimes: [runtime], agentPaths: ['/agents/a0'] }));
    }
    await Promise.all(asks);
    expect(peak).toBe(1);
    expect(runtime.listSessions).toHaveBeenCalledTimes(2);
  });

  it('does not reuse a finished answer after a change', async () => {
    const runtime = countingRuntime();
    await fanOutAgentSessions({ runtimes: [runtime], agentPaths: ['/agents/a0'] });
    markAgentSessionsChanged();
    await fanOutAgentSessions({ runtimes: [runtime], agentPaths: ['/agents/a0'] });
    expect(runtime.listSessions).toHaveBeenCalledTimes(2);
  });

  it('forgets every answer when the sources change', async () => {
    const runtime = countingRuntime();
    await fanOutAgentSessions({ runtimes: [runtime], agentPaths: ['/agents/a0'] });
    setAgentSessionSources(null);
    await fanOutAgentSessions({ runtimes: [runtime], agentPaths: ['/agents/a0'] });
    expect(runtime.listSessions).toHaveBeenCalledTimes(2);
  });
});
