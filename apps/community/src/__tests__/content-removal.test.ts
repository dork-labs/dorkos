import { describe, expect, it } from 'vitest';
import { REMOVED_ENTRY_TEXT } from '../content/tombstones.js';
import {
  removalAuthority,
  tombstonePayloadHash,
  type RemovalActor,
  type RemovalTarget,
} from '../content-removal.js';

describe('tombstonePayloadHash', () => {
  // Purpose: the stored hash is exactly what a post of the tombstone would hash (a fixed vector,
  // so a change to the shape or key order is caught), and it depends on the text and the parent.
  it('hashes the post payload shape of the tombstone text and the unchanged parent', () => {
    expect(
      tombstonePayloadHash(REMOVED_ENTRY_TEXT.author, '11111111-1111-4111-8111-111111111111')
    ).toBe('bc8329cf343f0dfddf5c566ea677b9ca6cff4314bf466297757c4d63224cfa21');
    expect(tombstonePayloadHash(REMOVED_ENTRY_TEXT.moderator, null)).toBe(
      '901bc4f89e1c2011b5f348ca378ccfbeb61ec810da31bb7db8ab9adc5f3c6470'
    );
  });

  // Purpose: the three sentences are the fixed copy clients match on; a rewording breaks them.
  it('uses the three fixed sentences', () => {
    expect(REMOVED_ENTRY_TEXT).toEqual({
      author: 'This message was deleted.',
      moderator: 'This message was removed by a community admin.',
      host: 'This message was removed by the host.',
    });
  });
});

describe('removalAuthority (the rank rule)', () => {
  const human = (id: string, role: RemovalActor['role']): RemovalActor => ({
    kind: 'human',
    id,
    role,
  });
  const agent = (id: string): RemovalActor => ({ kind: 'agent', id, role: 'member' });
  const by = (
    humanId: string,
    humanRole: RemovalTarget['humanRole'],
    options: { agentId?: string; humanActive?: boolean } = {}
  ): RemovalTarget => ({
    humanId,
    humanRole,
    agentId: options.agentId ?? null,
    humanActive: options.humanActive ?? true,
  });

  // Purpose: every cell of the spec's table, including the ones a plain role comparison gets
  // wrong: agent content ranked by its owner, a former admin, and an agent's sibling.
  it.each([
    ['a member, their own message', human('m', 'member'), by('m', 'member'), 'author'],
    [
      'a member, their own agent',
      human('m', 'member'),
      by('m', 'member', { agentId: 'a' }),
      'author',
    ],
    ['a member, another member', human('m', 'member'), by('n', 'member'), null],
    ['an agent, its own message', agent('a'), by('m', 'member', { agentId: 'a' }), 'author'],
    ['an agent, a sibling agent', agent('a'), by('m', 'member', { agentId: 'b' }), null],
    ['an agent, its owner', agent('a'), by('m', 'member'), null],
    ['an admin, a member', human('ad', 'admin'), by('m', 'member'), 'moderator'],
    [
      'an admin, a member agent',
      human('ad', 'admin'),
      by('m', 'member', { agentId: 'a' }),
      'moderator',
    ],
    ['an admin, the owner', human('ad', 'admin'), by('o', 'owner'), null],
    ['an admin, the owner agent', human('ad', 'admin'), by('o', 'owner', { agentId: 'a' }), null],
    ['an admin, an active admin', human('ad', 'admin'), by('b', 'admin'), null],
    [
      'an admin, an active admin agent',
      human('ad', 'admin'),
      by('b', 'admin', { agentId: 'a' }),
      null,
    ],
    [
      'an admin, a former admin',
      human('ad', 'admin'),
      by('b', 'admin', { humanActive: false }),
      'moderator',
    ],
    [
      'an admin, an erased husk',
      human('ad', 'admin'),
      by('e', 'member', { humanActive: false }),
      'moderator',
    ],
    ['an admin, their own', human('ad', 'admin'), by('ad', 'admin'), 'author'],
    ['the owner, an admin', human('o', 'owner'), by('b', 'admin'), 'moderator'],
    [
      'the owner, their own agent',
      human('o', 'owner'),
      by('o', 'owner', { agentId: 'a' }),
      'author',
    ],
  ] as const)('%s', (_, actor, target, expected) => {
    expect(removalAuthority(actor, target)).toBe(expected);
  });
});
