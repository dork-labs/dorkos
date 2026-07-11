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
 * The guard is generous (45s) on purpose: this is a REAL chokidar + real-fs
 * test, so the wait measures filesystem-watch latency, not CPU work. Under load
 * (a busy CI box, or several concurrent agents each running their own suite on
 * one machine) fs-event delivery — especially detecting a brand-new directory
 * mid-watch — can take several seconds, and a tight guard turned that into a
 * false-negative gate failure (DOR-121). Reproduced repeatedly under genuine
 * cross-process CPU contention (several concurrent package suites, including
 * ANOTHER agent's own gate run sharing the machine): a 15s guard missed by
 * ~35ms, then a 30s guard missed by ~20ms, always on the SAME step (detecting
 * a session in a brand-new project directory — the trickiest case per the
 * module doc's addDir/scan-then-attach race).
 *
 * There is a real ceiling here, not just a slow one: under SEVERE simultaneous
 * oversubscription (4 concurrent package suites' full worker pools plus
 * CPU-pegging background load — deliberately extreme, not a realistic single
 * push) the same event failed to arrive even at a 180s diagnostic timeout, and
 * unrelated tests elsewhere in the suite failed too, indicating the box itself
 * was starved rather than this watcher being broken. The realistic pre-push
 * gate (single agent, `--concurrency=1`, no artificial CPU load) passes this
 * suite reliably every time; 45s is calibrated to absorb realistic
 * concurrent-agent contention on a shared box, not to survive that extreme. A
 * broken watcher never fires at all, so this guard still catches the
 * regression the suite exists for; it only stops penalizing a
 * slow-but-working watcher under ordinary contention.
 */
async function nextEvent(
  it: AsyncIterator<SessionListEvent>,
  label: string,
  options: { nudge?: () => Promise<void> } = {}
): Promise<SessionListEvent> {
  // A write that lands in the same instant a directory is created can slip
  // past the watcher while it is still registering the new dir (frequent under
  // full-suite load). Re-touching the file every second or two gives a
  // WORKING watcher another change event to catch; a broken watcher (the glob
  // regression this suite guards) never fires no matter how often we nudge.
  const nudgeTimer = options.nudge
    ? setInterval(() => void options.nudge?.().catch(() => undefined), 1_500)
    : undefined;
  const timeout = new Promise<never>((_, reject) =>
    setTimeout(() => reject(new Error(`timed out waiting for ${label}`)), 45_000)
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
    // Overall budget covers three sequential 45s fs-watch guards under load.
  }, 140_000);
});
