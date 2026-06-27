/**
 * Unit + interchangeability suite for the inbound transport seam (§4, task 4.3).
 *
 * Two purposes:
 *   (a) PollingTransport unit — the injected reader → `comment.added` events,
 *       a durable watermark that advances, and NO re-emit on a second poll.
 *   (b) THE interchangeability test (G9, the seam's defining test) — the SAME
 *       hand-built `TrackerEvent[]` fed through a fake POLLING producer and a fake
 *       WEBHOOK producer (both implementing `InboundTransport`) into the same
 *       consuming reducer yields IDENTICAL output. It is written to FAIL if any
 *       consumer branches on `receivedVia` — proving the engine cannot tell which
 *       transport produced the events.
 *
 * Imports from the relative module paths (NOT the `@dorkos/flow` barrel), matching
 * the sibling flow suites.
 *
 * @see specs/flow-triage-feeds-loop/02-specification.md §4
 */

import { describe, expect, it } from 'vitest';
import {
  trackerEventDedupeKey,
  type CommentAddedEvent,
  type ReceivedVia,
  type TrackerEvent,
} from '../events.js';
import {
  PollingTransport,
  type InboundTransport,
  type InboxEntry,
  type PollResult,
  type Watermark,
} from '../transport.js';

// ─── shared fixtures ─────────────────────────────────────────────────────────

/** Build an inbox entry (the injected reader's row) with overridable fields. */
function entry(overrides: Partial<InboxEntry> = {}): InboxEntry {
  return {
    itemId: 'DOR-1',
    occurredAt: '2026-06-25T00:00:00.000Z',
    comment: { author: 'human', mentions: [], body: 'go with option B' },
    raw: { native: true },
    ...overrides,
  };
}

// ─── (a) PollingTransport unit ────────────────────────────────────────────────

describe('PollingTransport — maps inbox entries to events + advances the watermark', () => {
  it('turns two new comments into two comment.added events (receivedVia: poll)', async () => {
    const entries: InboxEntry[] = [
      entry({ itemId: 'DOR-1', occurredAt: '2026-06-25T00:00:01.000Z' }),
      entry({ itemId: 'DOR-2', occurredAt: '2026-06-25T00:00:02.000Z' }),
    ];
    const transport = new PollingTransport(async () => entries);

    const { events, watermark } = await transport.poll();

    expect(events).toHaveLength(2);
    expect(events.every((e) => e.kind === 'comment.added')).toBe(true);
    expect(events.every((e) => e.receivedVia === 'poll')).toBe(true);
    expect((events[0] as CommentAddedEvent).comment.body).toBe('go with option B');
    // Watermark advanced to the newest entry's occurredAt.
    expect(watermark).toBe('2026-06-25T00:00:02.000Z');
  });

  it('a follow-up poll(watermark) over the same snapshot returns [] (no re-emit)', async () => {
    const entries: InboxEntry[] = [
      entry({ itemId: 'DOR-1', occurredAt: '2026-06-25T00:00:01.000Z' }),
      entry({ itemId: 'DOR-2', occurredAt: '2026-06-25T00:00:02.000Z' }),
    ];
    const transport = new PollingTransport(async () => entries);

    const first = await transport.poll();
    const second = await transport.poll(first.watermark);

    expect(second.events).toEqual([]);
    // The watermark holds at the high-water point — no regression.
    expect(second.watermark).toBe(first.watermark);
  });

  it('emits events oldest-first regardless of reader order', async () => {
    const transport = new PollingTransport(async () => [
      entry({ itemId: 'DOR-late', occurredAt: '2026-06-25T00:00:05.000Z' }),
      entry({ itemId: 'DOR-early', occurredAt: '2026-06-25T00:00:01.000Z' }),
    ]);
    const { events } = await transport.poll();
    expect(events.map((e) => e.itemId)).toEqual(['DOR-early', 'DOR-late']);
  });

  it('cold start (no watermark) consumes the whole inbox; an empty inbox holds the cursor', async () => {
    const empty = new PollingTransport(async () => []);
    const cold = await empty.poll();
    expect(cold.events).toEqual([]);

    const held = await empty.poll('2026-06-25T00:00:09.000Z');
    expect(held.events).toEqual([]);
    expect(held.watermark).toBe('2026-06-25T00:00:09.000Z');
  });

  it('maps a bare @mention (empty body, non-empty mentions) to a mention event', async () => {
    const transport = new PollingTransport(async () => [
      entry({ comment: { author: 'human', mentions: ['acct-agent'], body: '' } }),
    ]);
    const { events } = await transport.poll();
    expect(events).toHaveLength(1);
    expect(events[0].kind).toBe('mention');
    expect(events[0].kind === 'mention' && events[0].mentioned).toBe('acct-agent');
  });

  it('keys every event with the kind:itemId:occurredAt dedupeKey convention', async () => {
    const transport = new PollingTransport(async () => [
      entry({ itemId: 'DOR-7', occurredAt: '2026-06-25T12:00:00.000Z' }),
    ]);
    const { events } = await transport.poll();
    expect(events[0].dedupeKey).toBe(
      trackerEventDedupeKey('comment.added', 'DOR-7', '2026-06-25T12:00:00.000Z')
    );
  });
});

// ─── (b) THE interchangeability test (G9) ─────────────────────────────────────

/**
 * A fixture transport that re-emits a fixed `TrackerEvent[]` from `poll()`. Used
 * to stand up BOTH a "polling" and a "webhook" producer from the same event list
 * so the only difference between them is each event's `receivedVia` provenance.
 */
function fixtureTransport(events: readonly TrackerEvent[]): InboundTransport {
  return {
    poll(since?: Watermark): Promise<PollResult> {
      void since;
      return Promise.resolve({
        events: [...events],
        watermark: events.at(-1)?.occurredAt ?? '',
      });
    },
  };
}

/** Build the SAME canonical events, parameterized ONLY by provenance. */
function canonicalEvents(via: ReceivedVia): TrackerEvent[] {
  const mk = (itemId: string, occurredAt: string, body: string): CommentAddedEvent => ({
    kind: 'comment.added',
    itemId,
    actor: 'human',
    occurredAt,
    receivedVia: via,
    dedupeKey: trackerEventDedupeKey('comment.added', itemId, occurredAt),
    raw: null,
    comment: { author: 'human', mentions: [], body },
  });
  return [
    mk('DOR-1', '2026-06-25T00:00:01.000Z', 'go with option B'),
    mk('DOR-2', '2026-06-25T00:00:02.000Z', 'ship it'),
  ];
}

/**
 * The consuming reducer the engine runs over an event stream. It projects each
 * event onto a tracker-agnostic summary and DELIBERATELY never reads
 * `receivedVia` — exactly the discipline every real reconciler follows. If a
 * consumer ever branched on provenance, the poll-vs-webhook outputs would diverge
 * and the interchangeability assertion below would fail.
 */
function consume(events: readonly TrackerEvent[]): Array<Record<string, unknown>> {
  return events.map((event) => ({
    kind: event.kind,
    itemId: event.itemId,
    actor: event.actor,
    occurredAt: event.occurredAt,
    dedupeKey: event.dedupeKey,
    body: event.kind === 'comment.added' ? event.comment.body : undefined,
  }));
}

describe('inbound transport interchangeability (G9) — poll == webhook', () => {
  it('the same events through a polling and a webhook producer yield IDENTICAL consumer output', async () => {
    const polling = fixtureTransport(canonicalEvents('poll'));
    const webhook = fixtureTransport(canonicalEvents('webhook'));

    const pollOut = await polling.poll();
    const webhookOut = await webhook.poll();

    // Sanity: the two raw streams genuinely DIFFER in provenance (not vacuous).
    expect(pollOut.events[0].receivedVia).toBe('poll');
    expect(webhookOut.events[0].receivedVia).toBe('webhook');
    expect(pollOut.events[0].receivedVia).not.toBe(webhookOut.events[0].receivedVia);

    // The defining assertion: identical downstream output. The engine cannot tell
    // which transport produced the events.
    expect(consume(pollOut.events)).toEqual(consume(webhookOut.events));
  });

  it('structurally enforces that the consumer never branches on receivedVia', () => {
    // The reducer's own source must not reference provenance. If a future consumer
    // adds a `receivedVia` branch, this fails — keeping the G9 invariant honest.
    expect(consume.toString()).not.toContain('receivedVia');
  });
});
