import {
  CommunityExportManifestV1Schema,
  type CommunityExportManifestV1,
} from '@dorkos/shared/community-wire';
import type { ImportFailureCode } from './store.js';

/** The largest `manifest.json` a version 1 export holds. */
export const MAX_MANIFEST_BYTES = 16 * 1024 * 1024;
/** The largest file one attachment may be: the ceiling of `COMMUNITY_ATTACHMENT_BYTES`. */
export const MAX_IMPORT_ATTACHMENT_BYTES = 25 * 1024 * 1024;
/** The most attachment bytes one import restores. */
export const MAX_IMPORT_ATTACHMENTS_BYTES = 1024 * 1024 * 1024;

/** The only entry names a version 1 export holds. */
export const V1_ATTACHMENT_ENTRY =
  /^attachments\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** Why an import stops, carrying only a redacted code: never a value from the export. */
export class ImportFailure extends Error {
  constructor(readonly code: ImportFailureCode) {
    super(code);
    this.name = 'ImportFailure';
  }
}

/** The counts a checked manifest reports; sizes are added from the archive. */
export interface ManifestCounts {
  channels: number;
  entries: number;
  attachments: number;
  historicalMembers: number;
  historicalAgents: number;
  auditEvents: number;
  attachmentBytes: number;
}

/**
 * Parse `manifest.json` bytes. The version and scope are read before the strict schema, so an
 * export from a later version, or a person's own export, is named as such rather than as a
 * damaged file.
 */
export function parseManifest(bytes: Buffer): CommunityExportManifestV1 {
  let raw: unknown;
  try {
    // Postgres text cannot hold a NUL character, so one anywhere makes the export unusable.
    raw = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes), (_key, value) => {
      if (typeof value === 'string' && value.includes('\u0000')) throw new Error('NUL');
      return value as unknown;
    });
  } catch {
    throw new ImportFailure('IMPORT_ARCHIVE_INVALID');
  }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw))
    throw new ImportFailure('IMPORT_ARCHIVE_INVALID');
  const { version, scope } = raw as { version?: unknown; scope?: unknown };
  if (version !== 1) {
    throw new ImportFailure(
      Number.isInteger(version) ? 'IMPORT_VERSION_UNSUPPORTED' : 'IMPORT_ARCHIVE_INVALID'
    );
  }
  if (scope === 'personal') throw new ImportFailure('IMPORT_NOT_OWNER_EXPORT');
  const parsed = CommunityExportManifestV1Schema.safeParse(raw);
  if (!parsed.success) throw new ImportFailure('IMPORT_ARCHIVE_INVALID');
  return parsed.data;
}

function unique(ids: readonly string[]): Set<string> {
  const set = new Set(ids);
  if (set.size !== ids.length) throw new ImportFailure('IMPORT_ARCHIVE_INVALID');
  return set;
}

function invalid(condition: boolean): void {
  if (condition) throw new ImportFailure('IMPORT_ARCHIVE_INVALID');
}

/**
 * Check every reference an owner export's rows make, so the restore can insert them in one
 * transaction without a constraint firing halfway, and so no row can point outside the export.
 *
 * - IDs are unique in each collection, and no ID is both a member and an agent, so a mention
 *   resolves to exactly one author. Handles are unique across members and agents.
 * - Exactly one member is the active owner, and it is the member who made the export.
 * - Every entry's channel and author resolve; a reply names its top-level parent in the same
 *   channel as both parent and thread root, and comes after it; `seq` is unique per channel.
 * - Every attachment's channel, message, and uploader resolve, and its message is in its
 *   channel. Every audit event belongs to the exported community and names a known actor.
 */
export function checkManifest(manifest: CommunityExportManifestV1): ManifestCounts {
  invalid(manifest.scope !== 'owner');
  const members = unique(manifest.members.map((member) => member.id));
  const agents = unique(manifest.agents.map((agent) => agent.id));
  for (const id of agents) invalid(members.has(id));
  unique([...manifest.members, ...manifest.agents].map((row) => row.handle));
  const owners = manifest.members.filter((member) => member.role === 'owner' && member.active);
  invalid(owners.length !== 1 || owners[0].id !== manifest.requesterMemberId);
  for (const agent of manifest.agents) invalid(!members.has(agent.owner_member_id));

  const channels = unique(manifest.channels.map((channel) => channel.id));
  unique(manifest.entries.map((entry) => entry.id));
  const entries = new Map(manifest.entries.map((entry) => [entry.id, entry]));
  const sequences = new Set<string>();
  for (const entry of manifest.entries) {
    invalid(!channels.has(entry.channel_id));
    const sequence = `${entry.channel_id}:${entry.seq}`;
    invalid(sequences.has(sequence));
    sequences.add(sequence);
    invalid((entry.author_member_id === null) === (entry.author_agent_id === null));
    invalid(entry.author_member_id !== null && !members.has(entry.author_member_id));
    invalid(entry.author_agent_id !== null && !agents.has(entry.author_agent_id));
    invalid(entry.parent_entry_id !== entry.thread_root_entry_id);
    if (entry.parent_entry_id !== null) {
      const parent = entries.get(entry.parent_entry_id);
      invalid(
        !parent ||
          parent.channel_id !== entry.channel_id ||
          parent.parent_entry_id !== null ||
          BigInt(parent.seq) >= BigInt(entry.seq)
      );
    }
    unique(entry.mentions);
    for (const mention of entry.mentions) invalid(!members.has(mention) && !agents.has(mention));
  }

  unique(manifest.attachments.map((attachment) => attachment.id));
  let attachmentBytes = 0;
  for (const attachment of manifest.attachments) {
    invalid(attachment.archivePath !== `attachments/${attachment.id}`);
    invalid(!channels.has(attachment.channelId));
    invalid(entries.get(attachment.entryId)?.channel_id !== attachment.channelId);
    invalid((attachment.uploaderMemberId === null) === (attachment.uploaderAgentId === null));
    invalid(attachment.uploaderMemberId !== null && !members.has(attachment.uploaderMemberId));
    invalid(attachment.uploaderAgentId !== null && !agents.has(attachment.uploaderAgentId));
    if (attachment.byteSize > MAX_IMPORT_ATTACHMENT_BYTES)
      throw new ImportFailure('IMPORT_TOO_LARGE');
    attachmentBytes += attachment.byteSize;
  }
  if (attachmentBytes > MAX_IMPORT_ATTACHMENTS_BYTES) throw new ImportFailure('IMPORT_TOO_LARGE');

  const auditEvents = manifest.auditEvents ?? [];
  unique(auditEvents.map((event) => event.id));
  for (const event of auditEvents) {
    invalid(event.community_id !== manifest.community.id);
    invalid(event.actor_member_id !== null && !members.has(event.actor_member_id));
  }

  return {
    channels: manifest.channels.length,
    entries: manifest.entries.length,
    attachments: manifest.attachments.length,
    historicalMembers: manifest.members.length,
    historicalAgents: manifest.agents.length,
    auditEvents: auditEvents.length,
    attachmentBytes,
  };
}
