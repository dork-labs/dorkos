/**
 * The room drive's collection contract, against a stub SSE server that emits the
 * exact frames a real room emits — including the two that repeat forever.
 *
 * These are the tests for the false-green the reviewer found: `settle` could
 * return "quiet" while a turn was still running, because a working indicator is
 * republished with identical contents every ten seconds and therefore stops
 * being news. On a restraint case, whose whole subject is whether the agent says
 * anything, that reads as PASS.
 */
import { describe, expect, it, afterEach } from 'vitest';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { openRoomStream } from '../room-drive.js';

/** One SSE frame, written the way the room's own sink writes it. */
function frame(event: string, data: unknown): string {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

/** A working / done presence signal for one turn. */
function presence(state: string): unknown {
  return {
    type: 'signal',
    signal: 'progress',
    authorId: 'agent-1',
    entryId: 'entry-1',
    state,
    at: new Date().toISOString(),
  };
}

/** One committed post. */
function entry(id: string, text: string): unknown {
  return {
    type: 'entry',
    seq: 1,
    entry: { id, authorId: 'agent-1', kind: 'post', body: { text } },
  };
}

let server: http.Server | undefined;

afterEach(async () => {
  const running = server;
  server = undefined;
  if (running) await new Promise<void>((resolve) => running.close(() => resolve()));
});

/**
 * Boot a stub room stream that writes a scripted timeline, plus the keepalive
 * comments and indicator republishes a real room writes between the interesting
 * frames.
 */
async function stubRoom(
  script: Array<{ atMs: number; write: string }>,
  opts: { republishWorking?: boolean } = {}
): Promise<string> {
  // A real room republishes an indicator only while a claim is HELD, so a stub
  // that republished unconditionally would invent a turn in the one test that is
  // about a room where nothing ran.
  const republishWorking = opts.republishWorking ?? true;
  const timers: Array<ReturnType<typeof setTimeout>> = [];
  server = http.createServer((_req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    res.write(': connected\n\n');
    res.write(frame('snapshot', { room: {}, entries: [], cursor: 0 }));
    for (const step of script) {
      timers.push(setTimeout(() => res.write(step.write), step.atMs));
    }
    // The two repeaters, on the real intervals scaled down so a test can see
    // them: a keepalive comment and an unchanged working indicator.
    const keepalive = setInterval(() => res.write(': keepalive\n\n'), 300);
    const republish = republishWorking
      ? setInterval(() => res.write(frame('signal', presence('working'))), 900)
      : undefined;
    res.on('close', () => {
      clearInterval(keepalive);
      if (republish) clearInterval(republish);
      for (const t of timers) clearTimeout(t);
    });
  });
  await new Promise<void>((resolve) => server?.listen(0, '127.0.0.1', resolve));
  return `http://127.0.0.1:${(server?.address() as AddressInfo).port}`;
}

describe('openRoomStream().settle', () => {
  it('SEES a turn that answers long after the quiet window, instead of settling without it', async () => {
    // The exact shape of the measured false-green: a turn starts, nothing new is
    // said for three times the quiet window (only keepalives and identical
    // indicator republishes), and the answer lands at t=6s. A collector that
    // settled on quiet would report "the agent stayed silent" about a turn that
    // was still running.
    const baseUrl = await stubRoom([
      { atMs: 100, write: frame('signal', presence('working')) },
      { atMs: 6_000, write: frame('entry', entry('e-late', 'Here is the answer.')) },
      { atMs: 6_050, write: frame('signal', presence('done')) },
    ]);
    const stream = openRoomStream({ baseUrl, roomId: 'room-1', timeoutMs: 20_000 });
    await stream.ready;
    try {
      const frames = await stream.settle({ quietMs: 2_000 });
      const texts = frames
        .filter((f) => f.event === 'entry')
        .map((f) => (f.data as { entry?: { body?: { text?: string } } }).entry?.body?.text);
      expect(texts).toContain('Here is the answer.');
    } finally {
      stream.close();
    }
  }, 30_000);

  it('settles on quiet once every turn has released', async () => {
    const baseUrl = await stubRoom([
      { atMs: 100, write: frame('signal', presence('working')) },
      { atMs: 400, write: frame('entry', entry('e-fast', 'Done already.')) },
      { atMs: 450, write: frame('signal', presence('done')) },
    ]);
    const stream = openRoomStream({ baseUrl, roomId: 'room-1', timeoutMs: 20_000 });
    await stream.ready;
    try {
      const startedAt = Date.now();
      await stream.settle({ quietMs: 1_000 });
      // It returned on the quiet window rather than on the hard ceiling — the
      // keepalives and republishes did not hold it open.
      expect(Date.now() - startedAt).toBeLessThan(8_000);
    } finally {
      stream.close();
    }
  }, 30_000);

  it('settles with nothing when a room never reacts at all', async () => {
    const baseUrl = await stubRoom([], { republishWorking: false });
    const stream = openRoomStream({ baseUrl, roomId: 'room-1', timeoutMs: 20_000 });
    await stream.ready;
    try {
      const frames = await stream.settle({ quietMs: 1_000 });
      expect(frames.filter((f) => f.event === 'entry')).toEqual([]);
    } finally {
      stream.close();
    }
  }, 30_000);

  it('reports a turn that never releases as a runner error naming it, not as quiet', async () => {
    // The fallback the open-turn rule leans on: a turn that hangs forever is an
    // error against the drive's own budget, and the message names the turn so a
    // reader is not left guessing which agent stopped.
    const baseUrl = await stubRoom([{ atMs: 100, write: frame('signal', presence('working')) }]);
    const stream = openRoomStream({ baseUrl, roomId: 'room-1', timeoutMs: 3_000 });
    await stream.ready;
    try {
      await expect(stream.settle({ quietMs: 500 })).rejects.toThrow(/turn\(s\) still running/);
    } finally {
      stream.close();
    }
  }, 30_000);

  it('shares ONE budget across every settle call, so a case is bounded by its own ceiling', async () => {
    const baseUrl = await stubRoom([{ atMs: 100, write: frame('signal', presence('working')) }]);
    const stream = openRoomStream({ baseUrl, roomId: 'room-1', timeoutMs: 3_000 });
    await stream.ready;
    const startedAt = Date.now();
    try {
      await expect(stream.settle({ quietMs: 500 })).rejects.toThrow();
      // A per-settle deadline would give this second call a fresh 3 seconds. A
      // per-drive one is already spent, so it fails at once.
      await expect(stream.settle({ quietMs: 500 })).rejects.toThrow();
      expect(Date.now() - startedAt).toBeLessThan(6_000);
    } finally {
      stream.close();
    }
  }, 30_000);
});
