import { describe, expect, it } from 'vitest';
import { CommunityExportManifestV1Schema } from '../community-wire.js';
import {
  CommunityAdminImportCreateRequestSchema,
  CommunityAdminImportSchema,
} from '../community-admin-wire.js';

const id = (n: number) => `aaaaaaaa-0000-4000-8000-${String(n).padStart(12, '0')}`;

function manifest() {
  return {
    version: 1,
    scope: 'owner',
    requesterMemberId: id(1),
    community: { id: id(9), lifecycle: 'active', lifecycleVersion: 2, settingsVersion: 1 },
    auditEvents: [],
    channels: [
      {
        id: id(2),
        name: 'general',
        description: null,
        visibility: 'public',
        archived: false,
        created_at: '2026-01-01T00:00:00.000Z',
      },
    ],
    members: [
      {
        id: id(1),
        display_name: 'Ada',
        handle: 'ada',
        role: 'owner',
        active: true,
        created_at: '2026-01-01T00:00:00.000Z',
        removed_at: null,
        email: null,
      },
    ],
    agents: [],
    entries: [
      {
        id: id(3),
        channel_id: id(2),
        seq: '1',
        author_member_id: id(1),
        author_agent_id: null,
        author_display_name: 'Ada',
        text: 'hello',
        mentions: [],
        parent_entry_id: null,
        thread_root_entry_id: null,
        created_at: '2026-01-01T00:00:00.000Z',
      },
    ],
    attachments: [],
  };
}

describe('CommunityExportManifestV1Schema', () => {
  // Purpose: the importer derives new IDs from these strings, so an ID must have exactly one
  // spelling; an uppercase one would map the same row to two different derived IDs.
  it('accepts a well-formed manifest and refuses any ID that is not a lowercase UUID', () => {
    expect(CommunityExportManifestV1Schema.safeParse(manifest()).success).toBe(true);
    const upper = manifest();
    upper.entries[0].channel_id = id(2).toUpperCase();
    expect(CommunityExportManifestV1Schema.safeParse(upper).success).toBe(false);
  });

  // Purpose: strict parsing is what makes a new exporter field a new version: an unknown key
  // anywhere is refused rather than silently dropped.
  it('refuses unknown fields, a numeric seq, and an unknown version', () => {
    expect(CommunityExportManifestV1Schema.safeParse({ ...manifest(), extra: true }).success).toBe(
      false
    );
    const numeric = manifest() as unknown as { entries: { seq: unknown }[] };
    numeric.entries[0].seq = 1;
    expect(CommunityExportManifestV1Schema.safeParse(numeric).success).toBe(false);
    expect(CommunityExportManifestV1Schema.safeParse({ ...manifest(), version: 2 }).success).toBe(
      false
    );
  });

  // Purpose: a collection past the row limit is refused by the schema itself.
  it('refuses a collection over 10,000 rows', () => {
    const big = manifest();
    big.entries = Array.from({ length: 10_001 }, () => big.entries[0]);
    expect(CommunityExportManifestV1Schema.safeParse(big).success).toBe(false);
  });
});

describe('import wire', () => {
  // Purpose: an import read never has a field for the upload token or any name.
  it('has no field for a token or a name', () => {
    expect(Object.keys(CommunityAdminImportSchema.shape).sort()).toEqual([
      'archiveBytes',
      'autoCommit',
      'communityId',
      'createdAt',
      'failureCode',
      'importId',
      'maxArchiveBytes',
      'report',
      'state',
      'updatedAt',
      'uploadExpiresAt',
    ]);
    expect(
      CommunityAdminImportCreateRequestSchema.safeParse({ idempotencyKey: 'k', name: '  ' }).success
    ).toBe(false);
  });
});
