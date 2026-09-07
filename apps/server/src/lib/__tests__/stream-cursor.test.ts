/**
 * The `id:` frame's shape, and the two things a resume cursor has to name
 * before it may be honoured: the server PROCESS (epoch) and the seq space
 * INSIDE it (generation).
 *
 * The route-level consequences live in `routes/__tests__/sessions-events-generation.test.ts`;
 * this file pins the parsing, which is where a cursor that should have been
 * refused would first be let through.
 */
import { describe, it, expect } from 'vitest';
import {
  cursorMatchesGeneration,
  mintStreamGeneration,
  parseResumeCursor,
  streamFrameId,
  STREAM_EPOCH,
  UNOWNED_STREAM_GENERATION,
} from '../stream-cursor.js';

const SESSION_ID = '00000000-0000-4000-8000-000000000001';
const ROOM_ID = '01K1BXCQ4M7GKZ9V0S2R7XQ3AB';

describe('streamFrameId', () => {
  it('writes the four-field shape a resume cursor is read back out of', () => {
    expect(streamFrameId(SESSION_ID, 'g7', 43)).toBe(`${SESSION_ID}-${STREAM_EPOCH}-g7-43`);
  });
});

describe('mintStreamGeneration', () => {
  it('never issues the unowned generation, and never repeats itself', () => {
    // Both halves matter: `g0` means "no instance owns this seq space", so an
    // instance that minted it would be indistinguishable from a room's durable
    // log, and a repeated value would let a retired projector's cursor match a
    // live one — the exact confusion this whole mechanism exists to prevent.
    const minted = [mintStreamGeneration(), mintStreamGeneration(), mintStreamGeneration()];
    expect(minted).not.toContain(UNOWNED_STREAM_GENERATION);
    expect(new Set(minted).size).toBe(3);
  });
});

describe('parseResumeCursor', () => {
  it('reads seq and generation out of a current frame id, UUID hyphens and all', () => {
    expect(parseResumeCursor(streamFrameId(SESSION_ID, 'g7', 43), undefined)).toEqual({
      seq: 43,
      generation: 'g7',
    });
  });

  it('refuses a cursor from a previous server process', () => {
    const stale = `${SESSION_ID}-${STREAM_EPOCH - 1}-g7-43`;
    expect(parseResumeCursor(stale, undefined)).toBeUndefined();
  });

  it('refuses a cursor in the pre-generation format outright', () => {
    // A tab open across the deploy comes back with `<id>-<epoch>-<seq>`. It
    // names no seq space, so it can never be shown to belong to the one about to
    // answer — and letting it through would hand the reader a plausible number
    // in a counter it has never seen. Refused at the parse, so no caller has to
    // remember to check.
    expect(parseResumeCursor(`${SESSION_ID}-${STREAM_EPOCH}-43`, undefined)).toBeUndefined();
    expect(parseResumeCursor(`${ROOM_ID}-${STREAM_EPOCH}-43`, undefined)).toBeUndefined();
  });

  it('refuses a cursor minted for another resource when the caller names one', () => {
    const otherRoom = streamFrameId('01K1BXCQ4M7GKZ9V0S2R7XQ99', UNOWNED_STREAM_GENERATION, 4);
    expect(parseResumeCursor(otherRoom, undefined, { resourceId: ROOM_ID })).toBeUndefined();
  });

  it('reads ?after= as a cursor that names no seq space', () => {
    // Deliberately generation-less: `?after=` never claimed one, and the
    // stream's own replay-window check is the whole contract for it.
    expect(parseResumeCursor(undefined, '12')).toEqual({ seq: 12, generation: null });
    expect(parseResumeCursor(undefined, '')).toBeUndefined();
    expect(parseResumeCursor(undefined, 'nonsense')).toBeUndefined();
    expect(parseResumeCursor(undefined, '-1')).toBeUndefined();
  });

  it('lets the header win over ?after=', () => {
    expect(parseResumeCursor(streamFrameId(SESSION_ID, 'g2', 9), '99')).toEqual({
      seq: 9,
      generation: 'g2',
    });
  });
});

describe('cursorMatchesGeneration', () => {
  it('honours a cursor that names the serving seq space, and only that one', () => {
    expect(cursorMatchesGeneration({ seq: 5, generation: 'g2' }, 'g2')).toBe(true);
    expect(cursorMatchesGeneration({ seq: 5, generation: 'g1' }, 'g2')).toBe(false);
    expect(cursorMatchesGeneration({ seq: 5, generation: UNOWNED_STREAM_GENERATION }, 'g2')).toBe(
      false
    );
  });

  it('lets a ?after= cursor through, because it claimed nothing to contradict', () => {
    expect(cursorMatchesGeneration({ seq: 5, generation: null }, 'g2')).toBe(true);
  });
});
