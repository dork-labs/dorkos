import { describe, expect, it } from 'vitest';
import {
  COMMUNITY_API_V1_ROUTES,
  CommunityExportEntryRowSchema,
  CommunityExportManifestV2Schema,
  CommunityWireExportListSchema,
  CommunityWireExportResponseSchema,
} from '../community-wire.js';

const exported = {
  id: 'export-1',
  scope: 'owner',
  state: 'building',
  progress: { done: 10, total: 40 },
  byteSize: null,
  failureCode: null,
  createdAt: '2026-09-24T10:00:00.000Z',
  readyAt: null,
  expiresAt: null,
} as const;

const manifest = {
  version: 2,
  scope: 'owner',
  exportId: 'export-1',
  requesterMemberId: 'member-1',
  createdAt: '2026-09-24T10:00:00.000Z',
  completedAt: '2026-09-24T10:05:00.000Z',
  community: {
    id: 'community-1',
    name: 'Place',
    description: null,
    admissionPolicy: 'invite_only',
    lifecycle: 'active',
    lifecycleVersion: 2,
    settingsVersion: 1,
    icon: null,
  },
  files: {
    channels: ['channels/000001.ndjson'],
    members: ['members/000001.ndjson'],
    agents: [],
    channelMembers: [],
    agentChannelMembers: [],
    auditEvents: [],
    entries: ['entries/000001.ndjson'],
    attachments: [],
  },
  counts: {
    channels: 1,
    members: 1,
    agents: 0,
    channelMembers: 0,
    agentChannelMembers: 0,
    auditEvents: 0,
    entries: 3,
    attachments: 0,
  },
} as const;

describe('community export wire', () => {
  // Purpose: the job answer carries state and progress, never the old archive id or a storage
  // key; fails if an extra field (such as a blob key) or the version 1 shape would pass.
  it('parses an export job and refuses extra or old fields', () => {
    expect(CommunityWireExportResponseSchema.parse({ export: exported }).export.state).toBe(
      'building'
    );
    expect(
      CommunityWireExportResponseSchema.safeParse({ export: { ...exported, blobKey: 'a' } }).success
    ).toBe(false);
    expect(
      CommunityWireExportResponseSchema.safeParse({
        archiveId: 'export-1',
        version: 1,
        createdAt: exported.createdAt,
      }).success
    ).toBe(false);
    expect(
      CommunityWireExportResponseSchema.safeParse({
        export: { ...exported, state: 'failed', failureCode: 'SOMETHING_ELSE' },
      }).success
    ).toBe(false);
    expect(
      CommunityWireExportListSchema.safeParse({ exports: Array(51).fill(exported) }).success
    ).toBe(false);
    expect(COMMUNITY_API_V1_ROUTES.exportArchiveBytes).toBe('/api/v1/exports/:id/archive');
    expect(COMMUNITY_API_V1_ROUTES.exportCancel).toBe('/api/v1/exports/:id/cancel');
  });

  // Purpose: manifest version 2 is strict and its paths cannot climb out of the archive.
  it('parses a version 2 manifest and refuses path tricks and other versions', () => {
    expect(CommunityExportManifestV2Schema.parse(manifest).version).toBe(2);
    expect(CommunityExportManifestV2Schema.safeParse({ ...manifest, version: 1 }).success).toBe(
      false
    );
    expect(
      CommunityExportManifestV2Schema.safeParse({
        ...manifest,
        files: { ...manifest.files, entries: ['../entries/000001.ndjson'] },
      }).success
    ).toBe(false);
    expect(
      CommunityExportManifestV2Schema.safeParse({
        ...manifest,
        community: { ...manifest.community, lifecycle: 'suspended' },
      }).success
    ).toBe(false);
  });

  // Purpose: an entry row records who removed it, or that its author was erased, and nothing else.
  it('limits an entry row’s removal marker to the known kinds', () => {
    const row = {
      id: 'e1',
      channel_id: 'c1',
      seq: 1,
      author_member_id: 'm1',
      author_agent_id: null,
      author_display_name: 'Pat',
      text: 'This message was deleted.',
      mentions: [],
      parent_entry_id: null,
      thread_root_entry_id: null,
      created_at: '2026-09-24T10:00:00.000Z',
      removal: 'author',
    };
    expect(CommunityExportEntryRowSchema.parse(row).removal).toBe('author');
    expect(CommunityExportEntryRowSchema.safeParse({ ...row, removal: 'owner' }).success).toBe(
      false
    );
  });
});
