/**
 * What happens when Claude Code renames one conversation TWICE.
 *
 * One rename is the common case and was already pinned by
 * `session-store-resume-binding.test.ts`. A second one is the case that broke:
 * the SDK can hand out a fresh id on a resume, so a long-lived session collects
 * a chain of ids — the one the caller first asked with, then each canonical id
 * the SDK assigned. Every one of them has to keep landing on the same live
 * session, because clients legitimately hold different links in that chain (the
 * cockpit adopts the id the 202 reports; a room holds the id it bound).
 *
 * The failure this pins is total, not partial: a second rename used to strand
 * the reverse index so NEITHER current id resolved, the session became
 * unreachable while still alive, and the next resume looked for a transcript
 * under a name the SDK had already stopped using — an agent with no memory of
 * the conversation it was in the middle of.
 */
import { describe, it, expect, vi } from 'vitest';
import { SessionStore } from '../sessions/session-store.js';
import type { TranscriptReader } from '../sessions/transcript-reader.js';
import type { SessionLockManager } from '../../../session/session-lock.js';
import type { SessionSettingsPort } from '@dorkos/shared/agent-runtime';

/** The id the caller minted and asked the first turn with. */
const REQUESTED = '0f1e2d3c-4b5a-6978-8796-a5b4c3d2e1f0';
/** The id the SDK assigned on the first turn. */
const FIRST = 'sdk-canonical-first';
/** The id the SDK assigned when it renamed the session again on a resume. */
const SECOND = 'sdk-canonical-second';

/** A disk that holds one transcript, under `sessionId`. */
function diskHolding(sessionId: string): TranscriptReader {
  return {
    hasTranscript: vi.fn(async (_cwd: string, id: string) =>
      id === sessionId ? { exists: true, root: '/staged/.claude' } : { exists: false }
    ),
  } as unknown as TranscriptReader;
}

/** A no-op settings store that records the rekeys it was asked to perform. */
function recordingSettings(): {
  port: SessionSettingsPort;
  rekeys: Array<[string, string]>;
} {
  const rekeys: Array<[string, string]> = [];
  const port = {
    getSessionSettings: vi.fn(async () => undefined),
    saveSessionSettings: vi.fn(async () => {}),
    rekeySessionSettings: vi.fn(async (from: string, to: string) => {
      rekeys.push([from, to]);
    }),
  } as unknown as SessionSettingsPort;
  return { port, rekeys };
}

/**
 * Drive one live session through both renames exactly as a turn does: the
 * event mapper moves `sdkSessionId`, then the sender reports the rebind with
 * the id THAT turn was asked with — which, after the first rename, is no longer
 * the key the session is stored under.
 */
async function twiceRenamedSession(store: SessionStore, disk: TranscriptReader) {
  const session = await store.ensureForMessage(REQUESTED, disk, '/repo/ana');

  // Turn 1: asked with REQUESTED, SDK names it FIRST.
  session.sdkSessionId = FIRST;
  await store.rebindSdkSession(REQUESTED, FIRST, REQUESTED);

  // Turn 2: the caller adopted the canonical id from turn 1's 202, so this turn
  // is asked with FIRST — an index alias, not the map key.
  session.sdkSessionId = SECOND;
  await store.rebindSdkSession(FIRST, SECOND, FIRST);

  return session;
}

describe('a Claude Code session that the SDK renames twice', () => {
  it('still answers to every id it has ever had', async () => {
    const store = new SessionStore();
    const session = await twiceRenamedSession(store, diskHolding(SECOND));

    for (const id of [REQUESTED, FIRST, SECOND]) {
      expect(store.findSession(id), `no live session for ${id}`).toBe(session);
    }
  });

  it('reports the newest canonical id no matter which id it is asked by', async () => {
    // This is what the 202 returns and what a room binds to. Answering with a
    // stale id (or nothing) is how the binding drifts off the transcript.
    const store = new SessionStore();
    await twiceRenamedSession(store, diskHolding(SECOND));

    for (const id of [REQUESTED, FIRST, SECOND]) {
      expect(store.getInternalSessionId(id), `wrong canonical id for ${id}`).toBe(SECOND);
    }
  });

  it('moves the durable settings row along with each rename', async () => {
    const { port, rekeys } = recordingSettings();
    const store = new SessionStore();
    store.configureSettings(port, 'default');

    await twiceRenamedSession(store, diskHolding(SECOND));

    expect(rekeys).toEqual([
      [REQUESTED, FIRST],
      [FIRST, SECOND],
    ]);
  });

  it('still moves the settings row when the session was evicted mid-turn', async () => {
    // The idle sweep can take a session out from under a turn that is still
    // running. There is nothing left to index, but the operator's chosen
    // permission mode has to follow the id anyway — leaving the row behind on
    // the old id is what silently reverts it on the next cold resume (DOR-493).
    const { port, rekeys } = recordingSettings();
    const store = new SessionStore();
    store.configureSettings(port, 'default');

    await store.rebindSdkSession(FIRST, SECOND, FIRST);

    expect(rekeys).toEqual([[FIRST, SECOND]]);
    expect(store.findSession(SECOND)).toBeUndefined();
  });

  it('resumes from the transcript the SDK actually wrote, after eviction', async () => {
    const store = new SessionStore();
    const disk = diskHolding(SECOND);
    const session = await twiceRenamedSession(store, disk);

    session.lastActivity = 0;
    const evicted = store.checkSessionHealth({ cleanup: vi.fn() } as unknown as SessionLockManager);

    // Every id the session answered to is reported, so the projector and lock
    // filed under any of them are disposed rather than leaked.
    expect(new Set(evicted)).toEqual(new Set([REQUESTED, FIRST, SECOND]));
    // And nothing keeps resolving to the dead session.
    for (const id of [REQUESTED, FIRST, SECOND]) {
      expect(store.findSession(id), `stale index entry for ${id}`).toBeUndefined();
    }

    const resumed = await store.ensureForMessage(SECOND, disk, '/repo/ana');
    expect(resumed.hasStarted).toBe(true);
  });
});
