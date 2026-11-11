/**
 * `ctx.connections.read`, on the host side (DOR-3547): one declared, granted
 * read operation for one running extension, made by DorkOS so the extension
 * never holds a token.
 *
 * Every call, and again right before the request leaves (`authorizeDispatch`),
 * checks from scratch:
 *
 * 1. the copy runs isolated and its self-check said sqlite can't load (S2);
 * 2. its origin may hold grants at all (Q7);
 * 3. the operation is declared, and its service has a live approval for this
 *    exact install (scope, real path, origin; N2) whose approved files digest
 *    equals the live one (N1, P4-1);
 * 4. the account is connected, enabled, signed in, ready, and not one reached
 *    through a DorkOS account (Cloud doesn't take an extension subject yet);
 * 5. a live `extension` grant names the operation's current revision, and that
 *    revision is `read` (M5, P4-2, P4-3);
 * 6. the arguments match the revision's input schema.
 *
 * Each call is recorded under the extension (`actor_kind = 'extension'`,
 * `agent_id` null, with an arguments hash; S6, P4-5), and an answer over
 * 8 MB is refused, never truncated (Q5).
 *
 * **A change while the app answers** (Security C2): the checks run once more
 * when the answer comes back. If access changed meanwhile (a revoke, a
 * stopped child, other files) or the extension was stopped, the answer is
 * kept from the extension. The request itself already reached the app, which
 * is safe because it only reads. A stop also aborts the request in flight.
 *
 * @module services/connectors/extensions/extension-connection-reader
 */
import { createHash } from 'node:crypto';
import { ulid } from 'ulidx';
import {
  and,
  connectionOperationGrants,
  connections,
  connectorOperationRevisions,
  connectorProviderInstances,
  desc,
  eq,
  isNull,
  type Db,
} from '@dorkos/db';
import {
  EXTENSION_CONNECTION_RESULT_MAX_BYTES,
  ExtensionConnectionError,
  type ExtensionConnectionReadResult,
  type ExtensionConnectionStatus,
} from '@dorkos/extension-api/server';
import { stableStringify } from '@dorkos/shared/capabilities';
import { checkConnectorArguments, withoutOptionalNulls } from '@dorkos/shared/connector-arguments';
import {
  ConnectorOperationRevisionSchema,
  type ConnectorOperationRevision,
  type ConnectorProviderExecuteResult,
} from '@dorkos/shared/connector-schemas';
import type {
  ConnectorExternalAccountRef,
  ConnectorProvider,
} from '@dorkos/shared/connector-provider';
import type { ConnectorRegistry } from '../registry.js';
import type { ConnectorUsageStore } from '../execution/usage-store.js';
import type { ConnectorOwnerAuthority } from '../principal/server-principal.js';
import type { ExtensionConnectionApprovalStore } from './extension-connection-approvals.js';
import type { LiveExtensionInstall } from './live-extension-install.js';

/** Everything checked for one call, bound by `digest` so a change before dispatch is caught. */
interface AuthorizedRead {
  readonly digest: string;
  readonly owner: ConnectorOwnerAuthority;
  readonly connectionId: string;
  readonly externalAccountRef: ConnectorExternalAccountRef;
  readonly provider: ConnectorProvider;
  readonly operation: ConnectorOperationRevision;
  readonly arguments: Record<string, unknown>;
  readonly payer: 'operator_byo';
}

/** Refuse with a typed extension connection error. */
function refuse(code: ExtensionConnectionError['code'], message: string): never {
  throw new ExtensionConnectionError(code, message);
}

/** Whether a value is plain JSON: no classes, functions or non-finite numbers. */
function isPlainJson(value: unknown): boolean {
  if (value === null || ['string', 'boolean'].includes(typeof value)) return true;
  if (typeof value === 'number') return Number.isFinite(value);
  if (Array.isArray(value)) return value.every(isPlainJson);
  if (typeof value !== 'object') return false;
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return false;
  return Object.values(value as Record<string, unknown>).every(isPlainJson);
}

/** A SHA-256 over a stable encoding. */
function sha256(value: unknown): string {
  return createHash('sha256').update(stableStringify(value)).digest('hex');
}

const NOT_GRANTED =
  'A person hasn’t let this extension read that app yet, or took it back. They can allow it in the DorkOS app.';

/** The host-side reader behind `ctx.connections`. */
export class ExtensionConnectionReader {
  /**
   * Construct the reader.
   *
   * @param db - Canonical DorkOS database.
   * @param registry - Live connector providers.
   * @param approvals - The approval store.
   * @param usage - The append-only usage ledger.
   * @param now - Clock, for tests.
   */
  constructor(
    private readonly db: Db,
    private readonly registry: ConnectorRegistry,
    private readonly approvals: ExtensionConnectionApprovalStore,
    private readonly usage: ConnectorUsageStore,
    private readonly now: () => Date = () => new Date()
  ) {}

  /**
   * Run one declared, granted read operation for this install.
   *
   * @param install - The running copy, as its host built it.
   * @param operation - The operation slug the extension asked for.
   * @param params - Its arguments.
   * @param signal - Cancels the call.
   */
  async read(
    install: LiveExtensionInstall,
    operation: unknown,
    params: unknown,
    signal: AbortSignal = new AbortController().signal
  ): Promise<ExtensionConnectionReadResult> {
    const authorized = this.authorize(install, operation, params);
    const logicalOperationId = ulid();
    const attemptId = ulid();
    this.usage.recordIntent({
      attemptId,
      logicalOperationId,
      attemptIndex: 1,
      surface: 'extension',
      actorKind: 'extension',
      actorId: install.extensionId,
      owner: authorized.owner,
      connectionId: authorized.connectionId,
      providerInstanceId: authorized.operation.providerInstanceId,
      providerType: authorized.provider.type,
      payer: authorized.payer,
      operationRevisionId: authorized.operation.id,
      startedAt: this.now().toISOString(),
      argumentsHash: `sha256:${sha256(authorized.arguments)}`,
    });
    let result: ConnectorProviderExecuteResult;
    if (signal.aborted) {
      result = {
        status: 'cancelled',
        code: 'CANCELLED_BEFORE_DISPATCH',
        message: 'The read was cancelled before it was sent.',
      };
    } else {
      try {
        result = await authorized.provider.execute({
          externalAccountRef: authorized.externalAccountRef,
          operation: authorized.operation,
          arguments: authorized.arguments,
          logicalOperationId,
          attemptId,
          signal,
          authorizeDispatch: () => this.stillAuthorized(install, operation, params, authorized),
        });
      } catch {
        result = {
          status: 'outcome_unknown',
          code: 'PROVIDER_TRANSPORT_OUTCOME_UNKNOWN',
          message: 'The app did not answer.',
        };
      }
    }
    // Access may have changed while the app answered: keep the data then (C2).
    const changed =
      result.status === 'success' &&
      (signal.aborted || !this.stillAuthorized(install, operation, params, authorized));
    const tooLarge =
      !changed &&
      result.status === 'success' &&
      Buffer.byteLength(JSON.stringify(result.data ?? null) ?? 'null') >
        EXTENSION_CONNECTION_RESULT_MAX_BYTES;
    const recordedAt = this.now().toISOString();
    this.usage.appendTerminal({
      attemptId,
      logicalOperationId,
      owner: authorized.owner,
      providerInstanceId: authorized.operation.providerInstanceId,
      operationRevisionId: authorized.operation.id,
      outcome: tooLarge || changed ? 'error' : result.status,
      ...('providerLogId' in result && result.providerLogId
        ? { providerLogId: result.providerLogId }
        : {}),
      ...(changed
        ? { errorCode: 'AUTHORITY_CHANGED_AFTER_DISPATCH' }
        : tooLarge
          ? { errorCode: 'EXTENSION_CONNECTION_RESULT_TOO_LARGE' }
          : 'code' in result
            ? { errorCode: result.code }
            : {}),
      completedAt: recordedAt,
      recordedAt,
      provenance: 'broker',
    });
    if (changed) return refuse('EXTENSION_CONNECTION_NOT_GRANTED', NOT_GRANTED);
    if (tooLarge) {
      return refuse(
        'EXTENSION_CONNECTION_RESULT_TOO_LARGE',
        'The app’s answer is bigger than DorkOS hands to an extension (8 MB). Ask for less.'
      );
    }
    if (result.status === 'success') return { status: 'success', data: result.data };
    if (result.status === 'unsupported') {
      return { status: 'unsupported', code: 'UNSUPPORTED', message: result.reason };
    }
    return { status: result.status, code: result.code, message: result.message };
  }

  /**
   * Each declared service, and whether this install may read it right now.
   *
   * @param install - The running copy.
   */
  status(install: LiveExtensionInstall): ExtensionConnectionStatus[] {
    return install.declarations.map(({ service }) => {
      const approval = this.allowed(install)
        ? this.approvals.liveApproval(install, service)
        : undefined;
      if (!approval || approval.approvedFilesDigest !== install.liveFilesDigest) {
        return { service, granted: false };
      }
      const account = this.db
        .select({ label: connections.label, lifecycleState: connections.lifecycleState })
        .from(connections)
        .where(eq(connections.id, approval.connectionId))
        .get();
      // A removed or disconnected account revoked its grants already.
      if (account?.lifecycleState !== 'connected') return { service, granted: false };
      return { service, granted: true, accountLabel: account.label };
    });
  }

  /** Whether the install may hold grants at all: isolated, sqlite off, a trusted origin. */
  private allowed(install: LiveExtensionInstall): boolean {
    return install.isolated() && install.origin !== null && install.liveFilesDigest !== undefined;
  }

  /** Re-run every check and compare with what was authorized (the provider's last safe boundary). */
  private stillAuthorized(
    install: LiveExtensionInstall,
    operation: unknown,
    params: unknown,
    authorized: AuthorizedRead
  ): boolean {
    try {
      return this.authorize(install, operation, params).digest === authorized.digest;
    } catch {
      return false;
    }
  }

  /** Every live check for one read; throws a typed refusal on the first that fails. */
  private authorize(
    install: LiveExtensionInstall,
    operation: unknown,
    params: unknown
  ): AuthorizedRead {
    this.registry.assertAvailable();
    if (!install.isolated()) {
      return refuse(
        'EXTENSION_CONNECTION_NOT_ALLOWED',
        'Only an extension running in its own sandbox can read apps.'
      );
    }
    if (install.origin === null || install.liveFilesDigest === undefined) {
      return refuse(
        'EXTENSION_CONNECTION_NOT_ALLOWED',
        "This copy of the extension can't read apps: DorkOS can't vouch that its code won't change without a person."
      );
    }
    if (typeof operation !== 'string' || operation.length === 0 || operation.length > 200) {
      return refuse(
        'EXTENSION_CONNECTION_NOT_DECLARED',
        'Name one operation the manifest declares.'
      );
    }
    const declaration = install.declarations.find((d) => d.operations.includes(operation));
    if (!declaration) {
      return refuse(
        'EXTENSION_CONNECTION_NOT_DECLARED',
        `${operation} isn't in this extension's manifest.`
      );
    }
    const approval = this.approvals.liveApproval(install, declaration.service);
    if (!approval) return refuse('EXTENSION_CONNECTION_NOT_GRANTED', NOT_GRANTED);
    if (approval.approvedFilesDigest !== install.liveFilesDigest) {
      return refuse(
        'EXTENSION_CONNECTION_NOT_GRANTED',
        'This extension’s code changed since a person let it read that app, so it waits for them to look again.'
      );
    }
    const row = this.db
      .select({
        connectionId: connections.id,
        toolkit: connections.toolkit,
        externalAccountRef: connections.externalAccountRef,
        status: connections.status,
        lifecycleState: connections.lifecycleState,
        enabled: connections.enabled,
        reconciliationStatus: connections.grantReconciliationStatus,
        providerInstanceId: connections.providerInstanceId,
        providerType: connectorProviderInstances.type,
        mode: connectorProviderInstances.mode,
        providerStatus: connectorProviderInstances.status,
        executionConfigDigest: connectorProviderInstances.executionConfigDigest,
        ownerKind: connectorProviderInstances.ownerKind,
        ownerId: connectorProviderInstances.ownerId,
      })
      .from(connections)
      .innerJoin(
        connectorProviderInstances,
        eq(connectorProviderInstances.id, connections.providerInstanceId)
      )
      .where(eq(connections.id, approval.connectionId))
      .get();
    if (
      !row ||
      row.toolkit !== declaration.service ||
      row.lifecycleState !== 'connected' ||
      !row.enabled ||
      row.status !== 'active' ||
      row.reconciliationStatus !== 'ready' ||
      row.providerStatus !== 'available' ||
      !row.executionConfigDigest ||
      !row.ownerKind ||
      !row.ownerId
    ) {
      return refuse(
        'EXTENSION_CONNECTION_UNAVAILABLE',
        'That account isn’t ready right now: it may be paused, signed out or removed.'
      );
    }
    if (row.mode === 'managed') {
      return refuse(
        'EXTENSION_CONNECTION_UNAVAILABLE',
        'Accounts connected through your DorkOS account can’t be read by mini apps yet.'
      );
    }
    const grant = this.db
      .select({
        id: connectorOperationRevisions.id,
        providerInstanceId: connectorOperationRevisions.providerInstanceId,
        toolkit: connectorOperationRevisions.toolkit,
        operationSlug: connectorOperationRevisions.operationSlug,
        toolkitVersion: connectorOperationRevisions.toolkitVersion,
        schemaHash: connectorOperationRevisions.schemaHash,
        classification: connectorOperationRevisions.capabilityClassification,
        retryPolicy: connectorOperationRevisions.retryPolicy,
        inputSchemaJson: connectorOperationRevisions.inputSchemaJson,
        discoveredAt: connectorOperationRevisions.discoveredAt,
      })
      .from(connectionOperationGrants)
      .innerJoin(
        connectorOperationRevisions,
        eq(connectorOperationRevisions.id, connectionOperationGrants.operationRevisionId)
      )
      .where(
        and(
          eq(connectionOperationGrants.subjectType, 'extension'),
          eq(connectionOperationGrants.extensionId, install.extensionId),
          eq(connectionOperationGrants.connectionId, row.connectionId),
          isNull(connectionOperationGrants.revokedAt),
          eq(connectorOperationRevisions.providerInstanceId, row.providerInstanceId),
          eq(connectorOperationRevisions.toolkit, declaration.service),
          eq(connectorOperationRevisions.operationSlug, operation)
        )
      )
      .orderBy(desc(connectorOperationRevisions.discoveredAt))
      .get();
    if (!grant) return refuse('EXTENSION_CONNECTION_NOT_GRANTED', NOT_GRANTED);
    if (grant.classification !== 'read') {
      return refuse(
        'EXTENSION_CONNECTION_NOT_READ',
        `${operation} can change something in the app, and an extension may only read.`
      );
    }
    const provider = this.registry.resolveProviderInstance(
      ConnectorOperationRevisionSchema.shape.providerInstanceId.parse(row.providerInstanceId)
    );
    if (
      !provider ||
      provider.type !== row.providerType ||
      provider.getCapabilities().capabilities.execution.status !== 'available'
    ) {
      return refuse(
        'EXTENSION_CONNECTION_UNAVAILABLE',
        'DorkOS can’t reach that app right now. Try again later.'
      );
    }
    const inputSchema: unknown = JSON.parse(grant.inputSchemaJson);
    const argumentsValue = this.checkArguments(inputSchema, params ?? {});
    const op = ConnectorOperationRevisionSchema.parse({
      id: grant.id,
      providerInstanceId: grant.providerInstanceId,
      toolkit: grant.toolkit,
      operationSlug: grant.operationSlug,
      toolkitVersion: grant.toolkitVersion,
      schemaHash: grant.schemaHash,
      capabilityClassification: grant.classification,
      retryPolicy: grant.retryPolicy,
      inputSchema,
      discoveredAt: grant.discoveredAt,
    });
    const owner: ConnectorOwnerAuthority =
      row.ownerKind === 'user'
        ? { kind: 'user', userId: row.ownerId }
        : { kind: 'local_install', installationId: row.ownerId };
    return {
      digest: sha256({
        extensionId: install.extensionId,
        approvalId: approval.id,
        filesDigest: install.liveFilesDigest,
        connectionId: row.connectionId,
        executionConfigDigest: row.executionConfigDigest,
        operationRevisionId: grant.id,
        arguments: argumentsValue,
      }),
      owner,
      connectionId: row.connectionId,
      externalAccountRef: row.externalAccountRef as ConnectorExternalAccountRef,
      provider,
      operation: op,
      arguments: Object.freeze({ ...argumentsValue }),
      payer: 'operator_byo',
    };
  }

  /** The arguments, once they are plain JSON and match the frozen input schema. */
  private checkArguments(inputSchema: unknown, params: unknown): Record<string, unknown> {
    if (
      typeof params !== 'object' ||
      params === null ||
      Array.isArray(params) ||
      !isPlainJson(params)
    ) {
      return refuse('EXTENSION_CONNECTION_INVALID_INPUT', 'Arguments must be a plain JSON object.');
    }
    if (inputSchema === null || typeof inputSchema !== 'object' || Array.isArray(inputSchema)) {
      return refuse(
        'EXTENSION_CONNECTION_INVALID_INPUT',
        "This operation's input can't be checked, so it can't run."
      );
    }
    const cleaned = withoutOptionalNulls(inputSchema, params as Record<string, unknown>);
    const check = checkConnectorArguments(inputSchema as Record<string, unknown>, cleaned);
    if (check.ok) return cleaned;
    return refuse(
      'EXTENSION_CONNECTION_INVALID_INPUT',
      'problem' in check && check.problem
        ? `The arguments don't match the operation's input: ${check.problem}.`
        : "The arguments don't match the operation's input."
    );
  }
}
