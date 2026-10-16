import {
  CommunityExportAgentChannelMemberRowSchema,
  CommunityExportAgentRowSchema,
  CommunityExportAttachmentRowSchema,
  CommunityExportAuditEventRowSchema,
  CommunityExportBanRowSchema,
  CommunityExportReportRowSchema,
  CommunityExportChannelMemberRowSchema,
  CommunityExportChannelRowSchema,
  CommunityExportEntryRowSchema,
  CommunityExportEntryRowV3Schema,
  CommunityExportMemberRowSchema,
  CommunityExportMemberRowV3Schema,
  CommunityWireAgentSchema,
  CommunityWireAttachmentSchema,
  CommunityWireChannelSchema,
  CommunityWireEntrySchema,
  CommunityWireMemberSchema,
} from '@dorkos/shared/community-wire';
import { createHash } from 'node:crypto';
import type { z, ZodType } from 'zod';
import { sanitizeDisplayName } from '../storage/blob-store.js';
import {
  IMPORT_CLOCK_SKEW_MS,
  ImportFailure,
  importedChannel,
  type ImportLimits,
} from './manifest.js';
import { parseRow } from './ndjson.js';
import { ICON_SOURCE_ID, type DataExportManifest, type V2Collection } from './v2-archive.js';

/**
 * An agent's own member row in a version 3 export. The importer never writes it: the agents
 * collection is the agent, and restoring an agent writes its member row (migration 0042's
 * trigger). The row is checked against the agents collection instead (`V2Tally`).
 */
export interface AgentMemberRow {
  kind: 'agent';
  id: string;
  owner_member_id: string;
  created_at: string;
  removed_at: string | null;
}

/** A person's member row, the same in versions 2 and 3. */
export type PersonMemberRow = z.infer<typeof CommunityExportMemberRowSchema> & { kind?: 'person' };

/**
 * One row of each data-file collection, as its strict schema parses it. Version 3 rows are read
 * into the version 2 shape: a person's member row as it was, an agent's as an
 * {@link AgentMemberRow}, and an agent's message with only the agent as its author, so every
 * writer reads one shape.
 */
export type V2Row = {
  channels: z.infer<typeof CommunityExportChannelRowSchema>;
  members: PersonMemberRow | AgentMemberRow;
  agents: z.infer<typeof CommunityExportAgentRowSchema>;
  channelMembers: z.infer<typeof CommunityExportChannelMemberRowSchema>;
  agentChannelMembers: z.infer<typeof CommunityExportAgentChannelMemberRowSchema>;
  auditEvents: z.infer<typeof CommunityExportAuditEventRowSchema>;
  entries: z.infer<typeof CommunityExportEntryRowSchema>;
  attachments: z.infer<typeof CommunityExportAttachmentRowSchema>;
  bans: z.infer<typeof CommunityExportBanRowSchema>;
  reports: z.infer<typeof CommunityExportReportRowSchema>;
};

const ROW_SCHEMAS: { [K in V2Collection]: ZodType } = {
  channels: CommunityExportChannelRowSchema,
  members: CommunityExportMemberRowSchema,
  agents: CommunityExportAgentRowSchema,
  channelMembers: CommunityExportChannelMemberRowSchema,
  agentChannelMembers: CommunityExportAgentChannelMemberRowSchema,
  auditEvents: CommunityExportAuditEventRowSchema,
  entries: CommunityExportEntryRowSchema,
  attachments: CommunityExportAttachmentRowSchema,
  bans: CommunityExportBanRowSchema,
  reports: CommunityExportReportRowSchema,
};

/** A version 3 export's member and message rows; every other collection is as in version 2. */
const V3_ROW_SCHEMAS: { [K in V2Collection]: ZodType } = {
  ...ROW_SCHEMAS,
  members: CommunityExportMemberRowV3Schema,
  entries: CommunityExportEntryRowV3Schema,
};

/** Read a version 3 member or message row into the version 2 shape (see {@link V2Row}). */
function fromV3<K extends V2Collection>(key: K, row: Record<string, unknown>): V2Row[K] {
  if (key === 'members') {
    const { kind, owner_member_id: owner, ...person } = row;
    if (kind === 'person') return { ...person, kind } as V2Row[K];
    return {
      kind,
      id: row.id,
      owner_member_id: owner,
      created_at: row.created_at,
      removed_at: row.removed_at,
    } as V2Row[K];
  }
  if (key === 'entries' && row.author_agent_id !== null)
    return { ...row, author_member_id: null } as V2Row[K];
  return row as V2Row[K];
}

/** Whether a member row is an agent's own (version 3), which the importer does not write. */
export const isAgentMemberRow = (row: V2Row['members']): row is AgentMemberRow =>
  row.kind === 'agent';

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
    readonly manifest: DataExportManifest,
    private readonly limits: ImportLimits,
    receivedAt: Date
  ) {
    this.latest = receivedAt.getTime() + IMPORT_CLOCK_SKEW_MS;
  }

  /** Parse and check one line of `key`'s files. */
  parse<K extends V2Collection>(key: K, line: Uint8Array): V2Row[K] {
    const row =
      this.manifest.version === 3
        ? fromV3(key, parseRow(line, V3_ROW_SCHEMAS[key]) as Record<string, unknown>)
        : (parseRow(line, ROW_SCHEMAS[key]) as V2Row[K]);
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
        // An agent's own row: its schema checked its shape, and the tally checks its agent.
        if (isAgentMemberRow(member)) return;
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
      case 'bans': {
        const ban = value as V2Row['bans'];
        this.notFuture(ban.created_at, ban.lifted_at);
        invalid(ban.lifted_at !== null && Date.parse(ban.lifted_at) < Date.parse(ban.created_at));
        return;
      }
      case 'reports': {
        const report = value as V2Row['reports'];
        this.notFuture(report.created_at, report.resolved_at);
        invalid((report.source === 'check') !== (report.check_name !== null));
        invalid(report.source === 'check' && report.reporter_member_id !== null);
        invalid((report.status === 'open') !== (report.resolved_at === null));
        invalid((report.status === 'actioned') !== (report.action !== null));
        return;
      }
      case 'auditEvents': {
        const event = value as V2Row['auditEvents'];
        invalid(event.community_id !== this.manifest.community.id);
        // A check's record belongs on a `decision.*` row about one message, as 0036 requires.
        invalid(
          event.decision !== undefined &&
            (!event.action.startsWith('decision.') || event.subject_id === null)
        );
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
 * One (agent id, owner) pair as a number, so two collections' pairs compare as multisets by sum
 * in constant memory: a sum matches only when the pairs do, but for a deliberate SHA-256
 * collision.
 */
function agentKey(id: string, owner: string): bigint {
  return BigInt(`0x${createHash('sha256').update(`${id}:${owner}`).digest('hex')}`);
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
    bans: 0,
    reports: 0,
  };
  shortened = 0;
  attachmentBytes = 0;
  /** Version 3: the agents' own member rows among `counts.members`. */
  agentMembers = 0;
  private owners = 0;
  private lastEntry: { channel: string; seq: number } | null = null;
  /** Version 3: (id, owner) of every agent member row and of every agent, as multisets. */
  private readonly agentRows = { members: 0n, agents: 0n };

  constructor(private readonly manifest: DataExportManifest) {}

  /** Count one checked row of `key`. */
  add<K extends V2Collection>(key: K, row: V2Row[K]): void {
    this.counts[key]++;
    if (key === 'channels') this.shortened += importedChannel(row as V2Row['channels']).shortened;
    if (key === 'members' && isAgentMemberRow(row as V2Row['members'])) {
      const member = row as AgentMemberRow;
      this.agentMembers++;
      this.agentRows.members += agentKey(member.id, member.owner_member_id);
    } else if (key === 'members') {
      const member = row as PersonMemberRow;
      if (member.role === 'owner' && member.active) {
        this.owners++;
        invalid(member.id !== this.manifest.requesterMemberId);
      }
    }
    if (key === 'agents') {
      const agent = row as V2Row['agents'];
      this.agentRows.agents += agentKey(agent.id, agent.owner_member_id);
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
      // An archive from before bans existed lists none.
      invalid(count !== (this.manifest.counts[key] ?? 0));
    invalid(this.owners !== 1);
    // Version 3: exactly one member row per agent, with the agent's id and owner, and no other.
    if (this.manifest.version === 3) {
      invalid(this.agentMembers !== this.counts.agents);
      invalid(this.agentRows.members !== this.agentRows.agents);
    }
  }
}
