import { describe, expect, it } from 'vitest';
import { removalAuthority } from '../content-removal.js';
import { ERASED_ENTRY_TEXT, REMOVED_ENTRY_TEXT } from '../content/tombstones.js';
import {
  expectedTombstone,
  isRemovedEntry,
  REMOVAL_COPY,
  removalAction,
  type RemovalViewer,
} from './entry-removal.js';
import type { Entry, Member } from './types.js';

const ids = {
  owner: '10000000-0000-4000-8000-000000000001',
  admin: '10000000-0000-4000-8000-000000000002',
  otherAdmin: '10000000-0000-4000-8000-000000000003',
  member: '10000000-0000-4000-8000-000000000004',
  otherMember: '10000000-0000-4000-8000-000000000005',
  ownerAgent: '20000000-0000-4000-8000-000000000001',
  adminAgent: '20000000-0000-4000-8000-000000000002',
  otherAdminAgent: '20000000-0000-4000-8000-000000000003',
  memberAgent: '20000000-0000-4000-8000-000000000004',
} as const;
type Role = NonNullable<Member['role']>;
const humans: Record<string, Role> = {
  [ids.owner]: 'owner',
  [ids.admin]: 'admin',
  [ids.otherAdmin]: 'admin',
  [ids.member]: 'member',
  [ids.otherMember]: 'member',
};
const agents: Record<string, string> = {
  [ids.ownerAgent]: ids.owner,
  [ids.adminAgent]: ids.admin,
  [ids.otherAdminAgent]: ids.otherAdmin,
  [ids.memberAgent]: ids.member,
};
const humanRoles: RemovalViewer['humanRoles'] = new Map(Object.entries(humans));
const agentOwners: RemovalViewer['agentOwners'] = new Map(Object.entries(agents));

function entry(
  authorMemberId: string,
  text = 'Hello',
  extra: { mentions?: string[]; files?: number } = {}
): Entry {
  return {
    id: '30000000-0000-4000-8000-000000000001',
    channelId: '40000000-0000-4000-8000-000000000001',
    seq: 1,
    authorMemberId,
    authorDisplayName: 'Someone',
    authorKind: authorMemberId in agents ? 'agent' : 'human',
    text,
    mentions: extra.mentions ?? [],
    parentEntryId: null,
    threadRootEntryId: null,
    createdAt: '2026-09-24T12:00:00.000Z',
    cursor: 'cursor',
    attachments: Array.from({ length: extra.files ?? 1 }, (_, index) => ({
      id: `50000000-0000-4000-8000-00000000000${index + 1}`,
      name: 'notes.txt',
      contentType: 'text/plain',
      byteSize: 4,
      checksum: '60000000-0000-4000-8000-000000000001',
      createdAt: '2026-09-24T12:00:00.000Z',
    })),
  };
}

function viewerFor(memberId: string): RemovalViewer {
  return {
    memberId,
    role: humans[memberId],
    ownAgentIds: new Set(
      Object.entries(agents)
        .filter(([, owner]) => owner === memberId)
        .map(([id]) => id)
    ),
    humanRoles,
    agentOwners,
  };
}

describe('removalAction', () => {
  // Purpose: with a complete roster the browser offers exactly what the server's rank rule
  // allows, for every viewer and every author. A menu the server would refuse, or a missing one
  // it would allow, fails here.
  it('offers exactly the actions the server allows, for every viewer and author', () => {
    for (const viewer of Object.keys(humans)) {
      for (const author of [...Object.keys(humans), ...Object.keys(agents)]) {
        const humanId = agents[author] ?? author;
        const server = removalAuthority(
          { kind: 'human', id: viewer, role: humans[viewer] },
          {
            agentId: author in agents ? author : null,
            humanId,
            humanRole: humans[humanId],
            humanActive: true,
          }
        );
        const expected = server === 'author' ? 'delete' : server === 'moderator' ? 'remove' : null;
        expect({ viewer, author, action: removalAction(entry(author), viewerFor(viewer)) }).toEqual(
          { viewer, author, action: expected }
        );
      }
    }
  });

  // Purpose: the owner's content (and their agent's) never offers Remove to an admin, and an
  // active admin's is protected the same way; a member's is offered.
  it('protects the owner and active admins from an admin', () => {
    const admin = viewerFor(ids.admin);
    expect(removalAction(entry(ids.owner), admin)).toBeNull();
    expect(removalAction(entry(ids.ownerAgent), admin)).toBeNull();
    expect(removalAction(entry(ids.otherAdmin), admin)).toBeNull();
    expect(removalAction(entry(ids.otherAdminAgent), admin)).toBeNull();
    expect(removalAction(entry(ids.member), admin)).toBe('remove');
    expect(removalAction(entry(ids.memberAgent), admin)).toBe('remove');
  });

  // Purpose: roles come from the whole community, not the open channel. An owner who left the
  // channel is still protected, and an agent of theirs still in the channel too.
  it('protects the owner even when they are not in the channel', () => {
    const channelWithoutOwner = new Map(agentOwners);
    const admin = { ...viewerFor(ids.admin), agentOwners: channelWithoutOwner };
    expect(removalAction(entry(ids.owner), admin)).toBeNull();
    expect(removalAction(entry(ids.ownerAgent), admin)).toBeNull();
  });

  // Purpose: a human absent from the directory is no longer an active member (a former admin, an
  // erased husk), whom the server lets an admin remove; an agent that left the channel has no
  // known owner, so the admin is offered Remove and the server decides.
  it('offers an admin Remove on people who left and on agents with no known owner', () => {
    const departed = '10000000-0000-4000-8000-000000000099';
    expect(removalAction(entry(departed), viewerFor(ids.admin))).toBe('remove');
    expect(removalAction(entry(departed), viewerFor(ids.member))).toBeNull();
    const strayAgent = { ...viewerFor(ids.admin), agentOwners: new Map<string, string>() };
    expect(removalAction(entry(ids.memberAgent), strayAgent)).toBe('remove');
  });

  // Purpose: until the directory loads an admin cannot tell who is protected, so nothing is
  // offered on other people's messages (their own still get Delete).
  it('offers an admin nothing on others while roles are unknown', () => {
    const loading = { ...viewerFor(ids.admin), humanRoles: null };
    expect(removalAction(entry(ids.member), loading)).toBeNull();
    expect(removalAction(entry(ids.owner), loading)).toBeNull();
    expect(removalAction(entry(ids.admin), loading)).toBe('delete');
  });

  // Purpose: a tombstone has nothing left to act on, whoever removed it and whoever is looking.
  it('offers nothing on any tombstone', () => {
    for (const text of [...Object.values(REMOVED_ENTRY_TEXT), ERASED_ENTRY_TEXT]) {
      expect(
        removalAction(entry(ids.member, text, { files: 0 }), viewerFor(ids.member))
      ).toBeNull();
      expect(removalAction(entry(ids.member, text, { files: 0 }), viewerFor(ids.owner))).toBeNull();
    }
    // A message that only mentions the sentence is not a tombstone.
    expect(
      removalAction(
        entry(ids.member, `${REMOVED_ENTRY_TEXT.author} Just kidding.`),
        viewerFor(ids.member)
      )
    ).toBe('delete');
  });
});

describe('isRemovedEntry', () => {
  // Purpose: a message is removed only when it has the whole shape of a tombstone. The sentence
  // alongside a file or a mention is a living message that still offers Delete and Remove, so a
  // post cannot hide its file behind a fake tombstone.
  it('needs the sentence, no files and no mentions', () => {
    const sentence = REMOVED_ENTRY_TEXT.author;
    expect(isRemovedEntry(entry(ids.member, sentence, { files: 0 }))).toBe(true);
    expect(isRemovedEntry(entry(ids.member, ERASED_ENTRY_TEXT, { files: 0 }))).toBe(true);
    expect(isRemovedEntry(entry(ids.member, sentence, { files: 1 }))).toBe(false);
    expect(
      isRemovedEntry(entry(ids.member, sentence, { files: 0, mentions: [ids.otherMember] }))
    ).toBe(false);
    expect(isRemovedEntry(entry(ids.member, 'Hello', { files: 0 }))).toBe(false);
    expect(removalAction(entry(ids.member, sentence, { files: 1 }), viewerFor(ids.owner))).toBe(
      'remove'
    );
  });
});

describe('expectedTombstone', () => {
  // Purpose: the optimistic view matches what the server writes: the sentence for who removed
  // it, no mentions and no files, everything else (id, author, thread links) unchanged.
  it('shows the sentence for the remover and drops mentions and files', () => {
    const original = entry(ids.member);
    expect(expectedTombstone(original, 'delete')).toEqual({
      ...original,
      text: 'This message was deleted.',
      mentions: [],
      attachments: [],
    });
    expect(expectedTombstone(original, 'remove').text).toBe(
      'This message was removed by a community admin.'
    );
  });
});

describe('REMOVAL_COPY', () => {
  // Purpose: the dialogs say exactly what the spec settled, word for word.
  it('uses the settled sentences', () => {
    const leftovers =
      'People who already saw it may have a copy, and exports made before now still contain it until they expire.';
    expect(REMOVAL_COPY.message.delete).toEqual({
      menuItem: 'Delete',
      title: 'Delete this message?',
      body: 'Everyone will see "This message was deleted." in its place. Its files are deleted too. This can\'t be undone.',
      leftovers,
      confirm: 'Delete',
    });
    expect(REMOVAL_COPY.message.remove).toEqual({
      menuItem: 'Remove',
      title: 'Remove this message?',
      body: 'Everyone will see "This message was removed by a community admin." in its place. Its files are deleted too. This can\'t be undone.',
      leftovers,
      confirm: 'Remove',
    });
    expect(REMOVAL_COPY.file.delete).toMatchObject({
      menuItem: 'Delete file',
      title: 'Delete this file?',
      body: "It's removed from the message and deleted. This can't be undone.",
    });
    expect(REMOVAL_COPY.file.remove).toMatchObject({
      menuItem: 'Remove file',
      title: 'Remove this file?',
      body: "It's removed from the message and deleted. This can't be undone.",
    });
  });
});
