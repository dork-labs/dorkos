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
 * The guard is generous (15s) on purpose: this is a REAL chokidar + real-fs
 * test, so the wait measures filesystem-watch latency, not CPU work. Under load
 * (a busy CI box or a developer running concurrent agents) fs-event delivery —
 * especially detecting a brand-new directory mid-watch — can take several
 * seconds, and a tight guard turned that into a false-negative gate failure
 * (DOR-121). A broken watcher never fires at all, so a longer guard still
 * catches the regression this suite exists for; it only stops penalizing a
 * slow-but-working watcher.
 */
async function nextEvent(
  it: AsyncIterator<SessionListEvent>,
  label: string,
  options: { nudge?: () => Promise<void> } = {}
): Promise<SessionListEvent> {
  // A write that lands in the same instant a directory is created can slip
  // past the watcher while it is still registering the new dir (frequent under
  // full-suite load). Re-touching the file every few seconds gives a WORKING
  // watcher another change event to catch; a broken watcher (the glob
  // regression this suite guards) never fires no matter how often we nudge.
  const nudgeTimer = options.nudge
    ? setInterval(() => void options.nudge?.().catch(() => undefined), 3_000)
    : undefined;
  const timeout = new Promise<never>((_, reject) =>
    setTimeout(() => reject(new Error(`timed out waiting for ${label}`)), 15_000)
  );
  try {
    const result = await Promise.race([it.next(), timeout]);
    if (result.done) throw new Error(`stream ended while waiting for ${label}`);
    return result.value;
  } finally {
    if (nudgeTimer) clearInterval(nudgeTimer);
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

    iterator = watchSessionList(new TranscriptReader(), projectsRoot)[Symbol.asyncIterator]();

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
    const writeB1 = () =>
      writeFile(join(dirB, 'session-b1.jsonl'), jsonlLine('/work/beta', 'Beta hello'));
    await writeB1();
    const upserted = await nextEvent(iterator, 'live session_upserted in new dir', {
      nudge: writeB1,
    });
    expect(upserted).toMatchObject({
      type: 'session_upserted',
      session: { id: 'session-b1', cwd: '/work/beta' },
    });

    // 3. Deleting the transcript surfaces as session_removed.
    await unlink(join(dirB, 'session-b1.jsonl'));
    const removed = await nextEvent(iterator, 'session_removed');
    expect(removed).toEqual({ type: 'session_removed', sessionId: 'session-b1' });
    // Overall budget covers three sequential 15s fs-watch guards under load.
  }, 45_000);
});
