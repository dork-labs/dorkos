/**
 * Which session id survives an eviction — the reason a room binding has to
 * follow the runtime's canonical id rather than the id it was asked with.
 *
 * Claude Code names a session itself on the first turn (`system/init` sets
 * `sdkSessionId`) and files the transcript under that name. Two ids therefore
 * exist for one conversation, and they behave IDENTICALLY while the session is
 * in memory: `findSession` resolves both through the SDK reverse index, so a
 * caller holding the older id resumes fine and nothing looks wrong.
 *
 * The moment the idle sweep evicts it — thirty minutes — they stop behaving
 * the same. The cold path has only the disk to ask, and the disk only knows the
 * canonical id. A caller still holding the older one gets `hasStarted: false`:
 * no resume, a brand-new empty conversation, no error anywhere.
 *
 * Both halves are pinned here because both are load-bearing for rooms: the
 * first is why rebinding a room's session mid-life is safe, and the second is
 * why not rebinding it at all silently wiped an agent's memory of a room every
 * idle window.
 */
import { describe, it, expect, vi } from 'vitest';
import { SessionStore } from '../sessions/session-store.js';
import type { TranscriptReader } from '../sessions/transcript-reader.js';

/** The id a room mints before the turn, and holds until something moves it. */
const REQUESTED = '0f1e2d3c-4b5a-6978-8796-a5b4c3d2e1f0';

/** The id Claude Code assigns on the first turn, and writes the transcript under. */
const CANONICAL = 'sdk-canonical-9f3c';

/**
 * A disk that holds exactly one transcript, under {@link CANONICAL}. Every
 * other id reads as a session that has never run.
 */
function diskHolding(sessionId: string): TranscriptReader {
  return {
    hasTranscript: vi.fn(async (_cwd: string, id: string) =>
      id === sessionId ? { exists: true, root: '/staged/.claude' } : { exists: false }
    ),
  } as unknown as TranscriptReader;
}

describe('resuming a Claude Code session after it has been evicted', () => {
  it('resumes when asked by the canonical id', async () => {
    const store = new SessionStore();
    const disk = diskHolding(CANONICAL);

    const session = await store.ensureForMessage(CANONICAL, disk, '/repo/ana');

    // `hasStarted` IS the resume decision: the sender passes `resume` to the SDK
    // only when it is true (`message-sender.ts`).
    expect(session.hasStarted).toBe(true);
    expect(session.accountRoot).toBe('/staged/.claude');
  });

  it('starts over, silently, when asked by the id the session no longer answers to', async () => {
    // The defect, reduced to its one observable consequence. Nothing throws and
    // nothing is logged as wrong — the agent simply has no memory of anything
    // it said before, which is what a person in the room actually sees.
    const store = new SessionStore();
    const disk = diskHolding(CANONICAL);

    const session = await store.ensureForMessage(REQUESTED, disk, '/repo/ana');

    expect(session.hasStarted).toBe(false);
  });

  it('answers to either id while the session is still in memory', async () => {
    // Why a room can move its binding onto the canonical id the moment the turn
    // reports, without breaking the very next turn: the live session is reached
    // through the SDK reverse index, so both ids land on the same conversation
    // and the disk is not consulted at all.
    const store = new SessionStore();
    const disk = diskHolding(CANONICAL);

    const first = await store.ensureForMessage(REQUESTED, disk, '/repo/ana');
    // What `system/init` plus `onSdkSessionRebind` do on the first turn.
    first.sdkSessionId = CANONICAL;
    await store.rebindSdkSession(REQUESTED, CANONICAL, REQUESTED);

    const probes = vi.mocked(disk.hasTranscript).mock.calls.length;
    const next = await store.ensureForMessage(CANONICAL, disk, '/repo/ana');

    expect(next).toBe(first);
    expect(vi.mocked(disk.hasTranscript).mock.calls).toHaveLength(probes);
    expect(store.getInternalSessionId(REQUESTED)).toBe(CANONICAL);
  });
});
