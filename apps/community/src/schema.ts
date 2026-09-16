import {
  boolean,
  integer,
  bigint,
  pgTable,
  text,
  timestamp,
  uuid,
  uniqueIndex,
  index,
  primaryKey,
  check,
} from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';

const time = (name: string) => timestamp(name, { withTimezone: true }).notNull().defaultNow();

/** Immutable identity and display record for this independent deployment. */
export const communities = pgTable(
  'communities',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    singleton: boolean('singleton').notNull().default(true).unique(),
    name: text('name').notNull(),
    description: text('description'),
    createdAt: time('created_at'),
  },
  (table) => [check('community_singleton', sql`${table.singleton}`)]
);

/** Better Auth core user table, using its native camelCase PostgreSQL columns. */
export const users = pgTable('user', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  email: text('email').notNull().unique(),
  emailVerified: boolean('emailVerified').notNull().default(false),
  image: text('image'),
  createdAt: timestamp('createdAt').notNull().defaultNow(),
  updatedAt: timestamp('updatedAt').notNull().defaultNow(),
});
/** Better Auth core sessions. */
export const sessions = pgTable(
  'session',
  {
    id: text('id').primaryKey(),
    expiresAt: timestamp('expiresAt').notNull(),
    token: text('token').notNull().unique(),
    createdAt: timestamp('createdAt').notNull().defaultNow(),
    updatedAt: timestamp('updatedAt').notNull().defaultNow(),
    ipAddress: text('ipAddress'),
    userAgent: text('userAgent'),
    userId: text('userId')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
  },
  (table) => [index('session_user_idx').on(table.userId)]
);
/** Better Auth OAuth and password accounts. */
export const accounts = pgTable(
  'account',
  {
    id: text('id').primaryKey(),
    accountId: text('accountId').notNull(),
    providerId: text('providerId').notNull(),
    userId: text('userId')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    accessToken: text('accessToken'),
    refreshToken: text('refreshToken'),
    idToken: text('idToken'),
    accessTokenExpiresAt: timestamp('accessTokenExpiresAt'),
    refreshTokenExpiresAt: timestamp('refreshTokenExpiresAt'),
    scope: text('scope'),
    password: text('password'),
    createdAt: timestamp('createdAt').notNull().defaultNow(),
    updatedAt: timestamp('updatedAt').notNull().defaultNow(),
  },
  (table) => [index('account_user_idx').on(table.userId)]
);
/** Better Auth verification codes. */
export const verifications = pgTable('verification', {
  id: text('id').primaryKey(),
  identifier: text('identifier').notNull(),
  value: text('value').notNull(),
  expiresAt: timestamp('expiresAt').notNull(),
  createdAt: timestamp('createdAt').notNull().defaultNow(),
  updatedAt: timestamp('updatedAt').notNull().defaultNow(),
});

/** Human admissions and their authority. */
export const members = pgTable(
  'members',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    communityId: uuid('community_id')
      .notNull()
      .references(() => communities.id),
    userId: text('user_id')
      .notNull()
      .unique()
      .references(() => users.id),
    displayName: text('display_name').notNull(),
    handle: text('handle').notNull(),
    role: text('role').notNull(),
    active: boolean('active').notNull().default(true),
    createdAt: time('created_at'),
    removedAt: timestamp('removed_at', { withTimezone: true }),
  },
  (table) => [
    uniqueIndex('members_handle_unique').on(table.communityId, table.handle),
    index('members_community_active_idx').on(table.communityId, table.active),
  ]
);

/** One-use owner setup grants. */
export const bootstrapGrants = pgTable('bootstrap_grants', {
  id: uuid('id').primaryKey().defaultRandom(),
  tokenHash: text('token_hash').notNull().unique(),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  consumedAt: timestamp('consumed_at', { withTimezone: true }),
  createdAt: time('created_at'),
});

/** Human admission invitations, scoped optionally to one channel. */
export const invites = pgTable('invites', {
  id: uuid('id').primaryKey().defaultRandom(),
  communityId: uuid('community_id')
    .notNull()
    .references(() => communities.id),
  issuerMemberId: uuid('issuer_member_id')
    .notNull()
    .references(() => members.id),
  channelId: uuid('channel_id'),
  tokenHash: text('token_hash').notNull().unique(),
  seatLimit: integer('seat_limit').notNull(),
  useCount: integer('use_count').notNull().default(0),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  revokedAt: timestamp('revoked_at', { withTimezone: true }),
  createdAt: time('created_at'),
});
/** One seat per invitation and account. */
export const inviteUses = pgTable(
  'invite_uses',
  {
    inviteId: uuid('invite_id')
      .notNull()
      .references(() => invites.id),
    userId: text('user_id')
      .notNull()
      .references(() => users.id),
    createdAt: time('created_at'),
  },
  (table) => [primaryKey({ columns: [table.inviteId, table.userId] })]
);
/** Short-lived signup approval rows. */
export const pendingAdmissions = pgTable('pending_admissions', {
  id: uuid('id').primaryKey().defaultRandom(),
  inviteId: uuid('invite_id')
    .notNull()
    .references(() => invites.id),
  tokenHash: text('token_hash').notNull().unique(),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  createdAt: time('created_at'),
});
/** Browser approval pairing requests. */
export const connectionPairings = pgTable('connection_pairings', {
  id: uuid('id').primaryKey().defaultRandom(),
  verifierHash: text('verifier_hash').notNull(),
  installName: text('install_name').notNull(),
  scopes: text('scopes').array().notNull(),
  memberId: uuid('member_id').references(() => members.id),
  codeHash: text('code_hash'),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  consumedAt: timestamp('consumed_at', { withTimezone: true }),
  approvedAt: timestamp('approved_at', { withTimezone: true }),
  polledAt: timestamp('polled_at', { withTimezone: true }),
  cancelledAt: timestamp('cancelled_at', { withTimezone: true }),
  createdAt: time('created_at'),
});
/** Revocable server-to-server personal grants, stored as hashes. */
export const connectionGrants = pgTable('connection_grants', {
  id: uuid('id').primaryKey().defaultRandom(),
  memberId: uuid('member_id')
    .notNull()
    .references(() => members.id),
  tokenHash: text('token_hash').notNull().unique(),
  installName: text('install_name').notNull(),
  scopes: text('scopes').array().notNull(),
  createdAt: time('created_at'),
  lastUsedAt: timestamp('last_used_at', { withTimezone: true }),
  revokedAt: timestamp('revoked_at', { withTimezone: true }),
});

/** Durable channel identity and commit-serialized sequence counter. */
export const channels = pgTable(
  'channels',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    communityId: uuid('community_id')
      .notNull()
      .references(() => communities.id),
    name: text('name').notNull(),
    description: text('description'),
    visibility: text('visibility').notNull(),
    archived: boolean('archived').notNull().default(false),
    lastSeq: bigint('last_seq', { mode: 'number' }).notNull().default(0),
    epoch: integer('epoch').notNull().default(1),
    createdAt: time('created_at'),
  },
  (table) => [index('channels_community_idx').on(table.communityId)]
);
/** Explicit human channel membership. */
export const channelMembers = pgTable(
  'channel_members',
  {
    channelId: uuid('channel_id')
      .notNull()
      .references(() => channels.id),
    memberId: uuid('member_id')
      .notNull()
      .references(() => members.id),
    joinedAt: time('joined_at'),
  },
  (table) => [
    primaryKey({ columns: [table.channelId, table.memberId] }),
    index('channel_members_member_idx').on(table.memberId),
  ]
);

/** Agent identities are bound to one active human owner. */
export const agents = pgTable(
  'agents',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    communityId: uuid('community_id')
      .notNull()
      .references(() => communities.id),
    ownerMemberId: uuid('owner_member_id')
      .notNull()
      .references(() => members.id),
    displayName: text('display_name').notNull(),
    handle: text('handle').notNull(),
    localAgentId: text('local_agent_id'),
    active: boolean('active').notNull().default(true),
    createdAt: time('created_at'),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
  },
  (table) => [
    uniqueIndex('agents_handle_unique').on(table.communityId, table.handle),
    uniqueIndex('agents_owner_local_id_unique').on(table.ownerMemberId, table.localAgentId),
    index('agents_owner_active_idx').on(table.ownerMemberId, table.active),
  ]
);
/** Agent bearer records contain only token hashes. */
export const agentCredentials = pgTable('agent_credentials', {
  id: uuid('id').primaryKey().defaultRandom(),
  agentId: uuid('agent_id')
    .notNull()
    .references(() => agents.id),
  tokenHash: text('token_hash').notNull().unique(),
  createdAt: time('created_at'),
  revokedAt: timestamp('revoked_at', { withTimezone: true }),
});
/** Explicit agent channel membership. */
export const agentChannelMembers = pgTable(
  'agent_channel_members',
  {
    channelId: uuid('channel_id')
      .notNull()
      .references(() => channels.id),
    agentId: uuid('agent_id')
      .notNull()
      .references(() => agents.id),
    joinedAt: time('joined_at'),
  },
  (table) => [primaryKey({ columns: [table.channelId, table.agentId] })]
);
/** One handle namespace shared by humans and agents. */
export const communityHandles = pgTable(
  'community_handles',
  {
    communityId: uuid('community_id')
      .notNull()
      .references(() => communities.id),
    handle: text('handle').notNull(),
    memberId: uuid('member_id')
      .unique()
      .references(() => members.id),
    agentId: uuid('agent_id')
      .unique()
      .references(() => agents.id),
  },
  (table) => [primaryKey({ columns: [table.communityId, table.handle] })]
);

/** Shared immutable entry content and resolved mention identities. */
export const entries = pgTable(
  'entries',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    channelId: uuid('channel_id')
      .notNull()
      .references(() => channels.id),
    seq: bigint('seq', { mode: 'number' }).notNull(),
    authorMemberId: uuid('author_member_id').references(() => members.id),
    authorAgentId: uuid('author_agent_id').references(() => agents.id),
    authorDisplayName: text('author_display_name').notNull(),
    text: text('text').notNull(),
    parentEntryId: uuid('parent_entry_id'),
    threadRootEntryId: uuid('thread_root_entry_id'),
    idempotencyKey: text('idempotency_key').notNull(),
    payloadHash: text('payload_hash').notNull(),
    mentions: uuid('mentions')
      .array()
      .notNull()
      .default(sql`'{}'::uuid[]`),
    createdAt: time('created_at'),
  },
  (table) => [
    uniqueIndex('entries_channel_seq_unique').on(table.channelId, table.seq),
    uniqueIndex('entries_author_key_unique').on(
      table.authorMemberId,
      table.channelId,
      table.idempotencyKey
    ),
    uniqueIndex('entries_agent_key_unique').on(
      table.authorAgentId,
      table.channelId,
      table.idempotencyKey
    ),
    check(
      'entries_exactly_one_author',
      sql`(${table.authorMemberId} IS NULL) <> (${table.authorAgentId} IS NULL)`
    ),
    index('entries_thread_idx').on(table.channelId, table.threadRootEntryId, table.seq),
  ]
);
/** Unbound or entry-bound blob metadata. */
export const attachments = pgTable(
  'attachments',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    channelId: uuid('channel_id')
      .notNull()
      .references(() => channels.id),
    uploaderMemberId: uuid('uploader_member_id').references(() => members.id),
    uploaderAgentId: uuid('uploader_agent_id').references(() => agents.id),
    entryId: uuid('entry_id').references(() => entries.id),
    blobKey: text('blob_key').notNull().unique(),
    displayName: text('display_name').notNull(),
    contentType: text('content_type').notNull(),
    byteSize: integer('byte_size').notNull(),
    checksum: text('checksum').notNull(),
    idempotencyKey: text('idempotency_key'),
    requestHash: text('request_hash'),
    uploadedAt: time('uploaded_at'),
    cleanupAttempts: integer('cleanup_attempts').notNull().default(0),
    cleanupNextAttemptAt: timestamp('cleanup_next_attempt_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    index('attachments_entry_idx').on(table.entryId),
    uniqueIndex('attachments_human_retry_idx')
      .on(table.uploaderMemberId, table.channelId, table.idempotencyKey)
      .where(sql`${table.uploaderMemberId} IS NOT NULL`),
    uniqueIndex('attachments_agent_retry_idx')
      .on(table.uploaderAgentId, table.channelId, table.idempotencyKey)
      .where(sql`${table.uploaderAgentId} IS NOT NULL`),
    index('attachments_orphan_idx')
      .on(table.cleanupNextAttemptAt, table.uploadedAt, table.id)
      .where(sql`${table.entryId} IS NULL`),
    check(
      'attachments_exactly_one_uploader',
      sql`(${table.uploaderMemberId} IS NULL) <> (${table.uploaderAgentId} IS NULL)`
    ),
  ]
);
/** One-hour private export lifecycle; bytes remain in the configured BlobStore. */
export const exportArchives = pgTable(
  'export_archives',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    requesterMemberId: uuid('requester_member_id')
      .notNull()
      .references(() => members.id),
    scope: text('scope').notNull(),
    channelIds: uuid('channel_ids').array().notNull().default([]),
    blobKey: text('blob_key').notNull().unique(),
    byteSize: bigint('byte_size', { mode: 'number' }).notNull(),
    createdAt: time('created_at'),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    deletedAt: timestamp('deleted_at', { withTimezone: true }),
    cleanupAttempts: integer('cleanup_attempts').notNull().default(0),
    cleanupNextAttemptAt: timestamp('cleanup_next_attempt_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    check('export_archives_scope', sql`${table.scope} IN ('personal','owner')`),
    index('export_archives_expiry_idx')
      .on(table.cleanupNextAttemptAt, table.expiresAt, table.id)
      .where(sql`${table.deletedAt} IS NULL`),
  ]
);
/** Durable cleanup work for blobs whose metadata transaction did not commit. */
export const pendingBlobDeletions = pgTable(
  'pending_blob_deletions',
  {
    blobKey: text('blob_key').primaryKey(),
    createdAt: time('created_at'),
    attempts: integer('attempts').notNull().default(0),
    lastErrorAt: timestamp('last_error_at', { withTimezone: true }),
    nextAttemptAt: timestamp('next_attempt_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index('pending_blob_deletions_due_idx').on(table.nextAttemptAt, table.createdAt, table.blobKey),
  ]
);
/** Monotonic per-human read positions. */
export const readCursors = pgTable(
  'read_cursors',
  {
    channelId: uuid('channel_id')
      .notNull()
      .references(() => channels.id),
    memberId: uuid('member_id')
      .notNull()
      .references(() => members.id),
    seq: bigint('seq', { mode: 'number' }).notNull().default(0),
    updatedAt: time('updated_at'),
  },
  (table) => [primaryKey({ columns: [table.channelId, table.memberId] })]
);
/** Atomic owner quota bucket. */
export const ownerQuotaWindows = pgTable(
  'owner_quota_windows',
  {
    ownerMemberId: uuid('owner_member_id')
      .notNull()
      .references(() => members.id),
    windowStart: timestamp('window_start', { withTimezone: true }).notNull(),
    postCount: integer('post_count').notNull().default(0),
    uploadBytes: bigint('upload_bytes', { mode: 'number' }).notNull().default(0),
  },
  (table) => [primaryKey({ columns: [table.ownerMemberId, table.windowStart] })]
);
/** Security-relevant membership and channel actions. */
export const auditEvents = pgTable(
  'audit_events',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    communityId: uuid('community_id')
      .notNull()
      .references(() => communities.id),
    actorMemberId: uuid('actor_member_id').references(() => members.id),
    action: text('action').notNull(),
    subjectId: text('subject_id'),
    createdAt: time('created_at'),
  },
  (table) => [index('audit_events_community_created_idx').on(table.communityId, table.createdAt)]
);
