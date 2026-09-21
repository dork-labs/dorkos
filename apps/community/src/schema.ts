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
  foreignKey,
} from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';

const time = (name: string) => timestamp(name, { withTimezone: true }).notNull().defaultNow();

/** Immutable identity and display record for this independent deployment. */
export const communities = pgTable(
  'communities',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    name: text('name').notNull(),
    description: text('description'),
    lifecycle: text('lifecycle').notNull().default('pending_owner'),
    lifecycleVersion: integer('lifecycle_version').notNull().default(1),
    createdAt: time('created_at'),
  },
  (table) => [
    check(
      'communities_lifecycle',
      sql`${table.lifecycle} IN ('pending_owner','active','suspended')`
    ),
    check('communities_lifecycle_version', sql`${table.lifecycleVersion} > 0`),
  ]
);

/** Irreversible history used to refuse a single-community backout after multi-tenant use. */
export const communityBackoutFence = pgTable(
  'community_backout_fence',
  {
    singleton: boolean('singleton').primaryKey().default(true),
    firstCommunityId: uuid('first_community_id'),
    multipleCommunitiesUsed: boolean('multiple_communities_used').notNull().default(false),
  },
  (table) => [check('community_backout_fence_singleton_check', sql`${table.singleton}`)]
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

/** Host operations authority, deliberately separate from community membership. */
export const hostOperators = pgTable('host_operators', {
  userId: text('user_id')
    .primaryKey()
    .references(() => users.id),
  createdAt: time('created_at'),
  revokedAt: timestamp('revoked_at', { withTimezone: true }),
});

/** Durable singleton gate for legacy tenant and blob namespace reconciliation. */
export const tenantReconciliation = pgTable(
  'tenant_reconciliation',
  {
    singleton: boolean('singleton').primaryKey().default(true),
    generation: bigint('generation', { mode: 'number' }).notNull().default(1),
    validatedGeneration: bigint('validated_generation', { mode: 'number' }),
    state: text('state').notNull().default('dirty'),
    communityId: uuid('community_id').references(() => communities.id),
    namespaceDigest: text('namespace_digest'),
    completedAt: timestamp('completed_at', { withTimezone: true }),
    invalidatedAt: timestamp('invalidated_at', { withTimezone: true }).notNull().defaultNow(),
    reasonCode: text('reason_code').notNull().default('migration_pending'),
  },
  (table) => [
    check('tenant_reconciliation_singleton', sql`${table.singleton}`),
    check('tenant_reconciliation_generation', sql`${table.generation} > 0`),
    check('tenant_reconciliation_state', sql`${table.state} IN ('dirty','ready')`),
    check(
      'tenant_reconciliation_ready',
      sql`(${table.state} = 'dirty' AND ${table.completedAt} IS NULL) OR (${table.state} = 'ready' AND ${table.completedAt} IS NOT NULL AND ${table.validatedGeneration} = ${table.generation} AND ${table.namespaceDigest} ~ '^[a-f0-9]{64}$')`
    ),
  ]
);

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
      .references(() => users.id),
    displayName: text('display_name').notNull(),
    handle: text('handle').notNull(),
    role: text('role').notNull(),
    active: boolean('active').notNull().default(true),
    createdAt: time('created_at'),
    removedAt: timestamp('removed_at', { withTimezone: true }),
  },
  (table) => [
    uniqueIndex('members_community_id_unique').on(table.communityId, table.id),
    uniqueIndex('members_community_user_unique').on(table.communityId, table.userId),
    uniqueIndex('members_handle_unique').on(table.communityId, table.handle),
    index('members_community_active_idx').on(table.communityId, table.active),
  ]
);

/** One-use owner setup grants. */
export const bootstrapGrants = pgTable(
  'bootstrap_grants',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tokenHash: text('token_hash').notNull().unique(),
    purpose: text('purpose').notNull().default('first_install'),
    communityId: uuid('community_id').references(() => communities.id),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    consumedAt: timestamp('consumed_at', { withTimezone: true }),
    createdAt: time('created_at'),
  },
  (table) => [
    check(
      'bootstrap_grants_purpose_tenant',
      sql`(${table.purpose} = 'first_install' AND ${table.communityId} IS NULL) OR (${table.purpose} = 'owner_claim' AND ${table.communityId} IS NOT NULL)`
    ),
    index('bootstrap_grants_community_idx').on(table.communityId),
  ]
);

/** Human admission invitations, scoped optionally to one channel. */
export const invites = pgTable(
  'invites',
  {
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
  },
  (table) => [
    uniqueIndex('invites_community_id_unique').on(table.communityId, table.id),
    foreignKey({
      name: 'invites_issuer_tenant_fk',
      columns: [table.communityId, table.issuerMemberId],
      foreignColumns: [members.communityId, members.id],
    }),
    foreignKey({
      name: 'invites_channel_tenant_fk',
      columns: [table.communityId, table.channelId],
      foreignColumns: [channels.communityId, channels.id],
    }),
  ]
);
/** One seat per invitation and account. */
export const inviteUses = pgTable(
  'invite_uses',
  {
    communityId: uuid('community_id')
      .notNull()
      .references(() => communities.id),
    inviteId: uuid('invite_id')
      .notNull()
      .references(() => invites.id),
    userId: text('user_id')
      .notNull()
      .references(() => users.id),
    createdAt: time('created_at'),
  },
  (table) => [
    primaryKey({ columns: [table.inviteId, table.userId] }),
    index('invite_uses_community_idx').on(table.communityId),
    foreignKey({
      name: 'invite_uses_invite_tenant_fk',
      columns: [table.communityId, table.inviteId],
      foreignColumns: [invites.communityId, invites.id],
    }),
  ]
);
/** Short-lived signup approval rows. */
export const pendingAdmissions = pgTable(
  'pending_admissions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    communityId: uuid('community_id')
      .notNull()
      .references(() => communities.id),
    inviteId: uuid('invite_id')
      .notNull()
      .references(() => invites.id),
    tokenHash: text('token_hash').notNull().unique(),
    accountId: text('account_id'),
    boundAt: timestamp('bound_at', { withTimezone: true }),
    consumedAt: timestamp('consumed_at', { withTimezone: true }),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    createdAt: time('created_at'),
  },
  (table) => [
    index('pending_admissions_community_idx').on(table.communityId),
    uniqueIndex('pending_admissions_community_id_unique').on(table.communityId, table.id),
    uniqueIndex('pending_admissions_account_binding_unique').on(
      table.communityId,
      table.id,
      table.accountId
    ),
    check(
      'pending_admissions_binding_shape',
      sql`(${table.accountId} IS NULL AND ${table.boundAt} IS NULL AND ${table.consumedAt} IS NULL) OR (${table.accountId} IS NOT NULL AND ${table.boundAt} IS NOT NULL)`
    ),
    foreignKey({
      name: 'pending_admissions_invite_tenant_fk',
      columns: [table.communityId, table.inviteId],
      foreignColumns: [invites.communityId, invites.id],
    }),
  ]
);
/** Content-free receipts for retrying a committed admission response. */
export const admissionReceipts = pgTable(
  'admission_receipts',
  {
    admissionId: uuid('admission_id')
      .primaryKey()
      .references(() => pendingAdmissions.id, { onDelete: 'cascade' }),
    communityId: uuid('community_id')
      .notNull()
      .references(() => communities.id),
    inviteId: uuid('invite_id')
      .notNull()
      .references(() => invites.id),
    accountId: text('account_id').notNull(),
    memberId: uuid('member_id')
      .notNull()
      .references(() => members.id),
    createdAt: time('created_at'),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  },
  (table) => [
    index('admission_receipts_community_idx').on(table.communityId),
    foreignKey({
      name: 'admission_receipts_admission_tenant_fk',
      columns: [table.communityId, table.admissionId],
      foreignColumns: [pendingAdmissions.communityId, pendingAdmissions.id],
    }),
    foreignKey({
      name: 'admission_receipts_admission_account_fk',
      columns: [table.communityId, table.admissionId, table.accountId],
      foreignColumns: [
        pendingAdmissions.communityId,
        pendingAdmissions.id,
        pendingAdmissions.accountId,
      ],
    }),
    foreignKey({
      name: 'admission_receipts_invite_tenant_fk',
      columns: [table.communityId, table.inviteId],
      foreignColumns: [invites.communityId, invites.id],
    }),
    foreignKey({
      name: 'admission_receipts_member_tenant_fk',
      columns: [table.communityId, table.memberId],
      foreignColumns: [members.communityId, members.id],
    }),
  ]
);
/** Browser approval pairing requests. */
export const connectionPairings = pgTable(
  'connection_pairings',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    communityId: uuid('community_id')
      .notNull()
      .references(() => communities.id),
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
  },
  (table) => [
    index('connection_pairings_community_idx').on(table.communityId),
    foreignKey({
      name: 'connection_pairings_member_tenant_fk',
      columns: [table.communityId, table.memberId],
      foreignColumns: [members.communityId, members.id],
    }),
  ]
);
/** Revocable server-to-server personal grants, stored as hashes. */
export const connectionGrants = pgTable(
  'connection_grants',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    communityId: uuid('community_id')
      .notNull()
      .references(() => communities.id),
    memberId: uuid('member_id')
      .notNull()
      .references(() => members.id),
    tokenHash: text('token_hash').notNull().unique(),
    installName: text('install_name').notNull(),
    scopes: text('scopes').array().notNull(),
    createdAt: time('created_at'),
    lastUsedAt: timestamp('last_used_at', { withTimezone: true }),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
  },
  (table) => [
    index('connection_grants_community_idx').on(table.communityId),
    foreignKey({
      name: 'connection_grants_member_tenant_fk',
      columns: [table.communityId, table.memberId],
      foreignColumns: [members.communityId, members.id],
    }),
  ]
);

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
  (table) => [
    uniqueIndex('channels_community_id_unique').on(table.communityId, table.id),
    index('channels_community_idx').on(table.communityId),
  ]
);
/** Explicit human channel membership. */
export const channelMembers = pgTable(
  'channel_members',
  {
    communityId: uuid('community_id')
      .notNull()
      .references(() => communities.id),
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
    index('channel_members_community_idx').on(table.communityId),
    foreignKey({
      name: 'channel_members_channel_tenant_fk',
      columns: [table.communityId, table.channelId],
      foreignColumns: [channels.communityId, channels.id],
    }),
    foreignKey({
      name: 'channel_members_member_tenant_fk',
      columns: [table.communityId, table.memberId],
      foreignColumns: [members.communityId, members.id],
    }),
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
    uniqueIndex('agents_community_id_unique').on(table.communityId, table.id),
    uniqueIndex('agents_handle_unique').on(table.communityId, table.handle),
    uniqueIndex('agents_owner_local_id_unique').on(table.ownerMemberId, table.localAgentId),
    index('agents_owner_active_idx').on(table.ownerMemberId, table.active),
    foreignKey({
      name: 'agents_owner_tenant_fk',
      columns: [table.communityId, table.ownerMemberId],
      foreignColumns: [members.communityId, members.id],
    }),
  ]
);
/** Agent bearer records contain only token hashes. */
export const agentCredentials = pgTable(
  'agent_credentials',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    communityId: uuid('community_id')
      .notNull()
      .references(() => communities.id),
    agentId: uuid('agent_id')
      .notNull()
      .references(() => agents.id),
    tokenHash: text('token_hash').notNull().unique(),
    createdAt: time('created_at'),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
  },
  (table) => [
    index('agent_credentials_community_idx').on(table.communityId),
    foreignKey({
      name: 'agent_credentials_agent_tenant_fk',
      columns: [table.communityId, table.agentId],
      foreignColumns: [agents.communityId, agents.id],
    }),
  ]
);
/** Explicit agent channel membership. */
export const agentChannelMembers = pgTable(
  'agent_channel_members',
  {
    communityId: uuid('community_id')
      .notNull()
      .references(() => communities.id),
    channelId: uuid('channel_id')
      .notNull()
      .references(() => channels.id),
    agentId: uuid('agent_id')
      .notNull()
      .references(() => agents.id),
    joinedAt: time('joined_at'),
  },
  (table) => [
    primaryKey({ columns: [table.channelId, table.agentId] }),
    index('agent_channel_members_community_idx').on(table.communityId),
    foreignKey({
      name: 'agent_channel_members_channel_tenant_fk',
      columns: [table.communityId, table.channelId],
      foreignColumns: [channels.communityId, channels.id],
    }),
    foreignKey({
      name: 'agent_channel_members_agent_tenant_fk',
      columns: [table.communityId, table.agentId],
      foreignColumns: [agents.communityId, agents.id],
    }),
  ]
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
  (table) => [
    primaryKey({ columns: [table.communityId, table.handle] }),
    foreignKey({
      name: 'community_handles_member_tenant_fk',
      columns: [table.communityId, table.memberId],
      foreignColumns: [members.communityId, members.id],
    }),
    foreignKey({
      name: 'community_handles_agent_tenant_fk',
      columns: [table.communityId, table.agentId],
      foreignColumns: [agents.communityId, agents.id],
    }),
  ]
);

/** Shared immutable entry content and resolved mention identities. */
export const entries = pgTable(
  'entries',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    communityId: uuid('community_id')
      .notNull()
      .references(() => communities.id),
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
    createdAt: time('created_at'),
  },
  (table) => [
    uniqueIndex('entries_community_id_unique').on(table.communityId, table.id),
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
    index('entries_community_idx').on(table.communityId),
    foreignKey({
      name: 'entries_channel_tenant_fk',
      columns: [table.communityId, table.channelId],
      foreignColumns: [channels.communityId, channels.id],
    }),
    foreignKey({
      name: 'entries_author_member_tenant_fk',
      columns: [table.communityId, table.authorMemberId],
      foreignColumns: [members.communityId, members.id],
    }),
    foreignKey({
      name: 'entries_author_agent_tenant_fk',
      columns: [table.communityId, table.authorAgentId],
      foreignColumns: [agents.communityId, agents.id],
    }),
    foreignKey({
      name: 'entries_parent_tenant_fk',
      columns: [table.communityId, table.parentEntryId],
      foreignColumns: [table.communityId, table.id],
    }),
    foreignKey({
      name: 'entries_thread_root_tenant_fk',
      columns: [table.communityId, table.threadRootEntryId],
      foreignColumns: [table.communityId, table.id],
    }),
  ]
);
/** Ordered, tenant-qualified human or agent targets mentioned by one entry. */
export const entryMentions = pgTable(
  'entry_mentions',
  {
    entryId: uuid('entry_id').notNull(),
    position: integer('position').notNull(),
    communityId: uuid('community_id')
      .notNull()
      .references(() => communities.id),
    mentionedMemberId: uuid('mentioned_member_id'),
    mentionedAgentId: uuid('mentioned_agent_id'),
  },
  (table) => [
    primaryKey({ columns: [table.entryId, table.position] }),
    foreignKey({
      name: 'entry_mentions_entry_tenant_fk',
      columns: [table.communityId, table.entryId],
      foreignColumns: [entries.communityId, entries.id],
    }).onDelete('cascade'),
    foreignKey({
      name: 'entry_mentions_member_tenant_fk',
      columns: [table.communityId, table.mentionedMemberId],
      foreignColumns: [members.communityId, members.id],
    }),
    foreignKey({
      name: 'entry_mentions_agent_tenant_fk',
      columns: [table.communityId, table.mentionedAgentId],
      foreignColumns: [agents.communityId, agents.id],
    }),
    check('entry_mentions_position', sql`${table.position} > 0`),
    check(
      'entry_mentions_exactly_one_target',
      sql`(${table.mentionedMemberId} IS NULL) <> (${table.mentionedAgentId} IS NULL)`
    ),
    index('entry_mentions_member_idx').on(table.communityId, table.mentionedMemberId),
    index('entry_mentions_agent_idx').on(table.communityId, table.mentionedAgentId),
  ]
);
/** Unbound or entry-bound blob metadata. */
export const attachments = pgTable(
  'attachments',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    communityId: uuid('community_id')
      .notNull()
      .references(() => communities.id),
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
    uniqueIndex('attachments_community_id_unique').on(table.communityId, table.id),
    index('attachments_entry_idx').on(table.entryId),
    index('attachments_community_idx').on(table.communityId),
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
    foreignKey({
      name: 'attachments_channel_tenant_fk',
      columns: [table.communityId, table.channelId],
      foreignColumns: [channels.communityId, channels.id],
    }),
    foreignKey({
      name: 'attachments_uploader_member_tenant_fk',
      columns: [table.communityId, table.uploaderMemberId],
      foreignColumns: [members.communityId, members.id],
    }),
    foreignKey({
      name: 'attachments_uploader_agent_tenant_fk',
      columns: [table.communityId, table.uploaderAgentId],
      foreignColumns: [agents.communityId, agents.id],
    }),
    foreignKey({
      name: 'attachments_entry_tenant_fk',
      columns: [table.communityId, table.entryId],
      foreignColumns: [entries.communityId, entries.id],
    }),
  ]
);
/** One-hour private export lifecycle; bytes remain in the configured BlobStore. */
export const exportArchives = pgTable(
  'export_archives',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    communityId: uuid('community_id')
      .notNull()
      .references(() => communities.id),
    requesterMemberId: uuid('requester_member_id')
      .notNull()
      .references(() => members.id),
    scope: text('scope').notNull(),
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
    uniqueIndex('export_archives_community_id_unique').on(table.communityId, table.id),
    check('export_archives_scope', sql`${table.scope} IN ('personal','owner')`),
    index('export_archives_community_idx').on(table.communityId),
    index('export_archives_expiry_idx')
      .on(table.cleanupNextAttemptAt, table.expiresAt, table.id)
      .where(sql`${table.deletedAt} IS NULL`),
    foreignKey({
      name: 'export_archives_requester_tenant_fk',
      columns: [table.communityId, table.requesterMemberId],
      foreignColumns: [members.communityId, members.id],
    }),
  ]
);
/** Ordered, tenant-qualified channel selection captured by one export archive. */
export const exportArchiveChannels = pgTable(
  'export_archive_channels',
  {
    exportArchiveId: uuid('export_archive_id').notNull(),
    position: integer('position').notNull(),
    communityId: uuid('community_id')
      .notNull()
      .references(() => communities.id),
    channelId: uuid('channel_id').notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.exportArchiveId, table.position] }),
    foreignKey({
      name: 'export_archive_channels_archive_tenant_fk',
      columns: [table.communityId, table.exportArchiveId],
      foreignColumns: [exportArchives.communityId, exportArchives.id],
    }).onDelete('cascade'),
    foreignKey({
      name: 'export_archive_channels_channel_tenant_fk',
      columns: [table.communityId, table.channelId],
      foreignColumns: [channels.communityId, channels.id],
    }),
    check('export_archive_channels_position', sql`${table.position} > 0`),
    index('export_archive_channels_channel_idx').on(table.communityId, table.channelId),
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
/** Tenant ownership and lifecycle for every managed attachment or export object. */
export const managedBlobs = pgTable(
  'managed_blobs',
  {
    blobKey: text('blob_key').primaryKey(),
    communityId: uuid('community_id')
      .notNull()
      .references(() => communities.id),
    purpose: text('purpose').notNull(),
    communityLifecycleVersion: integer('community_lifecycle_version').notNull(),
    state: text('state').notNull().default('reserved'),
    byteSize: bigint('byte_size', { mode: 'number' }),
    checksum: text('checksum'),
    createdAt: time('created_at'),
    storedAt: timestamp('stored_at', { withTimezone: true }),
    committedAt: timestamp('committed_at', { withTimezone: true }),
  },
  (table) => [
    uniqueIndex('managed_blobs_community_key_unique').on(table.communityId, table.blobKey),
    index('managed_blobs_community_state_idx').on(table.communityId, table.state, table.createdAt),
    check(
      'managed_blobs_purpose',
      sql`${table.purpose} IN ('attachment','export','legacy_cleanup')`
    ),
    check('managed_blobs_key', sql`${table.blobKey} ~ '^[a-f0-9]{64}$'`),
    check(
      'managed_blobs_state',
      sql`${table.state} IN ('reserved','stored','committed','pending_delete')`
    ),
    check('managed_blobs_lifecycle_version', sql`${table.communityLifecycleVersion} > 0`),
    check(
      'managed_blobs_stored_metadata',
      sql`(${table.state} = 'reserved' AND ${table.byteSize} IS NULL AND ${table.checksum} IS NULL AND ${table.storedAt} IS NULL) OR (${table.state} IN ('stored','committed') AND ${table.byteSize} IS NOT NULL AND ${table.byteSize} > 0 AND ${table.checksum} IS NOT NULL AND ${table.storedAt} IS NOT NULL) OR (${table.state} = 'pending_delete' AND ((${table.byteSize} IS NULL AND ${table.checksum} IS NULL AND ${table.storedAt} IS NULL) OR (${table.byteSize} IS NOT NULL AND ${table.byteSize} > 0 AND ${table.checksum} IS NOT NULL AND ${table.storedAt} IS NOT NULL)))`
    ),
    check(
      'managed_blobs_commit_timestamp',
      sql`(${table.state} <> 'committed' OR ${table.committedAt} IS NOT NULL) AND (${table.committedAt} IS NULL OR ${table.state} IN ('committed','pending_delete'))`
    ),
  ]
);
/** Monotonic per-human read positions. */
export const readCursors = pgTable(
  'read_cursors',
  {
    communityId: uuid('community_id')
      .notNull()
      .references(() => communities.id),
    channelId: uuid('channel_id')
      .notNull()
      .references(() => channels.id),
    memberId: uuid('member_id')
      .notNull()
      .references(() => members.id),
    seq: bigint('seq', { mode: 'number' }).notNull().default(0),
    updatedAt: time('updated_at'),
  },
  (table) => [
    primaryKey({ columns: [table.channelId, table.memberId] }),
    index('read_cursors_community_idx').on(table.communityId),
    foreignKey({
      name: 'read_cursors_channel_tenant_fk',
      columns: [table.communityId, table.channelId],
      foreignColumns: [channels.communityId, channels.id],
    }),
    foreignKey({
      name: 'read_cursors_member_tenant_fk',
      columns: [table.communityId, table.memberId],
      foreignColumns: [members.communityId, members.id],
    }),
  ]
);
/** Atomic owner quota bucket. */
export const ownerQuotaWindows = pgTable(
  'owner_quota_windows',
  {
    communityId: uuid('community_id')
      .notNull()
      .references(() => communities.id),
    ownerMemberId: uuid('owner_member_id')
      .notNull()
      .references(() => members.id),
    windowStart: timestamp('window_start', { withTimezone: true }).notNull(),
    postCount: integer('post_count').notNull().default(0),
    uploadBytes: bigint('upload_bytes', { mode: 'number' }).notNull().default(0),
  },
  (table) => [
    primaryKey({ columns: [table.ownerMemberId, table.windowStart] }),
    index('owner_quota_windows_community_idx').on(table.communityId),
    foreignKey({
      name: 'owner_quota_windows_owner_tenant_fk',
      columns: [table.communityId, table.ownerMemberId],
      foreignColumns: [members.communityId, members.id],
    }),
  ]
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
  (table) => [
    index('audit_events_community_created_idx').on(table.communityId, table.createdAt),
    foreignKey({
      name: 'audit_events_actor_tenant_fk',
      columns: [table.communityId, table.actorMemberId],
      foreignColumns: [members.communityId, members.id],
    }),
  ]
);
