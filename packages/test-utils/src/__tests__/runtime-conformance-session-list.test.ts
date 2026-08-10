/**
 * Proof that the conformance suite's session-list gate can FAIL.
 *
 * The suite only ever runs against adapters that are supposed to pass, so a
 * green conformance run is no evidence these assertions fired at all — and for
 * this particular case that is not a hypothetical worry, it is the bug. Under a
 * CI-like `HOME` the claude-code suite reported 21/21 while the schema parse was
 * never reached even once: an empty stream took the early return, and the case
 * passed having checked nothing (DOR-1085).
 *
 * These tests drive the same predicate the suite calls
 * ({@link evaluateSessionListStream}) with real streams — a silent one, a
 * malformed one, a valid one — and assert each verdict. Nothing here
 * re-implements the rules.
 *
 * Streams come from `FakeAgentRuntime` wherever they can, so the silent case is
 * the real shape a runtime presents and not a mock of one: the fake's
 * `subscribeSessionList` is an empty async generator, which is exactly the
 * dead stream this gate exists to catch.
 */
import { describe, expect, it } from 'vitest';
import type { SessionListEvent } from '@dorkos/shared/session-stream';
import { FakeAgentRuntime } from '../fake-agent-runtime.js';
import {
  evaluateSessionListStream,
  sessionListSilenceWaived,
  sessionListWaitMs,
} from '../runtime-conformance.js';

/** A session-list event that satisfies `SessionListEventSchema`. */
const VALID_EVENT: SessionListEvent = {
  type: 'session_upserted',
  session: {
    id: '11111111-1111-4111-8111-111111111111',
    title: 'conformance',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    permissionMode: 'default',
    runtime: 'fake',
  },
};

/** The empty stream a runtime with nothing to report presents. */
function silentStream(): AsyncIterator<SessionListEvent> {
  const runtime = new FakeAgentRuntime();
  return runtime.subscribeSessionList({ permissionMode: 'default' })[Symbol.asyncIterator]();
}

/** A stream that yields `events` and then completes. */
function streamOf(...events: SessionListEvent[]): AsyncIterator<SessionListEvent> {
  return (async function* () {
    yield* events;
  })();
}

describe('sessionListSilenceWaived', () => {
  it('does not waive when nothing was declared', () => {
    expect(sessionListSilenceWaived(undefined)).toBe(false);
  });

  it('does not waive on an empty or whitespace-only reason', () => {
    // Same rule as autonomyDefaultReason: a waiver is a sentence somebody
    // wrote, and '' is a flag somebody flipped.
    expect(sessionListSilenceWaived('')).toBe(false);
    expect(sessionListSilenceWaived('   \n\t ')).toBe(false);
  });

  it('waives on a real sentence', () => {
    expect(sessionListSilenceWaived('the mocked sidecar never writes to its store')).toBe(true);
  });
});

describe('sessionListWaitMs', () => {
  it('waits longer when an event is required than when silence is waived', () => {
    // The strict path decides a real assertion, so it must not red a working
    // stream that was merely slow. Both stay inside the 5000ms `it` budget.
    expect(sessionListWaitMs(undefined)).toBe(2000);
    expect(sessionListWaitMs('declared')).toBe(500);
    expect(sessionListWaitMs(undefined)).toBeLessThan(5000);
  });
});

describe('evaluateSessionListStream', () => {
  it('REJECTS a silent stream when nothing was waived — the DOR-1085 case', async () => {
    // The whole point. Before the inversion this returned "pass".
    const failure = await evaluateSessionListStream(silentStream(), undefined);

    expect(failure).not.toBeNull();
    expect(failure).toContain('emitted nothing');
    expect(failure).toContain('asserted nothing');
    // The message has to tell the next author what to do about it.
    expect(failure).toContain('sessionListSilentReason');
  });

  it('rejects a silent stream whose waiver is whitespace, not a reason', async () => {
    const failure = await evaluateSessionListStream(silentStream(), '   ');

    expect(failure).not.toBeNull();
    expect(failure).toContain('emitted nothing');
  });

  it('accepts a silent stream from a runtime that declared why', async () => {
    const failure = await evaluateSessionListStream(
      silentStream(),
      'the mocked backend never writes to the store this stream observes'
    );

    expect(failure).toBeNull();
  });

  it('rejects an event that fails SessionListEventSchema (DOR-851)', async () => {
    // `updatedAt` must be an ISO datetime. The broadcaster drops what fails to
    // parse, so a runtime emitting this vanishes from the live list in silence.
    const malformed = {
      ...VALID_EVENT,
      session: { ...VALID_EVENT.session, updatedAt: 'not-a-datetime' },
    } as SessionListEvent;

    const failure = await evaluateSessionListStream(streamOf(malformed), undefined);

    expect(failure).not.toBeNull();
    expect(failure).toContain('SessionListEventSchema');
    expect(failure).toContain('SessionListBroadcaster');
  });

  it('rejects a malformed event even from a runtime that waived SILENCE', async () => {
    // The waiver excuses saying nothing. It never excuses saying something
    // wrong — collapsing the two would let a declaration disable the schema
    // check this case exists for.
    const malformed = {
      ...VALID_EVENT,
      session: { ...VALID_EVENT.session, updatedAt: 'not-a-datetime' },
    } as SessionListEvent;

    const failure = await evaluateSessionListStream(streamOf(malformed), 'declared silent');

    expect(failure).not.toBeNull();
    expect(failure).toContain('SessionListEventSchema');
  });

  it('accepts a well-formed event', async () => {
    expect(await evaluateSessionListStream(streamOf(VALID_EVENT), undefined)).toBeNull();
  });

  it('judges the FIRST event, so a valid one cannot be hidden behind a malformed one', async () => {
    const malformed = {
      ...VALID_EVENT,
      session: { ...VALID_EVENT.session, updatedAt: 'not-a-datetime' },
    } as SessionListEvent;

    const failure = await evaluateSessionListStream(streamOf(malformed, VALID_EVENT), undefined);

    expect(failure).toContain('SessionListEventSchema');
  });
});
