import { expect, it } from 'vitest';
import { externalNaturalKey } from '../author-registry.js';
import { roomTurnStarter } from '../room-trigger/turn-starter.js';
import { roomTurnMarksOf } from '../limits/teammate-turn.js';

const keys: Record<string, string> = {
  local: 'owner',
  telegram: externalNaturalKey({
    platformType: 'telegram',
    instanceId: 'sample',
    platformUserId: 'sample-person',
    displayName: 'Sample person',
  }),
  slack: externalNaturalKey({
    platformType: 'slack',
    instanceId: 'sample',
    platformUserId: 'sample-person',
    displayName: 'Sample person',
  }),
  other: externalNaturalKey({
    platformType: 'sample-platform',
    instanceId: 'sample',
    platformUserId: 'sample-person',
    displayName: 'Sample person',
  }),
};
const authors = { getById: (id: string) => (keys[id] ? { naturalKey: keys[id]! } : null) };
it.each([
  [['local'], undefined],
  [['telegram'], 'telegram'],
  [['slack'], 'slack'],
  [['telegram', 'telegram'], 'telegram'],
  [['local', 'telegram'], 'room-messages'],
  [['telegram', 'slack'], 'room-messages'],
  [['other'], 'outside-message'],
  [['missing'], 'unknown'],
])('uses the stored authors of %j', (ids, expected) => {
  expect(
    roomTurnStarter(
      authors,
      (ids as string[]).map((authorId) => ({ authorId }))
    )
  ).toBe(expected);
});
it('carries display provenance without changing the room’s power marks', () => {
  expect(roomTurnMarksOf({ turnStarter: 'telegram', untrustedText: true })).toEqual({
    turnStarter: 'telegram',
    untrustedText: true,
  });
  expect(roomTurnMarksOf({ turnStarter: 'slack' })).toEqual({ turnStarter: 'slack' });
});

it('uses unknown if the author store cannot answer, without failing the turn', () => {
  expect(
    roomTurnStarter(
      {
        getById: () => {
          throw new Error('sample unavailable');
        },
      },
      [{ authorId: 'sample' }]
    )
  ).toBe('unknown');
});
