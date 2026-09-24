import {
  CommunityExportManifestV1Schema,
  CommunityWireAgentSchema,
  CommunityWireAttachmentSchema,
  CommunityWireChannelSchema,
  CommunityWireEntrySchema,
  CommunityWireMemberSchema,
  type CommunityExportManifestV1,
} from '@dorkos/shared/community-wire';
import type { ZodType } from 'zod';
import { sanitizeDisplayName } from '../storage/blob-store.js';
import type { ImportFailureCode } from './store.js';

/** The largest `manifest.json` a version 1 export holds. */
export const MAX_MANIFEST_BYTES = 16 * 1024 * 1024;
/** The largest file one attachment may be: the ceiling of `COMMUNITY_ATTACHMENT_BYTES`. */
export const MAX_IMPORT_ATTACHMENT_BYTES = 25 * 1024 * 1024;
/** The longest channel name an import keeps, in characters, the same cap as a community's. */
export const MAX_IMPORT_CHANNEL_NAME = 80;
/** The longest channel description an import keeps, in characters, as for a community. */
export const MAX_IMPORT_CHANNEL_DESCRIPTION = 1_000;

/** Cut `text` to at most `max` characters, ending in an ellipsis when anything was cut. */
function shorten(text: string, max: number): string {
  const characters = Array.from(text);
  return characters.length <= max ? text : `${characters.slice(0, max - 1).join('')}…`;
}

/**
 * A channel as an import restores it. A name or description longer than a community's own is
 * shortened with an ellipsis rather than refusing the whole export over a cosmetic field; the
 * report counts how many were shortened.
 */
export function importedChannel<T extends { name: string; description: string | null }>(
  channel: T
): T & { shortened: number } {
  const name = shorten(channel.name, MAX_IMPORT_CHANNEL_NAME);
  const description =
    channel.description === null
      ? null
      : shorten(channel.description, MAX_IMPORT_CHANNEL_DESCRIPTION);
  return {
    ...channel,
    name,
    description,
    shortened: Number(name !== channel.name) + Number(description !== channel.description),
  };
}
/**
 * How far past the moment the export arrived a timestamp in it may be, for clock drift
 * between hosts. Nothing an export holds can really be newer than its own upload.
 */
export const IMPORT_CLOCK_SKEW_MS = 5 * 60_000;

/** This host's own content limits, which an import is held to like any new content. */
export interface ImportLimits {
  /** `COMMUNITY_TEXT_BYTES`: the most UTF-8 bytes one message may hold. */
  textBytes: number;
  /** `COMMUNITY_ATTACHMENT_BYTES`: the largest file one attachment may be. */
  attachmentBytes: number;
}
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
  /** Channel names and descriptions shortened to fit this host. */
  shortened: number;
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
 * Each entry's new sequence: 1 to n within its channel, in the order the export numbered
 * them. An export's own numbers only order the history; kept as they are, a large one could
 * leave a channel whose next post or unread count the app can no longer serve.
 */
export function renumberedSequences(
  entries: CommunityExportManifestV1['entries']
): Map<string, number> {
  const byChannel = new Map<string, CommunityExportManifestV1['entries']>();
  for (const entry of entries)
    byChannel.set(entry.channel_id, [...(byChannel.get(entry.channel_id) ?? []), entry]);
  const sequences = new Map<string, number>();
  for (const channelEntries of byChannel.values()) {
    channelEntries
      .sort((a, b) => (BigInt(a.seq) < BigInt(b.seq) ? -1 : BigInt(a.seq) > BigInt(b.seq) ? 1 : 0))
      .forEach((entry, index) => sequences.set(entry.id, index + 1));
  }
  return sequences;
}

/** Refuse unless `value` is exactly what the member read schema would serve. */
function readable(schema: ZodType, value: unknown): void {
  invalid(!schema.safeParse(value).success);
}

/**
 * Check every row of an owner export before any of it is stored, so the restore can insert
 * everything in one transaction without a constraint firing halfway, no row can point outside
 * the export, and every restored row reads back through the member API exactly as a live one.
 *
 * - Each row is projected the way the member API serves it and parsed with that API's own
 *   read schema (channels, members, agents, entries with their files), so an import can never
 *   restore something a read would refuse, and a change to a read schema changes this check.
 * - The host's own content limits apply: message text within `COMMUNITY_TEXT_BYTES` and each
 *   file within `COMMUNITY_ATTACHMENT_BYTES`. A longer channel name or description is
 *   shortened (see {@link importedChannel}) and counted, never refused.
 * - No timestamp is later than the moment the export arrived (with a little clock drift).
 * - IDs are unique in each collection, and no ID is both a member and an agent, so a mention
 *   resolves to exactly one author. Handles are unique across members and agents.
 * - Exactly one member is the active owner, and it is the member who made the export.
 * - Every entry's channel and author resolve; a reply names its top-level parent in the same
 *   channel as both parent and thread root, and comes after it; `seq` is unique per channel
 *   and only orders the history, which is renumbered 1 to n (see {@link renumberedSequences}).
 * - Every attachment's channel, message, and uploader resolve, and its message is in its
 *   channel. Every audit event belongs to the exported community and names a known actor.
 */
export function checkManifest(
  manifest: CommunityExportManifestV1,
  limits: ImportLimits,
  receivedAt: Date
): ManifestCounts {
  invalid(manifest.scope !== 'owner');
  const latest = receivedAt.getTime() + IMPORT_CLOCK_SKEW_MS;
  const notFuture = (...times: (string | null)[]) => {
    for (const time of times) invalid(time !== null && Date.parse(time) > latest);
  };

  const members = unique(manifest.members.map((member) => member.id));
  const agents = unique(manifest.agents.map((agent) => agent.id));
  for (const id of agents) invalid(members.has(id));
  unique([...manifest.members, ...manifest.agents].map((row) => row.handle));
  const owners = manifest.members.filter((member) => member.role === 'owner' && member.active);
  invalid(owners.length !== 1 || owners[0].id !== manifest.requesterMemberId);
  for (const member of manifest.members) {
    notFuture(member.created_at, member.removed_at);
    readable(CommunityWireMemberSchema, {
      memberId: member.id,
      kind: 'human',
      displayName: member.display_name,
      handle: member.handle,
      role: member.role,
      ownerMemberId: null,
      joinedAt: member.created_at,
    });
  }
  for (const agent of manifest.agents) {
    invalid(!members.has(agent.owner_member_id));
    notFuture(agent.created_at, agent.revoked_at);
    readable(CommunityWireAgentSchema, {
      memberId: agent.id,
      displayName: agent.display_name,
      handle: agent.handle,
      ownerMemberId: agent.owner_member_id,
      active: false,
    });
  }

  const channels = unique(manifest.channels.map((channel) => channel.id));
  let shortened = 0;
  for (const source of manifest.channels) {
    const channel = importedChannel(source);
    shortened += channel.shortened;
    notFuture(channel.created_at);
    readable(CommunityWireChannelSchema, {
      id: channel.id,
      name: channel.name,
      description: channel.description,
      visibility: channel.visibility,
      archived: channel.archived,
      createdAt: channel.created_at,
      joined: true,
      unreadCount: 0,
    });
  }

  unique(manifest.attachments.map((attachment) => attachment.id));
  const filesOf = new Map<string, unknown[]>();
  let attachmentBytes = 0;
  for (const attachment of manifest.attachments) {
    invalid(attachment.archivePath !== `attachments/${attachment.id}`);
    invalid(!channels.has(attachment.channelId));
    invalid((attachment.uploaderMemberId === null) === (attachment.uploaderAgentId === null));
    invalid(attachment.uploaderMemberId !== null && !members.has(attachment.uploaderMemberId));
    invalid(attachment.uploaderAgentId !== null && !agents.has(attachment.uploaderAgentId));
    notFuture(attachment.uploadedAt);
    if (attachment.byteSize > limits.attachmentBytes) throw new ImportFailure('IMPORT_TOO_LARGE');
    attachmentBytes += attachment.byteSize;
    const projected = {
      id: attachment.id,
      name: sanitizeDisplayName(attachment.name),
      contentType: attachment.contentType,
      byteSize: attachment.byteSize,
      checksum: attachment.checksum,
      createdAt: attachment.uploadedAt,
    };
    readable(CommunityWireAttachmentSchema, projected);
    filesOf.set(attachment.entryId, [...(filesOf.get(attachment.entryId) ?? []), projected]);
  }
  if (attachmentBytes > MAX_IMPORT_ATTACHMENTS_BYTES) throw new ImportFailure('IMPORT_TOO_LARGE');

  unique(manifest.entries.map((entry) => entry.id));
  const entries = new Map(manifest.entries.map((entry) => [entry.id, entry]));
  const sequences = new Set<string>();
  const renumbered = renumberedSequences(manifest.entries);
  for (const attachment of manifest.attachments)
    invalid(entries.get(attachment.entryId)?.channel_id !== attachment.channelId);
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
    for (const mention of entry.mentions) invalid(!members.has(mention) && !agents.has(mention));
    notFuture(entry.created_at);
    invalid(Buffer.byteLength(entry.text, 'utf8') > limits.textBytes);
    readable(CommunityWireEntrySchema, {
      id: entry.id,
      channelId: entry.channel_id,
      seq: renumbered.get(entry.id),
      authorMemberId: entry.author_member_id ?? entry.author_agent_id,
      authorDisplayName: entry.author_display_name,
      authorKind: entry.author_agent_id ? 'agent' : 'human',
      text: entry.text,
      mentions: entry.mentions,
      parentEntryId: entry.parent_entry_id,
      threadRootEntryId: entry.thread_root_entry_id,
      createdAt: entry.created_at,
      cursor: 'cursor',
      attachments: filesOf.get(entry.id) ?? [],
    });
  }

  const auditEvents = manifest.auditEvents ?? [];
  unique(auditEvents.map((event) => event.id));
  for (const event of auditEvents) {
    invalid(event.community_id !== manifest.community.id);
    invalid(event.actor_member_id !== null && !members.has(event.actor_member_id));
    notFuture(event.created_at);
  }

  return {
    channels: manifest.channels.length,
    entries: manifest.entries.length,
    attachments: manifest.attachments.length,
    historicalMembers: manifest.members.length,
    historicalAgents: manifest.agents.length,
    auditEvents: auditEvents.length,
    attachmentBytes,
    shortened,
  };
}
