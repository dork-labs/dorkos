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
    admissionPolicy: text('admission_policy').notNull().default('invite_only'),
    settingsVersion: integer('settings_version').notNull().default(1),
    iconBlobKey: text('icon_blob_key'),
    iconContentType: text('icon_content_type'),
    lifecycle: text('lifecycle').notNull().default('pending_owner'),
    lifecycleVersion: integer('lifecycle_version').notNull().default(1),
    suspendedFromState: text('suspended_from_state'),
    activatedAt: timestamp('activated_at', { withTimezone: true }),
    archivedAt: timestamp('archived_at', { withTimezone: true }),
    suspendedAt: timestamp('suspended_at', { withTimezone: true }),
    deleteRequestedAt: timestamp('delete_requested_at', { withTimezone: true }),
    deleteAfter: timestamp('delete_after', { withTimezone: true }),
    deleteRequestedBy: uuid('delete_requested_by'),
    createdAt: time('created_at'),
  },
  (table) => [
    check(
      'communities_lifecycle',
      sql`${table.lifecycle} IN ('pending_owner','active','archived','suspended','deletion_pending')`
    ),
    check('communities_lifecycle_version', sql`${table.lifecycleVersion} > 0`),
    check('communities_settings_version', sql`${table.settingsVersion} > 0`),
    check(
      'communities_admission_policy',
      sql`${table.admissionPolicy} IN ('invite_only','closed')`
    ),
    check(
      'communities_name_length',
      sql`${table.name} = btrim(${table.name}) AND char_length(${table.name}) BETWEEN 1 AND 80`
    ),
    check(
      'communities_description_length',
      sql`${table.description} IS NULL OR char_length(${table.description}) <= 1000`
    ),
    check(
      'communities_icon_metadata',
      sql`(${table.iconBlobKey} IS NULL AND ${table.iconContentType} IS NULL) OR (${table.iconBlobKey} IS NOT NULL AND ${table.iconContentType} IS NOT NULL AND ${table.iconContentType} IN ('image/png','image/jpeg','image/gif','image/webp'))`
    ),
    check(
      'communities_suspension_state',
      sql`(${table.lifecycle} = 'suspended' AND ${table.suspendedFromState} IS NOT NULL AND ${table.suspendedFromState} IN ('active','archived') AND ${table.suspendedAt} IS NOT NULL) OR (${table.lifecycle} <> 'suspended' AND ${table.suspendedFromState} IS NULL AND ${table.suspendedAt} IS NULL)`
    ),
    check(
      'communities_deletion_state',
      sql`(${table.lifecycle} = 'deletion_pending' AND ${table.deleteRequestedAt} IS NOT NULL AND ${table.deleteAfter} IS NOT NULL AND ${table.deleteRequestedBy} IS NOT NULL AND ${table.deleteAfter} = ${table.deleteRequestedAt} + interval '7 days') OR (${table.lifecycle} <> 'deletion_pending' AND ${table.deleteRequestedAt} IS NULL AND ${table.deleteAfter} IS NULL AND ${table.deleteRequestedBy} IS NULL)`
    ),
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

/** Host-owned machine credentials for host routes. Only the secret's hash is stored. */
export const hostApiKeys = pgTable(
  'host_api_keys',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    label: text('label').notNull(),
    prefix: text('prefix').notNull(),
    secretHash: text('secret_hash').notNull().unique(),
    scopes: text('scopes').array().notNull(),
    issuedVia: text('issued_via').notNull(),
    issuedByUserId: text('issued_by_user_id').references(() => users.id),
    createdAt: time('created_at'),
    expiresAt: timestamp('expires_at', { withTimezone: true }),
    lastUsedAt: timestamp('last_used_at', { withTimezone: true }),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
    revokedByUserId: text('revoked_by_user_id').references(() => users.id),
  },
  (table) => [
    index('host_api_keys_created_idx').on(table.createdAt.desc(), table.id),
    check(
      'host_api_keys_label',
      sql`${table.label} = btrim(${table.label}) AND char_length(${table.label}) BETWEEN 1 AND 80`
    ),
    check('host_api_keys_prefix', sql`${table.prefix} ~ '^dkh_[A-Za-z0-9_-]{6}$'`),
    check('host_api_keys_secret_hash', sql`${table.secretHash} ~ '^[a-f0-9]{64}$'`),
    check(
      'host_api_keys_scopes',
      sql`cardinality(${table.scopes}) BETWEEN 1 AND 4 AND ${table.scopes} <@ ARRAY['communities:read','communities:write','communities:lifecycle','communities:import']::text[]`
    ),
    check(
      'host_api_keys_issuer',
      sql`(${table.issuedVia} = 'browser' AND ${table.issuedByUserId} IS NOT NULL) OR (${table.issuedVia} = 'command' AND ${table.issuedByUserId} IS NULL)`
    ),
    check(
      'host_api_keys_revoker',
      sql`${table.revokedByUserId} IS NULL OR ${table.revokedAt} IS NOT NULL`
    ),
  ]
);

/** Metadata-only audit log for actions performed with host authority. */
export const hostAuditEvents = pgTable(
  'host_audit_events',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    actorKind: text('actor_kind').notNull().default('person'),
    actorUserId: text('actor_user_id').references(() => users.id),
    actorApiKeyId: uuid('actor_api_key_id').references(() => hostApiKeys.id),
    subjectApiKeyId: uuid('subject_api_key_id').references(() => hostApiKeys.id),
    communityId: uuid('community_id'),
    action: text('action').notNull(),
    priorState: text('prior_state'),
    nextState: text('next_state'),
    changedFields: text('changed_fields').array().notNull().default([]),
    createdAt: time('created_at'),
  },
  (table) => [
    index('host_audit_events_community_created_idx').on(
      table.communityId,
      table.createdAt,
      table.id
    ),
    check('host_audit_events_action', sql`${table.action} ~ '^[a-z][a-z0-9_.]{0,79}$'`),
    check('host_audit_events_changed_fields', sql`cardinality(${table.changedFields}) <= 16`),
    check(
      'host_audit_events_actor_kind',
      sql`${table.actorKind} IN ('person','api_key','offline')`
    ),
    check(
      'host_audit_events_actor',
      sql`(${table.actorKind} = 'person') = (${table.actorUserId} IS NOT NULL) AND (${table.actorKind} = 'api_key') = (${table.actorApiKeyId} IS NOT NULL)`
    ),
  ]
);

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
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
    revokedBy: text('revoked_by').references(() => users.id),
    revokedByApiKeyId: uuid('revoked_by_api_key_id').references(() => hostApiKeys.id),
    createdAt: time('created_at'),
  },
  (table) => [
    check(
      'bootstrap_grants_purpose_tenant',
      sql`(${table.purpose} = 'first_install' AND ${table.communityId} IS NULL) OR (${table.purpose} = 'owner_claim' AND ${table.communityId} IS NOT NULL)`
    ),
    index('bootstrap_grants_community_idx').on(table.communityId),
    check(
      'bootstrap_grants_revocation',
      sql`(${table.revokedAt} IS NULL AND ${table.revokedBy} IS NULL AND ${table.revokedByApiKeyId} IS NULL) OR (${table.revokedAt} IS NOT NULL AND num_nonnulls(${table.revokedBy}, ${table.revokedByApiKeyId}) = 1)`
    ),
  ]
);

/** Non-secret idempotency receipt for host-created pending communities. */
export const communityCreationReceipts = pgTable(
  'community_creation_receipts',
  {
    idempotencyKey: text('idempotency_key').primaryKey(),
    operatorUserId: text('operator_user_id').references(() => hostOperators.userId),
    operatorApiKeyId: uuid('operator_api_key_id').references(() => hostApiKeys.id),
    payloadHash: text('payload_hash').notNull(),
    communityId: uuid('community_id')
      .notNull()
      .unique()
      .references(() => communities.id),
    ownerClaimGrantId: uuid('owner_claim_grant_id')
      .notNull()
      .unique()
      .references(() => bootstrapGrants.id),
    createdAt: time('created_at'),
  },
  (table) => [
    check(
      'community_creation_receipts_idempotency_key_check',
      sql`char_length(${table.idempotencyKey}) BETWEEN 1 AND 200`
    ),
    check(
      'community_creation_receipts_payload_hash_check',
      sql`${table.payloadHash} ~ '^[a-f0-9]{64}$'`
    ),
    check(
      'community_creation_receipts_operator',
      sql`num_nonnulls(${table.operatorUserId}, ${table.operatorApiKeyId}) = 1`
    ),
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
    index('pending_admissions_expires_at_idx').on(table.expiresAt, table.id),
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
    historyOnly: boolean('history_only').notNull().default(false),
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
    index('entries_community_created_idx').on(table.communityId, table.createdAt.desc()),
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
    // The SQL index also INCLUDEs byte_size so the usage sum is an index-only scan.
    index('managed_blobs_community_usage_idx').on(table.communityId, table.state, table.purpose),
    check(
      'managed_blobs_purpose',
      sql`${table.purpose} IN ('attachment','export','icon','legacy_cleanup')`
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

/** Durable bounded cleanup state for one tenant deletion request. */
export const communityDeletionJobs = pgTable(
  'community_deletion_jobs',
  {
    communityId: uuid('community_id')
      .primaryKey()
      .references(() => communities.id, { onDelete: 'cascade' }),
    requestedByMemberId: uuid('requested_by_member_id').notNull(),
    lifecycleVersion: integer('lifecycle_version').notNull(),
    state: text('state').notNull().default('waiting'),
    deleteAfter: timestamp('delete_after', { withTimezone: true }).notNull(),
    attempts: integer('attempts').notNull().default(0),
    nextAttemptAt: timestamp('next_attempt_at', { withTimezone: true }).notNull(),
    lastErrorClass: text('last_error_class'),
    createdAt: time('created_at'),
    updatedAt: time('updated_at'),
  },
  (table) => [
    foreignKey({
      name: 'community_deletion_jobs_requester_tenant_fk',
      columns: [table.communityId, table.requestedByMemberId],
      foreignColumns: [members.communityId, members.id],
    }),
    index('community_deletion_jobs_due_idx').on(table.nextAttemptAt, table.communityId),
    check('community_deletion_jobs_lifecycle_version', sql`${table.lifecycleVersion} > 0`),
    check('community_deletion_jobs_attempts_check', sql`${table.attempts} >= 0`),
    check(
      'community_deletion_jobs_state_check',
      sql`${table.state} IN ('waiting','deleting','retrying')`
    ),
    check(
      'community_deletion_jobs_last_error_class_check',
      sql`${table.lastErrorClass} IS NULL OR ${table.lastErrorClass} ~ '^[A-Z][A-Z0-9_]{0,63}$'`
    ),
  ]
);

/** Per-object retry state retained until the tenant database transaction completes. */
export const communityDeletionBlobProgress = pgTable(
  'community_deletion_blob_progress',
  {
    communityId: uuid('community_id')
      .notNull()
      .references(() => communities.id, { onDelete: 'cascade' }),
    blobKey: text('blob_key').notNull(),
    state: text('state').notNull().default('pending'),
    attempts: integer('attempts').notNull().default(0),
    nextAttemptAt: timestamp('next_attempt_at', { withTimezone: true }).notNull().defaultNow(),
    lastErrorClass: text('last_error_class'),
    deletedAt: timestamp('deleted_at', { withTimezone: true }),
  },
  (table) => [
    primaryKey({ columns: [table.communityId, table.blobKey] }),
    index('community_deletion_blob_progress_due_idx').on(
      table.communityId,
      table.nextAttemptAt,
      table.blobKey
    ),
    check('community_deletion_blob_progress_key_check', sql`${table.blobKey} ~ '^[a-f0-9]{64}$'`),
    check('community_deletion_blob_progress_attempts_check', sql`${table.attempts} >= 0`),
    check(
      'community_deletion_blob_progress_state_check',
      sql`${table.state} IN ('pending','deleted','retrying')`
    ),
    check(
      'community_deletion_blob_progress_error_check',
      sql`${table.lastErrorClass} IS NULL OR ${table.lastErrorClass} ~ '^[A-Z][A-Z0-9_]{0,63}$'`
    ),
    check(
      'community_deletion_blob_progress_deleted_check',
      sql`(${table.state} = 'deleted') = (${table.deletedAt} IS NOT NULL)`
    ),
  ]
);

/** Content-free, expiring proof that a tenant deletion completed. */
export const communityDeletionTombstones = pgTable(
  'community_deletion_tombstones',
  {
    communityId: uuid('community_id').primaryKey(),
    requestedAt: timestamp('requested_at', { withTimezone: true }).notNull(),
    completedAt: timestamp('completed_at', { withTimezone: true }).notNull(),
    outcome: text('outcome').notNull(),
    retryCount: integer('retry_count').notNull(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  },
  (table) => [
    index('community_deletion_tombstones_expiry_idx').on(table.expiresAt, table.communityId),
    check('community_deletion_tombstones_outcome_check', sql`${table.outcome} = 'deleted'`),
    check('community_deletion_tombstones_retry_count_check', sql`${table.retryCount} >= 0`),
    check(
      'community_deletion_tombstones_times_check',
      sql`${table.completedAt} >= ${table.requestedAt} AND ${table.expiresAt} = ${table.completedAt} + interval '30 days'`
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
    actorKind: text('actor_kind').notNull().default('member'),
    priorState: text('prior_state'),
    nextState: text('next_state'),
    changedFields: text('changed_fields').array().notNull().default([]),
    createdAt: time('created_at'),
  },
  (table) => [
    index('audit_events_community_created_idx').on(table.communityId, table.createdAt),
    foreignKey({
      name: 'audit_events_actor_tenant_fk',
      columns: [table.communityId, table.actorMemberId],
      foreignColumns: [members.communityId, members.id],
    }),
    check('audit_events_actor_kind', sql`${table.actorKind} IN ('member','system')`),
    check('audit_events_changed_fields', sql`cardinality(${table.changedFields}) <= 16`),
  ]
);

/** Host-set caps for one community. A community without a row has no limit. */
export const communityLimits = pgTable(
  'community_limits',
  {
    communityId: uuid('community_id')
      .primaryKey()
      .references(() => communities.id),
    maxActiveMembers: integer('max_active_members'),
    maxStorageBytes: bigint('max_storage_bytes', { mode: 'number' }),
    limitsVersion: integer('limits_version').notNull().default(1),
    updatedAt: time('updated_at'),
  },
  (table) => [
    check(
      'community_limits_max_active_members_check',
      sql`${table.maxActiveMembers} BETWEEN 1 AND 1000000`
    ),
    check('community_limits_max_storage_bytes_check', sql`${table.maxStorageBytes} >= 0`),
    check('community_limits_limits_version_check', sql`${table.limitsVersion} > 0`),
  ]
);

/** Host-set agents-per-person override for one member of one community. */
export const memberLimitOverrides = pgTable(
  'member_limit_overrides',
  {
    communityId: uuid('community_id').notNull(),
    memberId: uuid('member_id').notNull(),
    agentsPerMember: integer('agents_per_member').notNull(),
    updatedAt: time('updated_at'),
  },
  (table) => [
    primaryKey({ columns: [table.communityId, table.memberId] }),
    foreignKey({
      name: 'member_limit_overrides_member_tenant_fk',
      columns: [table.communityId, table.memberId],
      foreignColumns: [members.communityId, members.id],
    }),
    check(
      'member_limit_overrides_agents_per_member_check',
      sql`${table.agentsPerMember} BETWEEN 1 AND 1000`
    ),
  ]
);
