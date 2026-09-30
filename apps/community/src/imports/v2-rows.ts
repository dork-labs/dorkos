import {
  CommunityExportAgentChannelMemberRowSchema,
  CommunityExportAgentRowSchema,
  CommunityExportAttachmentRowSchema,
  CommunityExportAuditEventRowSchema,
  CommunityExportChannelMemberRowSchema,
  CommunityExportChannelRowSchema,
  CommunityExportEntryRowSchema,
  CommunityExportMemberRowSchema,
  CommunityWireAgentSchema,
  CommunityWireAttachmentSchema,
  CommunityWireChannelSchema,
  CommunityWireEntrySchema,
  CommunityWireMemberSchema,
  type CommunityExportManifestV2,
} from '@dorkos/shared/community-wire';
import type { z, ZodType } from 'zod';
import { sanitizeDisplayName } from '../storage/blob-store.js';
import {
  IMPORT_CLOCK_SKEW_MS,
  ImportFailure,
  importedChannel,
  type ImportLimits,
} from './manifest.js';
import { parseRow } from './ndjson.js';
import { ICON_SOURCE_ID, type V2Collection } from './v2-archive.js';

/** One row of each version 2 collection, as its strict schema parses it. */
export type V2Row = {
  channels: z.infer<typeof CommunityExportChannelRowSchema>;
  members: z.infer<typeof CommunityExportMemberRowSchema>;
  agents: z.infer<typeof CommunityExportAgentRowSchema>;
  channelMembers: z.infer<typeof CommunityExportChannelMemberRowSchema>;
  agentChannelMembers: z.infer<typeof CommunityExportAgentChannelMemberRowSchema>;
  auditEvents: z.infer<typeof CommunityExportAuditEventRowSchema>;
  entries: z.infer<typeof CommunityExportEntryRowSchema>;
  attachments: z.infer<typeof CommunityExportAttachmentRowSchema>;
};

const ROW_SCHEMAS: { [K in V2Collection]: ZodType<V2Row[K]> } = {
  channels: CommunityExportChannelRowSchema,
  members: CommunityExportMemberRowSchema,
  agents: CommunityExportAgentRowSchema,
  channelMembers: CommunityExportChannelMemberRowSchema,
  agentChannelMembers: CommunityExportAgentChannelMemberRowSchema,
  auditEvents: CommunityExportAuditEventRowSchema,
  entries: CommunityExportEntryRowSchema,
  attachments: CommunityExportAttachmentRowSchema,
};

/**
 * The longest NDJSON line an import reads. The longest real row is a message: its text within
 * `COMMUNITY_TEXT_BYTES`, which JSON escaping can grow up to six times, plus its mentions and
 * fixed fields. Anything longer cannot be a valid row, and is refused before it is buffered.
 */
export function maxLineBytes(limits: ImportLimits): number {
  return 6 * limits.textBytes + 1024 * 1024;
}

const ATTACHMENT_PATH = /^files\/([0-9a-f-]{36})\/[^/]+$/;

function invalid(condition: boolean): void {
  if (condition) throw new ImportFailure('IMPORT_ARCHIVE_INVALID');
}

function readable(schema: ZodType, value: unknown): void {
  invalid(!schema.safeParse(value).success);
}

/**
 * The checks every version 2 row passes on its own, the same rules version 1 applies to its
 * rows: each is projected the way the member API serves it and parsed with that API's read
 * schema, the host's content limits apply, and no time is later than the moment the export
 * arrived. Checks that need other rows (a reference resolves, a handle is unique, a reply's
 * parent is a top-level message earlier in its channel) are the restore's, run per batch with
 * indexed lookups and the database's own constraints.
 */
export class V2RowRules {
  private readonly latest: number;

  constructor(
    readonly manifest: CommunityExportManifestV2,
    private readonly limits: ImportLimits,
    receivedAt: Date
  ) {
    this.latest = receivedAt.getTime() + IMPORT_CLOCK_SKEW_MS;
  }

  /** Parse and check one line of `key`'s files. */
  parse<K extends V2Collection>(key: K, line: Uint8Array): V2Row[K] {
    const row = parseRow(line, ROW_SCHEMAS[key]);
    this.check(key, row);
    return row;
  }

  private notFuture(...times: (string | null)[]): void {
    for (const time of times) invalid(time !== null && Date.parse(time) > this.latest);
  }

  private check<K extends V2Collection>(key: K, value: V2Row[K]): void {
    switch (key) {
      case 'channels': {
        const channel = importedChannel(value as V2Row['channels']);
        this.notFuture(channel.created_at);
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
        return;
      }
      case 'members': {
        const member = value as V2Row['members'];
        this.notFuture(member.created_at, member.removed_at);
        readable(CommunityWireMemberSchema, {
          memberId: member.id,
          kind: 'human',
          displayName: member.display_name,
          handle: member.handle,
          role: member.role,
          ownerMemberId: null,
          joinedAt: member.created_at,
        });
        return;
      }
      case 'agents': {
        const agent = value as V2Row['agents'];
        this.notFuture(agent.created_at, agent.revoked_at);
        readable(CommunityWireAgentSchema, {
          memberId: agent.id,
          displayName: agent.display_name,
          handle: agent.handle,
          ownerMemberId: agent.owner_member_id,
          active: false,
        });
        return;
      }
      case 'channelMembers':
      case 'agentChannelMembers':
        this.notFuture((value as V2Row['channelMembers']).joined_at);
        return;
      case 'auditEvents': {
        const event = value as V2Row['auditEvents'];
        invalid(event.community_id !== this.manifest.community.id);
        this.notFuture(event.created_at);
        return;
      }
      case 'entries': {
        const entry = value as V2Row['entries'];
        invalid((entry.author_member_id === null) === (entry.author_agent_id === null));
        invalid(entry.parent_entry_id !== entry.thread_root_entry_id);
        this.notFuture(entry.created_at);
        invalid(Buffer.byteLength(entry.text, 'utf8') > this.limits.textBytes);
        readable(CommunityWireEntrySchema, {
          id: entry.id,
          channelId: entry.channel_id,
          seq: 1,
          authorMemberId: entry.author_member_id ?? entry.author_agent_id,
          authorDisplayName: entry.author_display_name,
          authorKind: entry.author_agent_id ? 'agent' : 'human',
          text: entry.text,
          mentions: entry.mentions,
          parentEntryId: entry.parent_entry_id,
          threadRootEntryId: entry.thread_root_entry_id,
          createdAt: entry.created_at,
          cursor: 'cursor',
          attachments: [],
        });
        return;
      }
      case 'attachments': {
        const attachment = value as V2Row['attachments'];
        invalid(attachment.id === ICON_SOURCE_ID);
        invalid(ATTACHMENT_PATH.exec(attachment.archivePath)?.[1] !== attachment.id);
        invalid((attachment.uploaderMemberId === null) === (attachment.uploaderAgentId === null));
        this.notFuture(attachment.uploadedAt);
        if (attachment.byteSize > this.limits.attachmentBytes)
          throw new ImportFailure('IMPORT_TOO_LARGE');
        readable(CommunityWireAttachmentSchema, {
          id: attachment.id,
          name: sanitizeDisplayName(attachment.name),
          contentType: attachment.contentType,
          byteSize: attachment.byteSize,
          checksum: attachment.checksum,
          createdAt: attachment.uploadedAt,
        });
        return;
      }
    }
  }
}

/**
 * Checks across the rows of one pass over the export, in manifest order: how many rows each
 * collection holds, that exactly one member is the active owner and made the export, and that
 * messages come in channel then sequence order (the order the exporter writes and the restore
 * numbers them in). It keeps a few counters, never a row.
 */
export class V2Tally {
  readonly counts: Record<V2Collection, number> = {
    channels: 0,
    members: 0,
    agents: 0,
    channelMembers: 0,
    agentChannelMembers: 0,
    auditEvents: 0,
    entries: 0,
    attachments: 0,
  };
  shortened = 0;
  attachmentBytes = 0;
  private owners = 0;
  private lastEntry: { channel: string; seq: number } | null = null;

  constructor(private readonly manifest: CommunityExportManifestV2) {}

  /** Count one checked row of `key`. */
  add<K extends V2Collection>(key: K, row: V2Row[K]): void {
    this.counts[key]++;
    if (key === 'channels') this.shortened += importedChannel(row as V2Row['channels']).shortened;
    if (key === 'members') {
      const member = row as V2Row['members'];
      if (member.role === 'owner' && member.active) {
        this.owners++;
        invalid(member.id !== this.manifest.requesterMemberId);
      }
    }
    if (key === 'entries') {
      const entry = row as V2Row['entries'];
      const last = this.lastEntry;
      invalid(
        last !== null &&
          (entry.channel_id < last.channel ||
            (entry.channel_id === last.channel && entry.seq <= last.seq))
      );
      this.lastEntry = { channel: entry.channel_id, seq: entry.seq };
    }
    if (key === 'attachments') this.attachmentBytes += (row as V2Row['attachments']).byteSize;
  }

  /** After every row: each count matches the manifest, and there was exactly one owner. */
  finish(): void {
    for (const [key, count] of Object.entries(this.counts) as [V2Collection, number][])
      invalid(count !== this.manifest.counts[key]);
    invalid(this.owners !== 1);
  }
}
