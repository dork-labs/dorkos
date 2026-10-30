/**
 * An agent's room context gives times on the person's clock and says whose
 * clock that is (FB-66, DOR-3125).
 *
 * Room timestamps are stored in UTC and used to render as a bare `HH:MM`, with
 * nothing saying the zone, so an agent read the person's afternoon as their
 * evening and could not say "today" in their terms. Driven through the real
 * service, dispatcher and context builder; only the turn runner is scripted.
 */
import { afterEach, describe, it, expect, vi } from 'vitest';
import type { RoomContextData } from '@dorkos/shared/additional-context';
import { formatRoomContext } from '../../runtimes/shared/room-context-block.js';
import { agentLookupFor, createRoomHarness, scriptedRunner } from './room-test-harness.js';

const AGENTS = agentLookupFor({
  '/agents/ana': { name: 'ana', displayName: 'Ana', responseMode: 'mention-only' },
});

/** 2026-01-15 18:30 UTC: 13:30 in New York (EST), 03:30 next day in Tokyo. */
const NOW = new Date('2026-01-15T18:30:00.000Z');

async function contextFor(operatorTimeZone?: string): Promise<RoomContextData> {
  const runner = scriptedRunner(() => null);
  const harness = createRoomHarness({
    agents: AGENTS,
    runner,
    ...(operatorTimeZone ? { operatorTimeZone: () => operatorTimeZone } : {}),
  });
  const room = harness.service.createRoom(
    { kind: 'channel', title: 'Release train', members: [], agentPaths: ['/agents/ana'] },
    harness.human
  );
  harness.service.updateRoom(room.id, harness.human, { leadAuthorId: null });
  harness.service.post(room.id, { authorId: harness.human, text: 'ship it this afternoon' });
  harness.service.post(room.id, { authorId: harness.human, text: '@ana can you take this?' });
  await harness.service.triggersIdle();
  const turn = runner.turns.at(-1);
  if (!turn?.roomContext) throw new Error('Ana was never asked');
  return turn.roomContext;
}

describe('room context times are on the person`s clock', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('carries the person`s zone and the moment it was built', async () => {
    vi.useFakeTimers({ now: NOW, toFake: ['Date'] });
    const context = await contextFor('America/New_York');
    expect(context.clock).toEqual({ timeZone: 'America/New_York', now: NOW.toISOString() });
  });

  it('renders every time in that zone and names the zone and today', async () => {
    vi.useFakeTimers({ now: NOW, toFake: ['Date'] });
    const block = formatRoomContext(await contextFor('America/New_York'), { nonce: 'n0nce' });
    expect(block).toContain(
      "Times here are in America/New_York (GMT-5), the person's time zone. " +
        'It is now Thursday, January 15, 2026, 13:30 there.'
    );
    expect(block).toContain('[13:30] ');
    expect(block).not.toContain('[18:30] ');
  });

  it('crosses the date line: Tokyo is already Friday', async () => {
    vi.useFakeTimers({ now: NOW, toFake: ['Date'] });
    const block = formatRoomContext(await contextFor('Asia/Tokyo'), { nonce: 'n0nce' });
    expect(block).toContain('It is now Friday, January 16, 2026, 03:30 there.');
    expect(block).toContain('[03:30] ');
  });

  it('without a zone, times stay UTC and no clock line is added', async () => {
    vi.useFakeTimers({ now: NOW, toFake: ['Date'] });
    const context = await contextFor();
    expect(context.clock).toBeUndefined();
    const block = formatRoomContext(context, { nonce: 'n0nce' });
    expect(block).toContain('[18:30] ');
    expect(block).not.toContain('Times here are in');
  });
});
