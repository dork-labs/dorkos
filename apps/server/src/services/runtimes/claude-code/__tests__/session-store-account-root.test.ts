import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ACCOUNT_ROOT_PROBE_LIMIT, SessionStore } from '../sessions/session-store.js';
import type { TranscriptReader } from '../sessions/transcript-reader.js';

/**
 * `AgentSession.accountRoot` — the Claude Code account a live session's turns must
 * run and bill on (spec `claude-code-accounts` D3).
 *
 * The failure being prevented is a money-and-trust one: the operator runs one
 * account per paying client, so a resumed conversation that runs on whichever
 * account happens to be active bills the wrong client. The transcript probe
 * `ensureForMessage` already performs answers which account owns the session; this
 * pins that the answer is KEPT, on both paths that can create a session, and that
 * it survives a mid-turn id rekey.
 */

/** The account a staged transcript is found under. */
const ACCOUNT_B = '/staged/claude2';

/**
 * Minimal TranscriptReader stub. `hasTranscript` answers with the account as well
 * as the verdict — the widened shape `ensureForMessage` reads.
 */
function fakeTranscript(answer: { exists: boolean; root?: string }): {
  reader: TranscriptReader;
  hasTranscript: ReturnType<typeof vi.fn>;
} {
  const hasTranscript = vi.fn().mockResolvedValue(answer);
  return { reader: { hasTranscript } as unknown as TranscriptReader, hasTranscript };
}

describe('SessionStore.accountRoot', () => {
  let store: SessionStore;

  beforeEach(() => {
    store = new SessionStore();
  });

  it('binds the account the transcript probe resolved when auto-creating for a message', async () => {
    const { reader } = fakeTranscript({ exists: true, root: ACCOUNT_B });

    const session = await store.ensureForMessage('s1', reader, '/work');

    expect(session.accountRoot).toBe(ACCOUNT_B);
    // Resume and account are separate facts and both must land.
    expect(session.hasStarted).toBe(true);
  });

  it('leaves the account undefined for a session with no transcript anywhere', async () => {
    // A brand-new session runs on the ACTIVE account — that is what makes it
    // active — so "unknown" is the honest answer here, not a guess.
    const { reader } = fakeTranscript({ exists: false });

    const session = await store.ensureForMessage('s-new', reader, '/work');

    expect(session.accountRoot).toBeUndefined();
    expect(session.hasStarted).toBe(false);
  });

  it('binds the account on the DEFERRED check, the path updateSession creates', async () => {
    // `updateSession` can auto-create a session with no cwd at all, deferring the
    // transcript check to the first message. That deferred check is the FIRST place
    // the account can be known, so skipping it there would leave a resumed session
    // permanently unattributed.
    await store.updateSession('s2', { permissionMode: 'plan' });
    expect(store.findSession('s2')?.accountRoot).toBeUndefined();

    const { reader, hasTranscript } = fakeTranscript({ exists: true, root: ACCOUNT_B });
    const session = await store.ensureForMessage('s2', reader, '/work');

    expect(hasTranscript).toHaveBeenCalledWith('/work', 's2');
    expect(session.accountRoot).toBe(ACCOUNT_B);
    expect(session.hasStarted).toBe(true);
  });

  // DOR-2065, the 2026-10-05 overnight builders. A chat started on a chosen
  // account had no transcript when its record was made, so the record never
  // learned its account. A message queued behind the first turn then ran the
  // launch ladder, landed on the default account, relaunched the warm process
  // there (killing its background shells) and the CLI answered "No
  // conversation found". The transcript the first turn wrote settles it.
  it('learns the account from the transcript its own first turn wrote', async () => {
    const before = fakeTranscript({ exists: false });
    const session = await store.ensureForMessage('s-fresh', before.reader, '/work');
    expect(session.accountRoot).toBeUndefined();

    // The first turn ran (its `system/init` marks the session started) and the
    // CLI wrote the transcript under the account the launch picked.
    session.hasStarted = true;
    const after = fakeTranscript({ exists: true, root: ACCOUNT_B });
    const next = await store.ensureForMessage('s-fresh', after.reader, '/work');

    expect(after.hasTranscript).toHaveBeenCalledWith('/work', 's-fresh');
    expect(next.accountRoot).toBe(ACCOUNT_B);
  });

  it('tries again after a miss, so a transcript written late is still found', async () => {
    // A message queued behind the first turn can land after `system/init` but
    // before the CLI has written the transcript. That miss must not be final.
    const session = await store.ensureForMessage(
      's-late',
      fakeTranscript({ exists: false }).reader,
      '/work'
    );
    session.hasStarted = true;
    const miss = fakeTranscript({ exists: false });
    await store.ensureForMessage('s-late', miss.reader, '/work');
    expect(miss.hasTranscript).toHaveBeenCalledTimes(1);

    const found = fakeTranscript({ exists: true, root: ACCOUNT_B });
    const next = await store.ensureForMessage('s-late', found.reader, '/work');
    expect(found.hasTranscript).toHaveBeenCalledTimes(1);
    expect(next.accountRoot).toBe(ACCOUNT_B);
  });

  it('stops probing a started session after a bounded number of misses', async () => {
    // A transcript that is never found must not cost a disk scan per message.
    const session = await store.ensureForMessage(
      's-never',
      fakeTranscript({ exists: false }).reader,
      '/work'
    );
    session.hasStarted = true;
    const misses = fakeTranscript({ exists: false });
    for (let i = 0; i < 10; i += 1) {
      await store.ensureForMessage('s-never', misses.reader, '/work');
    }
    expect(misses.hasTranscript).toHaveBeenCalledTimes(ACCOUNT_ROOT_PROBE_LIMIT);
  });

  it('does not probe again for a session that has not started yet', async () => {
    // Pinning a session before any transcript exists would keep a launch that
    // died early from being retried on the account a person then picks.
    await store.ensureForMessage('s-unstarted', fakeTranscript({ exists: false }).reader, '/work');
    const again = fakeTranscript({ exists: true, root: ACCOUNT_B });

    const session = await store.ensureForMessage('s-unstarted', again.reader, '/work');

    expect(again.hasTranscript).not.toHaveBeenCalled();
    expect(session.accountRoot).toBeUndefined();
  });

  it('survives a mid-turn SDK id rekey', async () => {
    // `rebindSdkSession` moves INDEX ENTRIES, not the session object, so the field
    // rides along. Asserted rather than assumed: a rekey that copied state instead
    // of re-pointing the index would silently drop the account mid-turn, and the
    // rest of that turn would bill wherever the retry resolved.
    const { reader } = fakeTranscript({ exists: true, root: ACCOUNT_B });
    await store.ensureForMessage('request-uuid', reader, '/work');

    await store.rebindSdkSession('request-uuid', 'sdk-canonical-id', 'request-uuid');

    expect(store.findSession('sdk-canonical-id')?.accountRoot).toBe(ACCOUNT_B);
    expect(store.findSession('request-uuid')?.accountRoot).toBe(ACCOUNT_B);
  });

  it('keeps each session on its own account when two accounts are in play', async () => {
    // The one that matters: two live sessions from different clients must not
    // collapse onto one account.
    const inA = fakeTranscript({ exists: true, root: '/staged/claude' });
    const inB = fakeTranscript({ exists: true, root: ACCOUNT_B });

    const a = await store.ensureForMessage('s-a', inA.reader, '/work');
    const b = await store.ensureForMessage('s-b', inB.reader, '/work');

    expect([a.accountRoot, b.accountRoot]).toEqual(['/staged/claude', ACCOUNT_B]);
  });
});
