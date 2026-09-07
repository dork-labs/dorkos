/** Immutable owner review receipts for exact event subscription generations. */
import { createHash } from 'node:crypto';
import { z } from 'zod';
import { stableStringify } from '@dorkos/shared/capabilities';
import {
  ConnectorReceiveScopeSchema,
  ConnectorEventGrantSelectionSchema,
  type ConnectorReceiveScope,
  type ConnectorEventGrantSelection,
} from '@dorkos/shared/connector-event-schemas';
import { CONNECTOR_EVENT_REVIEW_SCOPE_LIMIT } from '@dorkos/shared/connector-schemas';
import type { ConnectorOwnerAuthority } from '../principal/server-principal.js';
import {
  ConnectorSubscriptionError,
  type ConnectorSubscriptionStore,
} from './subscription-store.js';

const StoredReviewSchema = z
  .array(
    z
      .object({
        selection: ConnectorEventGrantSelectionSchema,
        scope: ConnectorReceiveScopeSchema,
        manageExistingTriggers: z.boolean(),
      })
      .strict()
  )
  .min(1)
  .max(CONNECTOR_EVENT_REVIEW_SCOPE_LIMIT);

/** Atomically select generations once for a server-owned review identity. */
export function prepareEventReview(
  store: ConnectorSubscriptionStore,
  owner: ConnectorOwnerAuthority,
  reviewId: string,
  scopes: ConnectorReceiveScope[],
  manageExistingTriggers: boolean,
  now: string
) {
  const normalized = z
    .array(ConnectorReceiveScopeSchema)
    .min(1)
    .max(CONNECTOR_EVENT_REVIEW_SCOPE_LIMIT)
    .parse(scopes);
  z.string().min(1).max(256).parse(reviewId);
  const ownerId = owner.kind === 'user' ? owner.userId : owner.installationId;
  const requestHash = createHash('sha256')
    .update(stableStringify({ scopes: normalized, manageExistingTriggers }))
    .digest('hex');
  return store.db.transaction(() => {
    const existing = store.db.$client
      .prepare(
        'SELECT request_hash, selections_json FROM connector_event_consent_commands WHERE owner_kind = ? AND owner_id = ? AND review_id = ?'
      )
      .get(owner.kind, ownerId, reviewId) as
      { request_hash: string; selections_json: string } | undefined;
    if (existing) {
      if (existing.request_hash !== requestHash)
        throw new ConnectorSubscriptionError('review_conflict');
      return StoredReviewSchema.parse(JSON.parse(existing.selections_json));
    }
    const selected = normalized.map((scope) => {
      const proposed = store.propose(owner, scope, now);
      const selection = {
        subscriptionId: proposed.subscriptionId,
        scopeVersion: proposed.scopeVersion,
        definitionId: scope.definitionId,
        eventScopeHash: createHash('sha256')
          .update(
            stableStringify({
              owner,
              scope,
              providerGeneration: proposed.connection.providerGeneration,
              subscriptionId: proposed.subscriptionId,
              scopeVersion: proposed.scopeVersion,
            })
          )
          .digest('hex'),
      };
      return { selection, scope, manageExistingTriggers };
    });
    // Two indistinguishable destinations would invalidate the first generation
    // while preparing the second. Refuse the entire review atomically.
    if (new Set(selected.map((item) => item.selection.subscriptionId)).size !== selected.length)
      throw new ConnectorSubscriptionError('review_conflict');
    store.db.$client
      .prepare(
        'INSERT INTO connector_event_consent_commands (owner_kind, owner_id, review_id, request_hash, selections_json, created_at) VALUES (?, ?, ?, ?, ?, ?)'
      )
      .run(owner.kind, ownerId, reviewId, requestHash, JSON.stringify(selected), now);
    return selected;
  });
}

/** Read a complete same-owner immutable approval receipt, never a caller-reconstructed scope. */
export function approvedEventSelections(
  store: ConnectorSubscriptionStore,
  owner: ConnectorOwnerAuthority,
  selections: ConnectorEventGrantSelection[]
) {
  const requested = z
    .array(ConnectorEventGrantSelectionSchema)
    .min(1)
    .max(CONNECTOR_EVENT_REVIEW_SCOPE_LIMIT)
    .parse(selections);
  if (new Set(requested.map((item) => item.subscriptionId)).size !== requested.length)
    return undefined;
  const first = requested[0]!;
  const ownerId = owner.kind === 'user' ? owner.userId : owner.installationId;
  const candidates = store.db.$client
    .prepare(
      `SELECT selections_json FROM connector_event_consent_commands c
    WHERE c.owner_kind = ? AND c.owner_id = ? AND EXISTS (
      SELECT 1 FROM json_each(c.selections_json) item WHERE json_extract(item.value, '$.selection.subscriptionId') = ?
      AND json_extract(item.value, '$.selection.scopeVersion') = ?) LIMIT 2`
    )
    .all(owner.kind, ownerId, first.subscriptionId, first.scopeVersion) as Array<{
    selections_json: string;
  }>;
  if (candidates.length !== 1) return undefined;
  const stored = StoredReviewSchema.parse(JSON.parse(candidates[0]!.selections_json));
  const order = (items: ConnectorEventGrantSelection[]) =>
    stableStringify([...items].sort((a, b) => a.subscriptionId.localeCompare(b.subscriptionId)));
  if (order(stored.map((item) => item.selection)) !== order(requested)) return undefined;
  for (const { selection, scope } of stored) {
    const proposed = store.reviewedProposal(owner, selection, scope);
    if (!proposed) return undefined;
    const expectedHash = createHash('sha256')
      .update(
        stableStringify({
          owner,
          scope,
          providerGeneration: proposed.connection.providerGeneration,
          subscriptionId: proposed.subscriptionId,
          scopeVersion: proposed.scopeVersion,
        })
      )
      .digest('hex');
    if (expectedHash !== selection.eventScopeHash) return undefined;
  }
  return stored;
}

/** Reconstruct intent only from a hash-matching durable review, never from pending rows alone. */
export function recoverEventReview(input: {
  review_id: string;
  request_hash: string;
  selections_json: string;
}) {
  const stored = StoredReviewSchema.parse(JSON.parse(input.selections_json));
  const manageExistingTriggers = stored[0]!.manageExistingTriggers;
  if (stored.some((item) => item.manageExistingTriggers !== manageExistingTriggers))
    throw new ConnectorSubscriptionError('review_conflict');
  const scopes = stored.map((item) => item.scope);
  const requestHash = createHash('sha256')
    .update(stableStringify({ scopes, manageExistingTriggers }))
    .digest('hex');
  if (requestHash !== input.request_hash) throw new ConnectorSubscriptionError('review_conflict');
  return { reviewId: input.review_id, scopes, manageExistingTriggers, selected: stored };
}
