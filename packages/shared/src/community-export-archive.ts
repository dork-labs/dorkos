/**
 * The export archive's own contract: one schema per `.ndjson` line kind, and the version 1 and
 * version 2 manifests. Re-exported from `@dorkos/shared/community-wire`, which is how callers
 * import it.
 *
 * @module shared/community-export-archive
 */
import { z } from 'zod';
import { CommunityAdminAdmissionPolicySchema } from './community-admin-wire.js';
import { HANDLE_PATTERN } from './handle.js';

const id = z.string().min(1);
const timestamp = z.iso.datetime();

/** A relative, forward-slash path of one entry inside an export archive. */
const archivePath = z
  .string()
  .min(1)
  .max(1_024)
  .refine((path) => path.split('/').every((part) => part !== '' && part !== '.' && part !== '..'));
const nullableId = id.nullable();

/**
 * One `channels/NNNNNN.ndjson` line of an export archive (version 2). `auto_join` is absent from
 * archives written before channels could have it, and reads as `false`.
 */
export const CommunityExportChannelRowSchema = z.strictObject({
  id,
  name: z.string().min(1),
  description: z.string().nullable(),
  visibility: z.enum(['public', 'private']),
  archived: z.boolean(),
  created_at: timestamp,
  auto_join: z.boolean().optional(),
});
/**
 * One `members/NNNNNN.ndjson` line. `email` is present for owner exports (null for an erased
 * member) and, in a personal export, only on the requester's own row.
 */
export const CommunityExportMemberRowSchema = z.strictObject({
  id,
  display_name: z.string(),
  handle: z.string(),
  role: z.enum(['owner', 'admin', 'member']),
  active: z.boolean(),
  created_at: timestamp,
  removed_at: timestamp.nullable(),
  email: z.string().nullable(),
});
/** One `agents/NNNNNN.ndjson` line. */
export const CommunityExportAgentRowSchema = z.strictObject({
  id,
  owner_member_id: id,
  display_name: z.string(),
  handle: z.string(),
  active: z.boolean(),
  created_at: timestamp,
  revoked_at: timestamp.nullable(),
});
/** One `channel-members/NNNNNN.ndjson` line: a person's membership of a channel. */
export const CommunityExportChannelMemberRowSchema = z.strictObject({
  channel_id: id,
  member_id: id,
  joined_at: timestamp,
});
/** One `agent-channel-members/NNNNNN.ndjson` line: an agent's membership of a channel. */
export const CommunityExportAgentChannelMemberRowSchema = z.strictObject({
  channel_id: id,
  agent_id: id,
  joined_at: timestamp,
});
/**
 * One `bans/NNNNNN.ndjson` line (owner and evidence exports only). `email` is the banned
 * account's address when the account confirmed it, so an import can key the ban again on its new
 * host; null for an unconfirmed address or an account that is gone. `email_hash` is the key the
 * exporting host stored, which only that same host (same auth secret) can match.
 */
export const CommunityExportBanRowSchema = z.strictObject({
  id,
  member_id: nullableId,
  actor_member_id: nullableId,
  email: z.string().max(320).nullable(),
  email_hash: z
    .string()
    .regex(/^[a-f0-9]{64}$/)
    .nullable()
    .optional(),
  reason: z.string().min(1).max(500).nullable(),
  created_at: timestamp,
  lifted_at: timestamp.nullable(),
});
/** One `audit-events/NNNNNN.ndjson` line (owner exports only). */
export const CommunityExportAuditEventRowSchema = z.strictObject({
  id,
  community_id: id,
  actor_member_id: nullableId,
  actor_kind: z.enum(['member', 'system', 'host']),
  action: z.string().min(1),
  subject_id: z.string().nullable(),
  prior_state: z.string().nullable(),
  next_state: z.string().nullable(),
  changed_fields: z.array(z.string()),
  created_at: timestamp,
});
/**
 * One `entries/NNNNNN.ndjson` line: a message. `removal` says who removed it (`author`,
 * `moderator`, `host`) or that its author was erased; the text is then the tombstone sentence.
 */
export const CommunityExportEntryRowSchema = z.strictObject({
  id,
  channel_id: id,
  seq: z.int().positive(),
  author_member_id: nullableId,
  author_agent_id: nullableId,
  author_display_name: z.string(),
  text: z.string(),
  mentions: z.array(id),
  parent_entry_id: nullableId,
  thread_root_entry_id: nullableId,
  created_at: timestamp,
  removal: z.enum(['author', 'moderator', 'host', 'erased']).nullable(),
});
/** One `attachments/NNNNNN.ndjson` line: a file's metadata; its bytes are at `archivePath`. */
export const CommunityExportAttachmentRowSchema = z.strictObject({
  id,
  channelId: id,
  entryId: id,
  uploaderMemberId: nullableId,
  uploaderAgentId: nullableId,
  name: z.string().min(1),
  contentType: z.string().min(1),
  byteSize: z.int().positive(),
  checksum: z.string().regex(/^[a-f0-9]{64}$/),
  uploadedAt: timestamp,
  archivePath,
});

const exportFileKeys = {
  channels: z.array(archivePath),
  members: z.array(archivePath),
  agents: z.array(archivePath),
  channelMembers: z.array(archivePath),
  agentChannelMembers: z.array(archivePath),
  auditEvents: z.array(archivePath),
  entries: z.array(archivePath),
  attachments: z.array(archivePath),
  /** Absent from archives written before bans existed. */
  bans: z.array(archivePath).optional(),
};
const count = z.int().nonnegative();

/**
 * `manifest.json` of an export archive, version 2: the last entry before the central directory.
 * Rows live in the NDJSON files it lists, each line parsed by its row schema above.
 *
 * `evidence` is the copy of a whole community a host takedown preserves for the authorities:
 * nobody asked for it, so it has no requester, and it records the community's lifecycle as it
 * was before the takedown. It is written only to the host's evidence store, never offered for
 * download, and is not something an owner or member can import.
 */
export const CommunityExportManifestV2Schema = z
  .strictObject({
    version: z.literal(2),
    scope: z.enum(['personal', 'owner', 'evidence']),
    exportId: id,
    /** Null only for an `evidence` archive. */
    requesterMemberId: id.nullable(),
    createdAt: timestamp,
    completedAt: timestamp,
    community: z.strictObject({
      id,
      name: z.string().min(1).max(80),
      description: z.string().max(1_000).nullable(),
      admissionPolicy: CommunityAdminAdmissionPolicySchema,
      /**
       * Owner and personal archives read a held community as `archived`, as version 1 did. An
       * evidence archive records the state before the takedown as it was.
       */
      lifecycle: z.enum(['active', 'archived', 'held', 'suspended', 'deletion_pending']),
      lifecycleVersion: z.int().positive(),
      settingsVersion: z.int().positive(),
      icon: z
        .strictObject({
          path: z.literal('community/icon'),
          contentType: z.string().min(1),
          byteSize: z.int().positive(),
          checksum: z.string().regex(/^[a-f0-9]{64}$/),
        })
        .nullable(),
    }),
    files: z.strictObject(exportFileKeys),
    counts: z.strictObject({
      channels: count,
      members: count,
      agents: count,
      channelMembers: count,
      agentChannelMembers: count,
      auditEvents: count,
      entries: count,
      attachments: count,
      /** Absent from archives written before bans existed. */
      bans: count.optional(),
    }),
  })
  .refine(
    (manifest) =>
      manifest.scope === 'evidence' ||
      manifest.community.lifecycle === 'active' ||
      manifest.community.lifecycle === 'archived',
    { message: 'Only an evidence archive records held, suspended, or deletion_pending.' }
  )
  .refine((manifest) => (manifest.scope === 'evidence') === (manifest.requesterMemberId === null), {
    message: 'An evidence archive, and only one, has no requester.',
  });
/** Version 2 export manifest. */
export type CommunityExportManifestV2 = z.infer<typeof CommunityExportManifestV2Schema>;

/** A lowercase UUID, as Postgres writes one. Import derives new IDs from these strings. */
const exportId = z.string().regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
/** Rows each collection of a version 1 export may hold. */
export const COMMUNITY_EXPORT_V1_MAX_ROWS = 10_000;

/**
 * `manifest.json` of an export archive, version 1: the first entry, followed by one
 * `attachments/<id>` entry per attachment. Database rows keep their snake_case column names;
 * attachments are camelCase. `seq` is a bigint and arrives as a decimal string.
 *
 * This is the contract an importer reads, so it is pinned by a round trip against a real
 * export: a change to what the exporter writes that an importer must know about is a new
 * version with its own schema, never a silent change to this one.
 */
export const CommunityExportManifestV1Schema = z.strictObject({
  version: z.literal(1),
  scope: z.enum(['personal', 'owner']),
  requesterMemberId: exportId,
  community: z.strictObject({
    id: exportId,
    lifecycle: z.enum(['active', 'archived']),
    lifecycleVersion: z.int().positive(),
    settingsVersion: z.int().positive(),
  }),
  auditEvents: z
    .array(
      z.strictObject({
        id: exportId,
        community_id: exportId,
        actor_member_id: exportId.nullable(),
        actor_kind: z.enum(['member', 'system', 'host']),
        action: z.string().regex(/^[a-z][a-z0-9_.]{0,79}$/),
        subject_id: z.string().min(1).max(200).nullable(),
        prior_state: z.string().max(64).nullable(),
        next_state: z.string().max(64).nullable(),
        changed_fields: z.array(z.string().max(64)).max(16),
        created_at: timestamp,
      })
    )
    .max(COMMUNITY_EXPORT_V1_MAX_ROWS)
    .optional(),
  channels: z
    .array(
      z.strictObject({
        id: exportId,
        name: z.string().min(1),
        description: z.string().nullable(),
        visibility: z.enum(['public', 'private']),
        archived: z.boolean(),
        created_at: timestamp,
      })
    )
    .max(COMMUNITY_EXPORT_V1_MAX_ROWS),
  members: z
    .array(
      z.strictObject({
        id: exportId,
        display_name: z.string().min(1),
        handle: z.string().regex(HANDLE_PATTERN),
        role: z.enum(['owner', 'admin', 'member']),
        active: z.boolean(),
        created_at: timestamp,
        removed_at: timestamp.nullable(),
        /** Null for a member with no account, such as an erased or imported one. */
        email: z.string().nullable(),
      })
    )
    .max(COMMUNITY_EXPORT_V1_MAX_ROWS),
  agents: z
    .array(
      z.strictObject({
        id: exportId,
        owner_member_id: exportId,
        display_name: z.string().min(1),
        handle: z.string().regex(HANDLE_PATTERN),
        active: z.boolean(),
        created_at: timestamp,
        revoked_at: timestamp.nullable(),
      })
    )
    .max(COMMUNITY_EXPORT_V1_MAX_ROWS),
  entries: z
    .array(
      z.strictObject({
        id: exportId,
        channel_id: exportId,
        seq: z.string().regex(/^[1-9][0-9]{0,15}$/),
        author_member_id: exportId.nullable(),
        author_agent_id: exportId.nullable(),
        author_display_name: z.string(),
        text: z.string(),
        mentions: z.array(exportId).max(1_000),
        parent_entry_id: exportId.nullable(),
        thread_root_entry_id: exportId.nullable(),
        created_at: timestamp,
      })
    )
    .max(COMMUNITY_EXPORT_V1_MAX_ROWS),
  attachments: z
    .array(
      z.strictObject({
        id: exportId,
        channelId: exportId,
        entryId: exportId,
        uploaderMemberId: exportId.nullable(),
        uploaderAgentId: exportId.nullable(),
        name: z.string().min(1),
        contentType: z.string().min(1),
        byteSize: z.int().positive(),
        checksum: z.string().regex(/^[a-f0-9]{64}$/),
        uploadedAt: timestamp,
        archivePath: z.string().regex(/^attachments\/[0-9a-f-]{36}$/),
      })
    )
    .max(COMMUNITY_EXPORT_V1_MAX_ROWS),
});
/** Version 1 export manifest. */
export type CommunityExportManifestV1 = z.infer<typeof CommunityExportManifestV1Schema>;
