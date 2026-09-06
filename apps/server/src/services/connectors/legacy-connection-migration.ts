/** Transactional migration from provider-scoped legacy accounts to stable connections. */
import { createHash } from 'node:crypto';
import { ulid } from 'ulidx';
import type { Db } from '@dorkos/db';
import { logger } from '../../lib/logger.js';

/** First application-level connector migration. */
export const CONNECTOR_FOUNDATION_MIGRATION_VERSION = 1;

/** Configured provider instance known before the backfill transaction starts. */
export interface ConfiguredConnectorProvider {
  /** Stable instance id assigned by configuration/bootstrap. */
  instanceId: string;
  /** Provider implementation type. */
  type: string;
  /** Payer mode. */
  mode: 'managed' | 'byo';
  /** Operator-facing provider label. */
  displayName: string;
  /** Token custody disclosure category. */
  custody: 'managed' | 'self-host' | 'external';
  /** Serialized capability declaration, containing no secrets. */
  capabilityJson: string;
  /** Optional server-only credential reference. */
  credentialRef?: string;
  /** Whether the configured provider is currently usable. */
  status: 'available' | 'unavailable';
  /** Secret-free unavailable reason. */
  error?: string;
}

/** One operation set resolved before entering SQLite's transaction. */
export interface ResolvedLegacyOperationSet {
  /** Provider implementation type whose default instance owns the schema. */
  providerType: string;
  /** Toolkit whose complete operation set was resolved. */
  toolkit: string;
  /** Complete, bounded discovery result. False never creates grants. */
  complete: boolean;
  /** Reviewed immutable operation metadata. */
  operations: Array<{
    operationSlug: string;
    toolkitVersion: string;
    schemaHash: string;
    capabilityClassification: 'read' | 'write' | 'destructive';
    inputSchemaJson: string;
  }>;
}

/** Named transaction checkpoints used by rollback tests. */
export type ConnectorMigrationStep =
  'claimed' | 'providers' | 'connections' | 'attachments' | 'operations' | 'verified';

/** Inputs already resolved before the synchronous database boundary. */
export interface LegacyConnectionMigrationInput {
  /** Configured instances. Legacy-only types are added as unavailable defaults. */
  configuredProviders?: ConfiguredConnectorProvider[];
  /** Operation metadata resolved without holding a database transaction. */
  operationSets?: ResolvedLegacyOperationSet[];
  /** Injectable id factory for deterministic fixture assertions. */
  createId?: () => string;
  /** Injectable clock for deterministic fixture assertions. */
  now?: () => string;
  /** Test-only synchronous fault injection at a named transaction step. */
  afterStep?: (step: ConnectorMigrationStep) => void;
}

/** Health returned to the connector subsystem after attempting the backfill. */
export type ConnectorMigrationResult =
  { status: 'ready'; migrated: boolean } | { status: 'migration_failed'; error: string };

type ConnectorMigrationInvariant =
  | 'legacy_agent_account_missing'
  | 'legacy_session_account_missing'
  | 'connection_count_mismatch'
  | 'agent_attachment_count_mismatch'
  | 'session_override_count_mismatch'
  | 'foreign_key_check_failed';

class ConnectorMigrationInvariantError extends Error {
  constructor(
    readonly causeCode: ConnectorMigrationInvariant,
    message: string
  ) {
    super(message);
    this.name = 'ConnectorMigrationInvariantError';
  }
}

/** Stable opaque id for one provider type's legacy default instance. */
export function legacyDefaultProviderInstanceId(type: string): string {
  const digest = createHash('sha256').update(`dorkos:legacy-connector:${type}`).digest('hex');
  return `cpi_${digest.slice(0, 26)}`;
}

/** Default provider metadata for a legacy type absent from current configuration. */
function missingProvider(type: string, custody: string): ConfiguredConnectorProvider {
  const safeCustody =
    custody === 'managed' || custody === 'self-host' || custody === 'external'
      ? custody
      : 'external';
  return {
    instanceId: legacyDefaultProviderInstanceId(type),
    type,
    mode: 'byo',
    displayName: `${type} (configuration missing)`,
    custody: safeCustody,
    capabilityJson: '{}',
    status: 'unavailable',
    error: 'Provider configuration is missing. Reconfigure it to reconcile this connection.',
  };
}

/**
 * Atomically copy every legacy identity and attachment into the stable model.
 *
 * The function accepts only plain, already-resolved metadata. It has no async
 * callback and cannot perform provider I/O while SQLite holds the transaction.
 * A failed attempt rolls back the ledger claim and every new row, returns a
 * typed health result, and leaves every legacy row untouched for a later retry.
 */
export function runLegacyConnectionMigration(
  db: Db,
  input: LegacyConnectionMigrationInput = {}
): ConnectorMigrationResult {
  const createId = input.createId ?? ulid;
  const now = input.now ?? (() => new Date().toISOString());
  let phase: 'ledger' | ConnectorMigrationStep = 'ledger';

  try {
    let migrated = false;
    db.$client.transaction(() => {
      // Read and claim under the same writer transaction. A second process that
      // waited for the first migrator observes `complete` here instead of
      // racing an out-of-transaction read into a false unique-key failure.
      const existing = db.$client
        .prepare('SELECT state FROM connector_application_migrations WHERE version = ?')
        .get(CONNECTOR_FOUNDATION_MIGRATION_VERSION) as { state: string } | undefined;
      if (existing?.state === 'complete') return;

      const startedAt = now();
      phase = 'claimed';
      db.$client
        .prepare(
          'INSERT INTO connector_application_migrations(version, state, started_at, completed_at) VALUES (?, ?, ?, NULL)'
        )
        .run(CONNECTOR_FOUNDATION_MIGRATION_VERSION, 'claimed', startedAt);
      input.afterStep?.('claimed');

      phase = 'providers';
      const legacyAccounts = db.$client
        .prepare(
          'SELECT account_id, provider, toolkit, label, custody, status, created_at FROM connected_accounts ORDER BY account_id'
        )
        .all() as Array<{
        account_id: string;
        provider: string;
        toolkit: string;
        label: string;
        custody: string;
        status: string;
        created_at: string;
      }>;

      const providersById = new Map<string, ConfiguredConnectorProvider>();
      const defaultProviderByType = new Map<string, ConfiguredConnectorProvider>();
      for (const provider of input.configuredProviders ?? []) {
        providersById.set(provider.instanceId, provider);
        if (!defaultProviderByType.has(provider.type)) {
          defaultProviderByType.set(provider.type, provider);
        }
      }
      for (const account of legacyAccounts) {
        if (!defaultProviderByType.has(account.provider)) {
          const provider = missingProvider(account.provider, account.custody);
          providersById.set(provider.instanceId, provider);
          defaultProviderByType.set(provider.type, provider);
        }
      }
      const providerInsert = db.$client.prepare(
        `INSERT INTO connector_provider_instances
         (id, type, mode, display_name, custody, capability_json, credential_ref, status, error, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      );
      for (const provider of providersById.values()) {
        providerInsert.run(
          provider.instanceId,
          provider.type,
          provider.mode,
          provider.displayName,
          provider.custody,
          provider.capabilityJson,
          provider.credentialRef ?? null,
          provider.status,
          provider.error ?? null,
          startedAt,
          startedAt
        );
      }
      input.afterStep?.('providers');

      phase = 'connections';
      const operationSets = new Map(
        (input.operationSets ?? []).map((set) => [`${set.providerType}\0${set.toolkit}`, set])
      );
      const accountToConnection = new Map<string, string>();
      const connectionInsert = db.$client.prepare(
        `INSERT INTO connections
         (id, provider_instance_id, external_account_ref, toolkit, label, identity_hint, status,
          lifecycle_state, enabled, auth_config_ref, grant_reconciliation_status, created_at,
          updated_at, last_verified_at)
         VALUES (?, ?, ?, ?, ?, NULL, ?, ?, 1, NULL, ?, ?, ?, NULL)`
      );
      for (const account of legacyAccounts) {
        const connectionId = createId();
        accountToConnection.set(account.account_id, connectionId);
        const operationSet = operationSets.get(`${account.provider}\0${account.toolkit}`);
        connectionInsert.run(
          connectionId,
          defaultProviderByType.get(account.provider)!.instanceId,
          account.account_id,
          account.toolkit,
          account.label,
          account.status,
          account.status === 'revoked' ? 'disconnected' : 'connected',
          operationSet?.complete ? 'ready' : 'migration_needs_reconcile',
          account.created_at,
          startedAt
        );
      }
      input.afterStep?.('connections');

      phase = 'attachments';
      const legacyAgentAttachments = db.$client
        .prepare(
          'SELECT agent_id, account_id, attached_at FROM agent_connector_attachments ORDER BY agent_id, account_id'
        )
        .all() as Array<{ agent_id: string; account_id: string; attached_at: string }>;
      const registeredAgentIds = new Set(
        (
          db.$client.prepare('SELECT id FROM agents ORDER BY id').all() as Array<{ id: string }>
        ).map((row) => row.id)
      );
      const legacyRevokedAgentIds = new Set(
        (
          db.$client
            .prepare('SELECT agent_id FROM connector_legacy_agent_revocations ORDER BY agent_id')
            .all() as Array<{ agent_id: string }>
        ).map((row) => row.agent_id)
      );
      const migratableAgentAttachments = legacyAgentAttachments.filter(
        (row) => registeredAgentIds.has(row.agent_id) && !legacyRevokedAgentIds.has(row.agent_id)
      );
      const agentInsert = db.$client.prepare(
        'INSERT INTO agent_connection_attachments(agent_id, connection_id, attached_at) VALUES (?, ?, ?)'
      );
      for (const row of migratableAgentAttachments) {
        const connectionId = accountToConnection.get(row.account_id);
        if (!connectionId)
          throw new ConnectorMigrationInvariantError(
            'legacy_agent_account_missing',
            `Legacy agent attachment references missing account '${row.account_id}'.`
          );
        agentInsert.run(row.agent_id, connectionId, row.attached_at);
      }

      const legacySessionOverrides = db.$client
        .prepare(
          'SELECT session_id, account_id, state, updated_at FROM session_connector_attachments ORDER BY session_id, account_id'
        )
        .all() as Array<{
        session_id: string;
        account_id: string;
        state: string;
        updated_at: string;
      }>;
      const resolveAgent = db.$client.prepare(
        `SELECT COUNT(DISTINCT a.id) AS owner_count, MIN(a.id) AS id
         FROM session_metadata sm
         JOIN agents a ON a.project_path = sm.agent_path
         LEFT JOIN connector_legacy_agent_revocations r ON r.agent_id = a.id
         WHERE sm.session_id = ? AND sm.agent_path IS NOT NULL AND r.agent_id IS NULL`
      );
      const sessionInsert = db.$client.prepare(
        `INSERT INTO session_connection_overrides
         (session_id, agent_id, connection_id, state, needs_reconciliation, updated_at)
         VALUES (?, ?, ?, ?, ?, ?)`
      );
      for (const row of legacySessionOverrides) {
        const connectionId = accountToConnection.get(row.account_id);
        if (!connectionId)
          throw new ConnectorMigrationInvariantError(
            'legacy_session_account_missing',
            `Legacy session override references missing account '${row.account_id}'.`
          );
        const candidate = resolveAgent.get(row.session_id) as {
          owner_count: number;
          id: string | null;
        };
        const owner = candidate.owner_count === 1 ? candidate.id : null;
        sessionInsert.run(
          row.session_id,
          owner,
          connectionId,
          row.state,
          owner === null ? 1 : 0,
          row.updated_at
        );
      }
      input.afterStep?.('attachments');

      phase = 'operations';
      const revisionByFingerprint = new Map<string, string>();
      const revisionInsert = db.$client.prepare(
        `INSERT INTO connector_operation_revisions
         (id, provider_instance_id, toolkit, operation_slug, toolkit_version, schema_hash,
          capability_classification, input_schema_json, discovered_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
      );
      for (const set of input.operationSets ?? []) {
        if (!set.complete) continue;
        const provider = defaultProviderByType.get(set.providerType);
        if (!provider) continue;
        for (const operation of set.operations) {
          const fingerprint = [
            provider.instanceId,
            set.toolkit,
            operation.operationSlug,
            operation.toolkitVersion,
            operation.schemaHash,
            operation.capabilityClassification,
          ].join('\0');
          if (revisionByFingerprint.has(fingerprint)) continue;
          const revisionId = createId();
          revisionInsert.run(
            revisionId,
            provider.instanceId,
            set.toolkit,
            operation.operationSlug,
            operation.toolkitVersion,
            operation.schemaHash,
            operation.capabilityClassification,
            operation.inputSchemaJson,
            startedAt
          );
          revisionByFingerprint.set(fingerprint, revisionId);
        }
      }

      const grantInsert = db.$client.prepare(
        `INSERT INTO connection_operation_grants
         (id, subject_type, subject_id, agent_id, connection_id, operation_revision_id, created_by, created_at, revoked_at)
         VALUES (?, ?, ?, ?, ?, ?, 'migration', ?, NULL)`
      );
      const revisionsFor = (providerType: string, toolkit: string): string[] => {
        const set = operationSets.get(`${providerType}\0${toolkit}`);
        const provider = defaultProviderByType.get(providerType);
        if (!set?.complete || !provider) return [];
        return [
          ...new Set(
            set.operations.map((operation) =>
              revisionByFingerprint.get(
                [
                  provider.instanceId,
                  toolkit,
                  operation.operationSlug,
                  operation.toolkitVersion,
                  operation.schemaHash,
                  operation.capabilityClassification,
                ].join('\0')
              )
            )
          ),
        ].filter((revisionId): revisionId is string => revisionId !== undefined);
      };
      const legacyByAccount = new Map(legacyAccounts.map((row) => [row.account_id, row]));
      for (const row of migratableAgentAttachments) {
        const account = legacyByAccount.get(row.account_id)!;
        for (const revisionId of revisionsFor(account.provider, account.toolkit)) {
          grantInsert.run(
            createId(),
            'agent',
            row.agent_id,
            row.agent_id,
            accountToConnection.get(row.account_id),
            revisionId,
            startedAt
          );
        }
      }
      for (const row of legacySessionOverrides) {
        if (row.state !== 'attached') continue;
        const account = legacyByAccount.get(row.account_id)!;
        const candidate = resolveAgent.get(row.session_id) as {
          owner_count: number;
          id: string | null;
        };
        const owner = candidate.owner_count === 1 ? candidate.id : null;
        if (owner === null) continue;
        for (const revisionId of revisionsFor(account.provider, account.toolkit)) {
          grantInsert.run(
            createId(),
            'session',
            row.session_id,
            owner,
            accountToConnection.get(row.account_id),
            revisionId,
            startedAt
          );
        }
      }
      input.afterStep?.('operations');

      phase = 'verified';
      const count = (table: string): number =>
        (db.$client.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get() as { count: number })
          .count;
      if (count('connections') !== legacyAccounts.length)
        throw new ConnectorMigrationInvariantError(
          'connection_count_mismatch',
          'Connection backfill count mismatch.'
        );
      if (count('agent_connection_attachments') !== migratableAgentAttachments.length) {
        throw new ConnectorMigrationInvariantError(
          'agent_attachment_count_mismatch',
          'Agent attachment backfill count mismatch.'
        );
      }
      if (count('session_connection_overrides') !== legacySessionOverrides.length) {
        throw new ConnectorMigrationInvariantError(
          'session_override_count_mismatch',
          'Session override backfill count mismatch.'
        );
      }
      const foreignKeyErrors = db.$client.prepare('PRAGMA foreign_key_check').all();
      if (foreignKeyErrors.length > 0)
        throw new ConnectorMigrationInvariantError(
          'foreign_key_check_failed',
          'Connector backfill created invalid references.'
        );
      input.afterStep?.('verified');

      db.$client
        .prepare(
          'UPDATE connector_application_migrations SET state = ?, completed_at = ? WHERE version = ?'
        )
        .run('complete', now(), CONNECTOR_FOUNDATION_MIGRATION_VERSION);
      migrated = true;
    })();
    return { status: 'ready', migrated };
  } catch (error) {
    const driverCode =
      error instanceof ConnectorMigrationInvariantError
        ? undefined
        : typeof error === 'object' &&
            error !== null &&
            'code' in error &&
            typeof error.code === 'string' &&
            /^SQLITE_[A-Z0-9_]{1,64}$/.test(error.code)
          ? error.code
          : undefined;
    const causeCode =
      error instanceof ConnectorMigrationInvariantError
        ? error.causeCode
        : (driverCode ?? 'unknown');
    logger.error('[connectors] legacy connection migration failed', {
      migrationVersion: CONNECTOR_FOUNDATION_MIGRATION_VERSION,
      phase,
      category:
        error instanceof ConnectorMigrationInvariantError
          ? 'invariant'
          : driverCode?.startsWith('SQLITE_CONSTRAINT')
            ? 'constraint'
            : driverCode
              ? 'database'
              : 'unexpected',
      causeCode,
    });
    // The result crosses connector REST boundaries. Never return SQLite text,
    // paths, or a private external account reference from the caught error.
    return {
      status: 'migration_failed',
      error:
        'Connector data could not be upgraded. Connector changes are unavailable; restart DorkOS to retry.',
    };
  }
}
