import { readPreparedIntentPage } from '../../readers/prepared-readers.js';
/** Complete original-policy accounting; a held reservation never acquires new authority. */
import { types as utilTypes } from 'node:util';
import {
  sql,
  type Db,
  canvasDocEvents,
  eq,
  approvals,
  canvasDocChannels,
  canvasDocGrants,
  canvasDocIdentityIntents,
  type DbTransaction,
} from '@dorkos/db';
import {
  CanvasChannelEventIdSchema,
  CanvasChannelGrantSchema,
  CanvasChannelRouteSchema,
  CanvasChannelCheckboxRequestSchema,
  matchesCanvasChannelEvent,
  type CanvasChannelRoute,
} from '@dorkos/shared/canvas-channel-schemas';
import { hashApprovalInput } from '../../../../core/approvals/approval-input-hash.js';
import { redactSecretsInText } from '../../../../core/approvals/approval-summary.js';
import type { DocWriteIntentRow } from '../../store.js';
import { readPreparedEvent } from '../../readers/prepared-readers.js';
import { readChecked } from '../../storage/store-json.js';
import { parseScope } from '../../../scopes.js';
import { freezeCheckboxData, validateCheckboxEvidence } from '../checkbox-evidence.js';
import {
  projectVerifiedCheckbox,
  type VerifiedCheckboxProjection,
} from '../checkbox-projection.js';
import {
  CheckboxReservationCensusError,
  scanCheckboxReservations,
  type CheckboxReservationRequest,
  type CheckboxReservationSummary,
} from './intent-reservations.js';

/** Bounded policy totals, separate from R1's conservative potential totals. */
export interface CheckboxPolicyUsage {
  rateUnits: number;
  originals: number;
  bytes: number;
}
/** Original immutable resource policy, not current permission to write or dispatch. */
export interface CheckboxReservationPolicy {
  route: CanvasChannelRoute;
  pending: boolean;
  envelopeBytes: number;
  eventsPerMinute: number;
  scope: string;
}
/** Complete detached summary; it conveys neither conversion credit nor a vacant slot. */
export interface CheckboxPolicySummary {
  raw: CheckboxReservationSummary;
  installation: CheckboxPolicyUsage;
  document: CheckboxPolicyUsage;
  route: CheckboxPolicyUsage;
  matching: {
    intent: DocWriteIntentRow;
    policy: CheckboxReservationPolicy;
    projection: VerifiedCheckboxProjection;
  } | null;
}

function unavailable(): never {
  throw new CheckboxReservationCensusError();
}
function add(a: number, b: number): number {
  const result = a + b;
  if (!Number.isSafeInteger(result) || result < 0) unavailable();
  return result;
}
function usage(): CheckboxPolicyUsage {
  return { rateUnits: 0, originals: 0, bytes: 0 };
}
function charge(
  value: CheckboxPolicyUsage,
  policy: CheckboxReservationPolicy,
  bytes: number
): void {
  value.rateUnits = add(value.rateUnits, 1);
  if (policy.pending) {
    value.originals = add(value.originals, 1);
    value.bytes = add(value.bytes, bytes);
  }
}

/** All documents share these aliases; bounded ambiguity is never truncated to success. */
export function resolveCheckboxSqlScope(tx: DbTransaction, original: string): string {
  if (
    typeof original !== 'string' ||
    !original ||
    original.length > 400 ||
    parseScope(original).kind === 'unknown'
  )
    unavailable();
  const seen = new Set<string>();
  let scope = original;
  for (let moves = 0; ; moves++) {
    if (seen.has(scope)) unavailable();
    seen.add(scope);
    const rows = readChecked('canvas_doc_identity_intents', scope, () =>
      tx
        .select()
        .from(canvasDocIdentityIntents)
        .where(eq(canvasDocIdentityIntents.fromScope, scope))
        .limit(1025)
        .all()
    );
    if (!rows.length) return scope;
    if (moves === 1024 || rows.length > 1024) unavailable();
    for (const row of rows) {
      for (const value of [row.intentId, row.documentId, row.sourceId, row.sourceGeneration])
        if (typeof value !== 'string' || !value || value.length > 200) unavailable();
      if (
        !Number.isFinite(Date.parse(row.createdAt)) ||
        !Number.isFinite(Date.parse(row.updatedAt))
      )
        unavailable();
    }
    const target = rows[0]!.toScope;
    if (
      !target ||
      target.length > 400 ||
      parseScope(target).kind === 'unknown' ||
      rows.some((row) => row.status !== 'applied' || row.toScope !== target)
    )
      unavailable();
    scope = target;
  }
}
function session(tx: DbTransaction, id: unknown): string | null {
  if (id === null) return null;
  if (typeof id !== 'string' || !id || id.length > 200) unavailable();
  return resolveCheckboxSqlScope(tx, `session:${id}`);
}
function record(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) unavailable();
  return value as Record<string, unknown>;
}
function same(a: unknown, b: unknown): boolean {
  return hashApprovalInput(a) === hashApprovalInput(b);
}

/** Prove recorded policy against the actual original consumed approval; expiry is not release. */
export function readCheckboxReservationPolicy(
  tx: DbTransaction,
  row: DocWriteIntentRow
): CheckboxReservationPolicy {
  const evidence = validateCheckboxEvidence(row);
  if (evidence.v !== 2 || evidence.preEffectRefusal || !evidence.authority.routeId) unavailable();
  const grant = readChecked('canvas_doc_grants', row.grantId, () =>
    tx.select().from(canvasDocGrants).where(eq(canvasDocGrants.grantId, row.grantId)).get()
  );
  const channel = readChecked('canvas_doc_channels', row.documentId, () =>
    tx
      .select()
      .from(canvasDocChannels)
      .where(eq(canvasDocChannels.documentId, row.documentId))
      .get()
  );
  if (
    !grant ||
    !channel ||
    grant.documentId !== row.documentId ||
    grant.revision !== evidence.authority.grantRevision ||
    grant.routeId !== evidence.authority.routeId ||
    grant.routeHash !== evidence.authority.routeHash
  )
    unavailable();
  const route = CanvasChannelRouteSchema.parse(grant.normalizedRoute);
  const { normalizedRoute: _route, approvalEvidence: _evidence, writeOperation, ...fields } = grant;
  const parsed = CanvasChannelGrantSchema.parse({ ...fields, route, write: writeOperation });
  const original = record(grant.approvalEvidence);
  const binding = record(original.binding);
  const target = record(binding.target);
  const scope = resolveCheckboxSqlScope(tx, channel.scope);
  if (
    original.kind !== 'operator_approval' ||
    original.inputHash !== hashApprovalInput(binding) ||
    grant.approvalId !== original.approvalId ||
    binding.documentId !== row.documentId ||
    typeof binding.scope !== 'string' ||
    resolveCheckboxSqlScope(tx, binding.scope) !== scope ||
    typeof target.scope !== 'string' ||
    resolveCheckboxSqlScope(tx, target.scope) !== scope ||
    hashApprovalInput(route) !== grant.routeHash ||
    hashApprovalInput(binding.route) !== grant.routeHash ||
    route.id !== grant.routeId ||
    binding.declarationHash !== grant.declarationHash ||
    binding.manifestHash !== grant.manifestHash ||
    binding.openerAgentId !== grant.openerAgentId ||
    target.agentId !== grant.targetAgentId ||
    target.runtime !== grant.targetRuntime ||
    session(tx, target.sessionId) !== session(tx, grant.targetSessionId) ||
    !same(binding.allowedTypes, grant.allowedTypes) ||
    !same(binding.limits, grant.limits) ||
    binding.expiresAt !== grant.expiresAt ||
    !same(binding.write, grant.writeOperation) ||
    !same(grant.writeOperation, evidence.authority.binding) ||
    !parsed.allowedTypes.some((pattern) => matchesCanvasChannelEvent(pattern, 'md.task.toggled')) ||
    !matchesCanvasChannelEvent(route.on, 'md.task.toggled')
  )
    unavailable();
  const approval = grant.approvalId
    ? tx.select().from(approvals).where(eq(approvals.id, grant.approvalId)).get()
    : undefined;
  if (
    !approval ||
    approval.capabilityId !== 'ui.approve_doc_route' ||
    approval.state !== 'granted' ||
    approval.inputHash !== original.inputHash ||
    grant.approvedBy !== `approval:${approval.id}` ||
    original.state !== approval.state ||
    !approval.decidedAt ||
    !approval.consumedAt ||
    original.decidedAt !== approval.decidedAt ||
    original.consumedAt !== approval.consumedAt ||
    approval.detail !== redactSecretsInText(JSON.stringify(binding))
  )
    unavailable();
  return freezeCheckboxData({
    route,
    pending: route.to !== 'log' && route.turn.mode !== 'none',
    envelopeBytes: parsed.limits.envelopeBytes,
    eventsPerMinute: parsed.limits.eventsPerMinute,
    scope,
  });
}

/** Finish both bounded complete scans before any admission, UUID or slot decision. */
export function scanCheckboxReservationPolicies(
  tx: DbTransaction,
  requested: CheckboxReservationRequest
): CheckboxPolicySummary {
  try {
    if (utilTypes.isProxy(requested) || Object.getPrototypeOf(requested) !== Object.prototype)
      unavailable();
    const own: CheckboxReservationRequest = { documentId: '' };
    for (const key of Reflect.ownKeys(requested)) {
      if (typeof key !== 'string' || !['documentId', 'eventId', 'routeId'].includes(key))
        unavailable();
      const field = Object.getOwnPropertyDescriptor(requested, key);
      if (!field || !('value' in field)) unavailable();
      Object.defineProperty(own, key, {
        value: field.value,
        enumerable: true,
        configurable: true,
        writable: true,
      });
    }
    CanvasChannelCheckboxRequestSchema.shape.documentId.parse(own.documentId);
    requested = Object.freeze(own);
    const raw = scanCheckboxReservations(tx, requested);
    const summary: CheckboxPolicySummary = {
      raw,
      installation: usage(),
      document: usage(),
      route: usage(),
      matching: null,
    };
    let cursor: string | undefined;
    let validated = 0;
    for (;;) {
      const rows = readChecked('canvas_doc_write_intents', 'policy-census', () =>
        readPreparedIntentPage(tx, cursor)
      );
      for (const row of rows) {
        validated = add(validated, 1);
        validateCheckboxEvidence(row);
        if (['committed', 'no_op', 'conflict'].includes(row.status)) continue;
        const policy = readCheckboxReservationPolicy(tx, row);
        const projection = projectVerifiedCheckbox(row);
        charge(summary.installation, policy, projection.identity.bytes);
        if (row.documentId !== requested.documentId) continue;
        charge(summary.document, policy, projection.identity.bytes);
        if (policy.route.id === requested.routeId)
          charge(summary.route, policy, projection.identity.bytes);
        if (row.eventId === requested.eventId)
          summary.matching = { intent: row, policy, projection };
      }
      if (rows.length < 100) break;
      cursor = rows[rows.length - 1]!.intentId;
    }
    if (validated !== raw.validated) unavailable();
    return freezeCheckboxData(summary);
  } catch (cause) {
    throw new CheckboxReservationCensusError({ cause });
  }
}

/** Fixed central UUID guard; historical nonUUID inputs still require the complete global census. */
export function requireDocEventUuidVacant(
  tx: DbTransaction,
  documentId: string,
  eventId: string
): void {
  tx.get(sql`SELECT 1`);
  const parsed = CanvasChannelEventIdSchema.safeParse(eventId);
  const census = scanCheckboxReservationPolicies(tx, {
    documentId,
    ...(parsed.success ? { eventId } : {}),
  });
  const existing = readDocEventRow(tx, documentId, eventId);
  if (census.raw.matchingIntent || existing)
    throw new Error('Document event UUID is permanently reserved.');
}

/** Fixed original-row query shared by ordinary reads and the pre-sequence UUID guard. */
export function readDocEventRow(
  executor: Db | DbTransaction,
  documentId: string,
  eventId: string
): typeof canvasDocEvents.$inferSelect | undefined {
  return readChecked('canvas_doc_events', `${documentId}/${eventId}`, () =>
    readPreparedEvent(executor, documentId, eventId)
  );
}
