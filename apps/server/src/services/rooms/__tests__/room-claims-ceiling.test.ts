/**
 * The second claim ceiling as a count (DOR-2104): how many turns one agent may
 * run in its own directory at once, asked of the claim map directly.
 *
 * The dispatcher's behaviour around it — holds, release, a limit moved while
 * turns are live — is covered end to end in `room-hold-elsewhere.test.ts`. This
 * pins the arithmetic that file cannot isolate: the boundary, the room ceiling
 * that no limit relaxes, and what a nonsense limit does.
 */
import { describe, it, expect } from 'vitest';
import { agentKey, claimBusyWith, type ActiveClaim } from '../room-claims.js';

const ANA = '/agents/ana';

/** A claim map with one claim per room, in the order given (oldest first). */
function claimsIn(...rooms: Array<{ roomId: string; agentPath?: string }>) {
  const claims = new Map<string, ActiveClaim>();
  for (const { roomId, agentPath = ANA } of rooms) {
    // Only the fields the ceiling reads; the rest of a claim is turn bookkeeping.
    claims.set(agentKey(roomId, 'ana'), { roomId, authorId: 'ana', agentPath } as ActiveClaim);
  }
  return claims;
}

describe('claimBusyWith — how many conversations one agent may work in at once', () => {
  it('at a limit of one, any turn in another room is in the way (the old behaviour)', () => {
    const busy = claimBusyWith(claimsIn({ roomId: 'a' }), 'b', 'ana', ANA, 1);
    expect(busy).toMatchObject({ where: 'elsewhere', blocking: { roomId: 'a' } });
  });

  it('at a limit of three, frees the agent until the third turn and holds at it', () => {
    expect(claimBusyWith(claimsIn({ roomId: 'a' }), 'z', 'ana', ANA, 3)).toBeNull();
    expect(
      claimBusyWith(claimsIn({ roomId: 'a' }, { roomId: 'b' }), 'z', 'ana', ANA, 3)
    ).toBeNull();
    const busy = claimBusyWith(
      claimsIn({ roomId: 'a' }, { roomId: 'b' }, { roomId: 'c' }),
      'z',
      'ana',
      ANA,
      3
    );
    // The oldest turn is the one named, because it has run longest.
    expect(busy).toMatchObject({ where: 'elsewhere', blocking: { roomId: 'a' } });
  });

  it('holds while the count is ABOVE the limit — a limit lowered under live turns', () => {
    const live = claimsIn({ roomId: 'a' }, { roomId: 'b' }, { roomId: 'c' });
    expect(claimBusyWith(live, 'z', 'ana', ANA, 1)?.where).toBe('elsewhere');
  });

  it('never lets a second turn start in the same room, whatever the limit', () => {
    const busy = claimBusyWith(claimsIn({ roomId: 'a' }), 'a', 'ana', ANA, 8);
    expect(busy).toMatchObject({ where: 'here', blocking: { roomId: 'a' } });
  });

  it('counts only turns in this agent’s own directory', () => {
    const claims = claimsIn({ roomId: 'a', agentPath: '/agents/bo' });
    expect(claimBusyWith(claims, 'b', 'ana', ANA, 1)).toBeNull();
  });

  it('reads a limit below one as one, so a bad value can only tighten the ceiling', () => {
    for (const limit of [0, -2, 0.5, Number.NaN]) {
      // One turn elsewhere is in the way…
      expect(claimBusyWith(claimsIn({ roomId: 'a' }), 'b', 'ana', ANA, limit)?.where).toBe(
        'elsewhere'
      );
      // …and no turn at all is not: a bad value must not wedge the agent shut.
      expect(claimBusyWith(new Map(), 'b', 'ana', ANA, limit)).toBeNull();
    }
  });
});
