import { describe, expect, it } from 'vitest';
import { moveResponseOf } from '../community-move-methods';

/** A refusal as the move route sends one: a problem document (DOR-4979). */
function refusal(code: string, status: number, detail: string, extra: object = {}) {
  return { type: `urn:dorkos:problem:${code}`, title: 'Refused.', status, code, detail, ...extra };
}

describe('reading a refused move', () => {
  // Purpose: the refusal carries only numbers; the person still reads the sizes. Fails if the
  // sizes are dropped, or the fixed sentence is shown in their place.
  it('says how much room the export needs and how much there is', () => {
    const answer = moveResponseOf(
      refusal('disk_full', 507, 'This computer needs more free space to hold the export.', {
        neededBytes: 536_870_947,
        freeBytes: 536_870_946,
      })
    );
    expect(answer).toEqual({
      ok: false,
      message:
        'This computer doesn’t have room to hold the export. It needs 537 MB free and has 536 MB. Free up some space, then try again.',
    });
  });

  it('says how large the export is and the most DorkOS takes, and keeps mayExist', () => {
    const answer = moveResponseOf(
      refusal('request_too_large', 413, 'This export is larger than DorkOS can move.', {
        archiveBytes: 35,
        limitBytes: 34,
        mayExist: true,
      })
    );
    expect(answer).toEqual({
      ok: false,
      message:
        'This export is too large to move. It is 35 bytes, and the most DorkOS takes is 34 bytes.',
      mayExist: true,
    });
  });

  it('reads any other refusal as its own sentence, and passes an envelope through', () => {
    expect(
      moveResponseOf(refusal('move_pending', 409, 'Confirm or cancel the pending move first.'))
    ).toEqual({
      ok: false,
      message: 'Confirm or cancel the pending move first.',
    });
    // Sizes missing: the fixed sentence, never a sentence with gaps.
    expect(
      moveResponseOf(refusal('disk_full', 507, 'This computer needs more free space.'))
    ).toEqual({
      ok: false,
      message: 'This computer needs more free space.',
    });
    const ok = { ok: true, move: { moveId: 'move_1' } };
    expect(moveResponseOf(ok)).toBe(ok);
    expect(moveResponseOf('not json')).toBeNull();
  });
});
