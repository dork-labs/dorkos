import { describe, expect, it } from 'vitest';
import type { CommunityExportManifestV1 } from '@dorkos/shared/community-wire';
import { uuidv5 } from '../imports/derived-id.js';
import { ImportFailure, checkManifest, parseManifest } from '../imports/manifest.js';

const id = (n: number) => `aaaaaaaa-0000-4000-8000-${String(n).padStart(12, '0')}`;
const at = '2026-01-01T00:00:00.000Z';
const limits = { textBytes: 16 * 1024, attachmentBytes: 10 * 1024 * 1024 };
const received = new Date('2026-02-01T00:00:00.000Z');

function manifest(): CommunityExportManifestV1 {
  return {
    version: 1,
    scope: 'owner',
    requesterMemberId: id(1),
    community: { id: id(99), lifecycle: 'active', lifecycleVersion: 2, settingsVersion: 1 },
    auditEvents: [
      {
        id: id(90),
        community_id: id(99),
        actor_member_id: id(1),
        actor_kind: 'member',
        action: 'channel.create',
        subject_id: id(10),
        prior_state: null,
        next_state: null,
        changed_fields: [],
        created_at: at,
      },
    ],
    channels: [
      {
        id: id(10),
        name: 'a',
        description: null,
        visibility: 'public',
        archived: false,
        created_at: at,
      },
      {
        id: id(11),
        name: 'b',
        description: null,
        visibility: 'private',
        archived: true,
        created_at: at,
      },
    ],
    members: [
      {
        id: id(1),
        display_name: 'Owner',
        handle: 'owner',
        role: 'owner',
        active: true,
        created_at: at,
        removed_at: null,
        email: 'o@e.test',
      },
      {
        id: id(2),
        display_name: 'Past',
        handle: 'past',
        role: 'member',
        active: false,
        created_at: at,
        removed_at: at,
        email: null,
      },
    ],
    agents: [
      {
        id: id(3),
        owner_member_id: id(2),
        display_name: 'Bot',
        handle: 'bot',
        active: false,
        created_at: at,
        revoked_at: at,
      },
    ],
    entries: [
      {
        id: id(20),
        channel_id: id(10),
        seq: '1',
        author_member_id: id(1),
        author_agent_id: null,
        author_display_name: 'Owner',
        text: 'root',
        mentions: [id(2), id(3)],
        parent_entry_id: null,
        thread_root_entry_id: null,
        created_at: at,
      },
      {
        id: id(21),
        channel_id: id(10),
        seq: '2',
        author_member_id: null,
        author_agent_id: id(3),
        author_display_name: 'Bot',
        text: 'reply',
        mentions: [],
        parent_entry_id: id(20),
        thread_root_entry_id: id(20),
        created_at: at,
      },
    ],
    attachments: [
      {
        id: id(30),
        channelId: id(10),
        entryId: id(20),
        uploaderMemberId: id(1),
        uploaderAgentId: null,
        name: 'f.txt',
        contentType: 'text/plain',
        byteSize: 3,
        checksum: 'a'.repeat(64),
        uploadedAt: at,
        archivePath: `attachments/${id(30)}`,
      },
    ],
  };
}

function failureOf(change: (m: CommunityExportManifestV1) => void): string | null {
  const m = manifest();
  change(m);
  try {
    checkManifest(m, limits, received);
    return null;
  } catch (error) {
    return error instanceof ImportFailure ? error.code : 'THREW';
  }
}

describe('uuidv5', () => {
  // Purpose: import's derived IDs are RFC 4122 name-based UUIDs; the published vectors pin the
  // byte order, the version, and the variant, so a subtly wrong derivation cannot pass.
  it('matches the RFC 4122 test vectors', () => {
    expect(uuidv5('6ba7b810-9dad-11d1-80b4-00c04fd430c8', 'www.example.com')).toBe(
      '2ed6657d-e927-568b-95e1-2665a8aea6a2'
    );
    expect(uuidv5('6ba7b811-9dad-11d1-80b4-00c04fd430c8', 'http://python.org/')).toBe(
      '4c565f0d-3f5a-5890-b41b-20cf47701c5e'
    );
  });
  // Purpose: the same source ID in two imports never gives the same new ID.
  it('gives each namespace its own IDs', () => {
    expect(uuidv5(id(1), id(5))).not.toBe(uuidv5(id(2), id(5)));
    expect(uuidv5(id(1), id(5))).toBe(uuidv5(id(1), id(5)));
  });
});

describe('checkManifest', () => {
  // Purpose: a well-formed export passes and its counts are what the report shows.
  it('counts a well-formed export', () => {
    expect(checkManifest(manifest(), limits, received)).toEqual({
      channels: 2,
      entries: 2,
      attachments: 1,
      historicalMembers: 2,
      historicalAgents: 1,
      auditEvents: 1,
      attachmentBytes: 3,
    });
  });

  // Purpose: every reference must resolve inside the export, so no restored row can point at
  // another community's data or break a constraint halfway through the restore.
  it.each([
    [
      'a channel outside the export',
      (m: CommunityExportManifestV1) => void (m.entries[0].channel_id = id(77)),
    ],
    [
      'an author outside the export',
      (m: CommunityExportManifestV1) => void (m.entries[0].author_member_id = id(77)),
    ],
    ['two authors', (m: CommunityExportManifestV1) => void (m.entries[0].author_agent_id = id(3))],
    [
      'a mention outside the export',
      (m: CommunityExportManifestV1) => void (m.entries[0].mentions = [id(77)]),
    ],
    [
      'a repeated mention',
      (m: CommunityExportManifestV1) => void (m.entries[0].mentions = [id(2), id(2)]),
    ],
    [
      'a nested reply',
      (m: CommunityExportManifestV1) => {
        m.entries.push({
          ...m.entries[1],
          id: id(22),
          seq: '3',
          parent_entry_id: id(21),
          thread_root_entry_id: id(21),
        });
      },
    ],
    ['a reply before its parent', (m: CommunityExportManifestV1) => void (m.entries[0].seq = '5')],
    [
      'a parent that differs from the thread root',
      (m: CommunityExportManifestV1) => void (m.entries[1].thread_root_entry_id = null),
    ],
    [
      'a repeated sequence',
      (m: CommunityExportManifestV1) => {
        m.entries[1].seq = '1';
        m.entries[1].parent_entry_id = null;
        m.entries[1].thread_root_entry_id = null;
      },
    ],
    [
      'an ID that is both a member and an agent',
      (m: CommunityExportManifestV1) => void (m.agents[0].id = id(2)),
    ],
    ['a repeated handle', (m: CommunityExportManifestV1) => void (m.agents[0].handle = 'past')],
    [
      'an owner who did not make the export',
      (m: CommunityExportManifestV1) => void (m.requesterMemberId = id(2)),
    ],
    [
      'two active owners',
      (m: CommunityExportManifestV1) => {
        m.members[1].role = 'owner';
        m.members[1].active = true;
      },
    ],
    [
      'an agent whose owner is missing',
      (m: CommunityExportManifestV1) => void (m.agents[0].owner_member_id = id(77)),
    ],
    [
      'a file on a message in another channel',
      (m: CommunityExportManifestV1) => void (m.attachments[0].channelId = id(11)),
    ],
    [
      'a file at another path',
      (m: CommunityExportManifestV1) =>
        void (m.attachments[0].archivePath = `attachments/${id(31)}`),
    ],
    [
      'an audit event from another community',
      (m: CommunityExportManifestV1) => void (m.auditEvents![0].community_id = id(98)),
    ],
    // What the member API would refuse to serve, derived from its own read schemas.
    [
      'nine files on one message',
      (m: CommunityExportManifestV1) => {
        for (let n = 0; n < 8; n++)
          m.attachments.push({
            ...m.attachments[0],
            id: id(40 + n),
            archivePath: `attachments/${id(40 + n)}`,
          });
      },
    ],
    [
      'a sequence past 2^53',
      (m: CommunityExportManifestV1) => void (m.entries[1].seq = '9007199254740993'),
    ],
    [
      'an empty author name',
      (m: CommunityExportManifestV1) => void (m.entries[0].author_display_name = ''),
    ],
    [
      'an empty member name',
      (m: CommunityExportManifestV1) => void (m.members[1].display_name = ''),
    ],
    // This host's own content limits.
    [
      'text over COMMUNITY_TEXT_BYTES',
      (m: CommunityExportManifestV1) => void (m.entries[0].text = 'é'.repeat(8 * 1024 + 1)),
    ],
    [
      'a channel name over 80 characters',
      (m: CommunityExportManifestV1) => void (m.channels[0].name = 'n'.repeat(81)),
    ],
    [
      'a channel description over 1,000 characters',
      (m: CommunityExportManifestV1) => void (m.channels[0].description = 'd'.repeat(1_001)),
    ],
    // Nothing newer than the upload.
    [
      'a message from the future',
      (m: CommunityExportManifestV1) => void (m.entries[0].created_at = '2026-02-01T00:10:00.000Z'),
    ],
    [
      'a member removed in the future',
      (m: CommunityExportManifestV1) => void (m.members[1].removed_at = '2027-01-01T00:00:00.000Z'),
    ],
    [
      'an audit event from the future',
      (m: CommunityExportManifestV1) =>
        void (m.auditEvents![0].created_at = '2030-01-01T00:00:00.000Z'),
    ],
    [
      'a file uploaded in the future',
      (m: CommunityExportManifestV1) =>
        void (m.attachments[0].uploadedAt = '2030-01-01T00:00:00.000Z'),
    ],
  ])('refuses %s', (_label, change) => {
    expect(failureOf(change)).toBe('IMPORT_ARCHIVE_INVALID');
  });

  // Purpose: a file larger than this host's COMMUNITY_ATTACHMENT_BYTES is a size refusal.
  it('refuses a file over the configured attachment size as too large', () => {
    expect(failureOf((m) => void (m.attachments[0].byteSize = limits.attachmentBytes + 1))).toBe(
      'IMPORT_TOO_LARGE'
    );
  });

  // Purpose: the limits are exact: eight files, text at the byte limit, a sequence at 2^53-1,
  // and a timestamp within the clock-drift allowance all pass.
  it('accepts every value at its limit', () => {
    expect(
      failureOf((m) => {
        for (let n = 0; n < 7; n++)
          m.attachments.push({
            ...m.attachments[0],
            id: id(40 + n),
            archivePath: `attachments/${id(40 + n)}`,
          });
        m.entries[0].text = 'é'.repeat(8 * 1024);
        m.entries[1].seq = '9007199254740991';
        m.channels[0].name = 'n'.repeat(80);
        m.entries[1].created_at = '2026-02-01T00:04:00.000Z';
      })
    ).toBeNull();
  });
});

describe('parseManifest', () => {
  const bytes = (value: unknown) => Buffer.from(JSON.stringify(value));
  // Purpose: the version and scope are named before the strict parse, so a later format or a
  // personal export is reported as what it is rather than as a damaged file.
  it('names an unknown version, a personal export, and bad JSON', () => {
    const code = (input: Buffer) => {
      try {
        parseManifest(input);
        return null;
      } catch (error) {
        return (error as ImportFailure).code;
      }
    };
    expect(code(bytes({ ...manifest(), version: 2 }))).toBe('IMPORT_VERSION_UNSUPPORTED');
    expect(code(bytes({ ...manifest(), scope: 'personal' }))).toBe('IMPORT_NOT_OWNER_EXPORT');
    expect(code(Buffer.from('{not json'))).toBe('IMPORT_ARCHIVE_INVALID');
    expect(code(bytes([]))).toBe('IMPORT_ARCHIVE_INVALID');
    expect(code(bytes({ ...manifest(), extra: 1 }))).toBe('IMPORT_ARCHIVE_INVALID');
    expect(code(bytes(manifest()))).toBeNull();
  });
});
