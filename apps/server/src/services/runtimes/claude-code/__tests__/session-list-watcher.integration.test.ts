import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, mkdir, rm, writeFile, unlink } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import type { SessionListEvent } from '@dorkos/shared/session-stream';
import { TranscriptReader } from '../sessions/transcript-reader.js';
import { watchSessionList } from '../sessions/session-list-watcher.js';

/**
 * REAL chokidar + real filesystem. The unit suite mocks chokidar, which is
 * exactly how the v5 glob regression shipped undetected: chokidar v4 removed
 * glob support, so the old `{dir}/*.jsonl` watch target silently never fired —
 * for ANY project — while the mocked tests stayed green. This suite proves
 * events actually fire end-to-end, fleet-wide, on the installed chokidar.
 */

/** One realistic JSONL head line `extractSessionMeta` can parse (incl. cwd). */
function jsonlLine(cwd: string, text: string): string {
  return (
    JSON.stringify({
      type: 'user',
      message: { role: 'user', content: text },
      timestamp: '2026-01-01T00:00:00.000Z',
      cwd,
    }) + '\n'
  );
}

/**
 * Await the next event, failing loudly instead of hanging the suite.
 *
 * This used to re-write the transcript every 1.5s while it waited, on the
 * theory that a write landing in the same instant as its directory could slip
 * past a watcher that was still registering the directory, and that another
 * write would give a working watcher a second chance. The first half was right
 * and the second half was not: when chokidar misses the directory it never
 * watches the file either, so re-writing it produces nothing, and the wait
 * simply ran out (DOR-577). Nothing nudges anything now — the watcher's own
 * reconcile sweep is what recovers a dropped event, and if it did not, this
 * test should say so.
 *
 * The guard stays generous (45s) because it is not the thing under test. This
 * is REAL chokidar on a real filesystem, and the wait measures fs-event
 * delivery on a box that may be running several agents' suites at once; a
 * tighter guard has twice been missed by tens of milliseconds and failed a gate
 * for no reason (DOR-121). What it now bounds is at most one sweep interval
 * plus one debounce, so 45s is many times the real ceiling and a watcher that
 * has genuinely stopped working still trips it.
 */
async function nextEvent(
  it: AsyncIterator<SessionListEvent>,
  label: string
): Promise<SessionListEvent> {
  let guard: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    guard = setTimeout(() => reject(new Error(`timed out waiting for ${label}`)), 45_000);
  });
  try {
    const result = await Promise.race([it.next(), timeout]);
    if (result.done) throw new Error(`stream ended while waiting for ${label}`);
    return result.value;
  } finally {
    // Or every satisfied wait leaves a 45s timer holding the worker open.
    if (guard) clearTimeout(guard);
  }
}

describe('watchSessionList (real chokidar integration)', () => {
  let projectsRoot: string;
  let iterator: AsyncIterator<SessionListEvent> | undefined;

  beforeEach(async () => {
    projectsRoot = await mkdtemp(join(tmpdir(), 'slw-integration-'));
  });

  afterEach(async () => {
    await iterator?.return?.();
    iterator = undefined;
    await rm(projectsRoot, { recursive: true, force: true });
  });

  it('fires live discovery events across project dirs, including ones created mid-watch', async () => {
    // Pre-existing project with one session on disk.
    const dirA = join(projectsRoot, '-work-alpha');
    await mkdir(dirA);
    await writeFile(join(dirA, 'session-a1.jsonl'), jsonlLine('/work/alpha', 'Alpha hello'));

    iterator = watchSessionList(new TranscriptReader(), [projectsRoot])[Symbol.asyncIterator]();

    // 1. Initial fleet-wide inventory, with the TRUE cwd from the JSONL head.
    const initial = await nextEvent(iterator, 'initial inventory');
    expect(initial).toMatchObject({
      type: 'session_upserted',
      session: { id: 'session-a1', cwd: '/work/alpha' },
    });

    // 2. A session created in a BRAND-NEW project dir while watching — the
    // multi-project half of SRV-I4 and the glob regression in one assertion.
    const dirB = join(projectsRoot, '-work-beta');
    await mkdir(dirB);
    await writeFile(join(dirB, 'session-b1.jsonl'), jsonlLine('/work/beta', 'Beta hello'));
    const upserted = await nextEvent(iterator, 'live session_upserted in new dir');
    expect(upserted).toMatchObject({
      type: 'session_upserted',
      session: { id: 'session-b1', cwd: '/work/beta' },
    });

    // 3. Deleting the transcript surfaces as session_removed.
    await unlink(join(dirB, 'session-b1.jsonl'));
    const removed = await nextEvent(iterator, 'session_removed');
    expect(removed).toEqual({ type: 'session_removed', sessionId: 'session-b1' });
    // Overall budget covers three sequential 45s fs-watch guards under load.
  }, 140_000);

  // The DOR-577 scenario at full scale: a project that comes into existence in
  // the SAME TICK the watcher starts, which is what a Claude Code CLI session
  // opening while the server boots looks like. Measured on chokidar 5.0.0, this
  // is the window where it reports nothing at all and never recovers, because
  // `chokidar.watch()` scans the root before it attaches `fs.watch` to it. The
  // assertion is deliberately about the OUTCOME and not the mechanism — either
  // the initial inventory or the reconcile sweep may be the one that finds it,
  // and which one wins depends on how the two directory reads interleave. What
  // must never happen again is neither of them finding it.
  it('finds a project created in the same tick the watcher started', async () => {
    iterator = watchSessionList(new TranscriptReader(), [projectsRoot])[Symbol.asyncIterator]();

    const dirC = join(projectsRoot, '-work-gamma');
    await mkdir(dirC);
    await writeFile(join(dirC, 'session-c1.jsonl'), jsonlLine('/work/gamma', 'Gamma hello'));

    const upserted = await nextEvent(iterator, 'session_upserted for a boot-window project');
    expect(upserted).toMatchObject({
      type: 'session_upserted',
      session: { id: 'session-c1', cwd: '/work/gamma' },
    });
  }, 60_000);
});
