/** Independent exact route grants backed by existing operator approvals. */
import { ulid } from 'ulidx';
import { APPROVAL_DETAIL_MAX_LENGTH } from '@dorkos/shared/approval-schemas';
import {
  and,
  eq,
  isNull,
  approvals,
  canvasDocChannels,
  canvasDocGrants,
  type Db,
  type DbTransaction,
} from '@dorkos/db';
import {
  CanvasChannelDeclarationSchema,
  type CanvasChannelDeclaration,
  type CanvasChannelRoute,
} from '@dorkos/shared/canvas-channel-schemas';
import { hashApprovalInput } from '../../core/approvals/approval-input-hash.js';
import type {
  ApprovalService,
  ApprovalTicket,
  ApprovalConsumptionSettlement,
} from '../../core/approvals/approval-service.js';
import { DocChannelStore, type DocGrantRow } from './store.js';
import { DocChannelGrantRevalidation } from './grant-revalidation.js';
export type { DocGrantedRoute } from './grant-revalidation.js';
import {
  DocRouteGrantError,
  DocRouteGrantRequestSchema,
  declaredRoute,
  grantTypes,
  validateDocGrantTarget,
  type DocGrantActor,
  type DocGrantAuthority,
  type DocRouteGrantRequest,
  type DocGrantTarget,
} from './grant-policy.js';

const APPROVE_CAPABILITY = 'ui.approve_doc_route';
const PLATFORM_LIMITS = { envelopeBytes: 16384, eventsPerMinute: 60, turnsPerHour: 10 };
/** One server-normalized exact approval subject; no page field supplies authority evidence. */
export interface PreparedDocGrant {
  request: DocRouteGrantRequest;
  bindingInput: Record<string, unknown>;
  inputHash: string;
  route: CanvasChannelRoute;
  target: DocGrantTarget;
  openerAgentId: string | null;
  declarationHash: string;
  manifestHash: string | null;
  allowedTypes: string[];
  limits: typeof PLATFORM_LIMITS;
  self: boolean;
}
/** Outcomes distinguish existing/active grant from a pending actual operator decision. */
export type DocGrantResult =
  { kind: 'granted'; grant: DocGrantRow } | { kind: 'approval_required'; ticket: ApprovalTicket };
/** Exact grants; declaration changes and approvals never replay previously accepted input. */
export class DocChannelGrants extends DocChannelGrantRevalidation {
  /** Build over the same SQLite connection as the existing one-use approval service. */
  constructor(
    private readonly deps: {
      db: Db;
      store: DocChannelStore;
      approvals: ApprovalService;
      authority: DocGrantAuthority;
      now?: () => Date;
    }
  ) {
    super(deps);
    deps.approvals.assertTransactionDatabase(deps.db);
  }
  /** Replace declarations as data, invalidating old authority without routing old events. */
  configure(
    documentId: string,
    declaration: CanvasChannelDeclaration,
    actor: DocGrantActor,
    selectedOpenerAgentId?: string
  ): void {
    const validated = CanvasChannelDeclarationSchema.parse(declaration);
    this.refreshAuthority(documentId, actor);
    this.deps.store.transaction((tx) => {
      const { scope } = this.access(documentId, actor, tx);
      const channel = this.deps.store.getChannel(documentId, tx)!;
      const claims = actor.principal.claims;
      const actorAgent =
        claims.kind === 'agent' || claims.kind === 'runtime' ? claims.agentId : null;
      if (claims.kind !== 'operator' && (!actorAgent || actorAgent !== channel.openerAgentId))
        throw new DocRouteGrantError('OPENER_REQUIRED');
      let openerAgentId = channel.openerAgentId;
      if (selectedOpenerAgentId) {
        if (
          claims.kind !== 'operator' ||
          (openerAgentId && openerAgentId !== selectedOpenerAgentId)
        )
          throw new DocRouteGrantError('OPENER_IMMUTABLE');
        const route: CanvasChannelRoute = {
          id: 'opener-selection',
          on: 'doc.opened',
          to: `agent:${selectedOpenerAgentId}`,
          turn: { mode: 'none' },
        };
        const target = this.deps.authority.resolveTarget(
          { documentId, scope, route, openerAgentId },
          tx
        );
        validateDocGrantTarget(scope, route, openerAgentId, target);
        openerAgentId = selectedOpenerAgentId;
      }
      const declarationHash = hashApprovalInput(validated);
      if (channel.declarationHash !== declarationHash) this.suspend(documentId, tx);
      tx.update(canvasDocChannels)
        .set({ declaration: validated, declarationHash, openerAgentId, updatedAt: this.now() })
        .where(eq(canvasDocChannels.documentId, documentId))
        .run();
      this.manifest(documentId, tx);
    });
  }
  /** Resolve the exact binding shown for approval, using only current canonical server identity. */
  prepare(
    request: DocRouteGrantRequest,
    actor: DocGrantActor,
    tx: DbTransaction
  ): PreparedDocGrant {
    const parsed = DocRouteGrantRequestSchema.parse(request);
    const { scope } = this.access(parsed.documentId, actor, tx);
    const manifest = this.manifest(parsed.documentId, tx);
    const channel = this.deps.store.getChannel(parsed.documentId, tx)!;
    const route = declaredRoute(channel, parsed.routeId);
    if (
      !channel.declarationHash ||
      hashApprovalInput(CanvasChannelDeclarationSchema.parse(channel.declaration)) !==
        channel.declarationHash
    )
      throw new DocRouteGrantError('DECLARATION_HASH_MISMATCH');
    if (Date.parse(parsed.expiresAt) <= Date.parse(this.now()))
      throw new DocRouteGrantError('GRANT_EXPIRED');
    if (
      route.to !== 'log' &&
      (!channel.openerAgentId ||
        !this.deps.authority.originCurrent(parsed.documentId, channel.openerAgentId, tx))
    )
      throw new DocRouteGrantError('ORIGIN_AUTHORITY_LOST');
    if (
      parsed.write &&
      hashApprovalInput(
        this.deps.authority.resolveWriteBinding?.(parsed.documentId, tx) ?? null
      ) !== hashApprovalInput(parsed.write)
    )
      throw new DocRouteGrantError('WRITE_BINDING_MISMATCH');
    const target = this.deps.authority.resolveTarget(
      { documentId: parsed.documentId, scope, route, openerAgentId: channel.openerAgentId },
      tx
    );
    validateDocGrantTarget(scope, route, channel.openerAgentId, target);
    const allowedTypes = grantTypes(route, parsed.allowedTypes);
    const limits = { ...PLATFORM_LIMITS };
    for (const key of Object.keys(limits) as (keyof typeof limits)[])
      limits[key] = Math.min(
        limits[key],
        parsed.limits?.[key] ?? limits[key],
        manifest?.compiled.manifest.limits?.[key] ?? limits[key]
      );
    const claims = actor.principal.claims;
    const actorAgent = claims.kind === 'agent' || claims.kind === 'runtime' ? claims.agentId : null;
    const self =
      actorAgent === channel.openerAgentId &&
      actorAgent !== null &&
      !parsed.write &&
      (route.to === 'log' || route.to === 'agent:owner');
    const bindingInput = {
      documentId: parsed.documentId,
      scope,
      route,
      routeHash: hashApprovalInput(route),
      declarationHash: channel.declarationHash,
      manifestHash: manifest?.hash ?? null,
      openerAgentId: channel.openerAgentId,
      target,
      allowedTypes,
      limits,
      expiresAt: parsed.expiresAt,
      write: parsed.write ?? null,
      origin: claims,
    };
    return {
      request: parsed,
      bindingInput,
      inputHash: hashApprovalInput(bindingInput),
      route,
      target,
      openerAgentId: channel.openerAgentId,
      declarationHash: channel.declarationHash,
      manifestHash: manifest?.hash ?? null,
      allowedTypes,
      limits,
      self,
    };
  }
  private existing(prepared: PreparedDocGrant, tx: DbTransaction): DocGrantRow | undefined {
    const rows = tx
      .select()
      .from(canvasDocGrants)
      .where(
        and(
          eq(canvasDocGrants.documentId, prepared.request.documentId),
          eq(canvasDocGrants.routeId, prepared.route.id),
          isNull(canvasDocGrants.revokedAt)
        )
      )
      .all();
    return rows.find((row) => {
      const evidence = row.approvalEvidence as { inputHash?: unknown };
      return (
        evidence?.inputHash === prepared.inputHash &&
        row.expiresAt !== null &&
        Date.parse(row.expiresAt) > Date.parse(this.now())
      );
    });
  }
  /** Enable opener self/log authority or request/consume an exact operator verdict atomically. */
  grant(
    request: DocRouteGrantRequest,
    actor: DocGrantActor,
    approvalToken?: string
  ): DocGrantResult {
    this.refreshAuthority(request.documentId, actor);
    const settlements: ApprovalConsumptionSettlement[] = [];
    let result: DocGrantResult;
    try {
      result = this.deps.store.transaction((tx) => {
        const prepared = this.prepare(request, actor, tx);
        const existing = this.existing(prepared, tx);
        if (existing) return { kind: 'granted', grant: existing };
        if (!prepared.self && !approvalToken) {
          const detail = JSON.stringify(prepared.bindingInput);
          if (detail.length > APPROVAL_DETAIL_MAX_LENGTH)
            throw new DocRouteGrantError('APPROVAL_SUBJECT_TOO_LARGE', 422);
          const ticket = this.deps.approvals.request({
            capabilityId: APPROVE_CAPABILITY,
            inputHash: prepared.inputHash,
            summary: `Allow document events on route ${prepared.route.id}.`,
            detail,
            area: null,
          });
          return { kind: 'approval_required', ticket };
        }
        let approvalId: string | null = null;
        let approvedBy: string;
        let approvalEvidence: Record<string, unknown>;
        if (prepared.self) {
          approvedBy = prepared.openerAgentId!;
          approvalEvidence = {
            kind: 'verified_opener',
            inputHash: prepared.inputHash,
            binding: prepared.bindingInput,
          };
        } else {
          const verdict = this.deps.approvals.consume(
            approvalToken!,
            {
              capabilityId: APPROVE_CAPABILITY,
              inputHash: prepared.inputHash,
            },
            { deferSettlement: (settlement) => settlements.push(settlement) }
          );
          if (verdict.outcome !== 'granted')
            throw new DocRouteGrantError(`APPROVAL_${verdict.outcome.toUpperCase()}`);
          const row = tx.select().from(approvals).where(eq(approvals.id, verdict.approvalId)).get();
          if (
            !row ||
            row.state !== 'granted' ||
            row.inputHash !== prepared.inputHash ||
            !row.decidedAt ||
            !row.consumedAt
          )
            throw new DocRouteGrantError('APPROVAL_EVIDENCE_MISMATCH');
          approvalId = row.id;
          approvedBy = `approval:${row.id}`;
          approvalEvidence = {
            kind: 'operator_approval',
            approvalId,
            state: row.state,
            inputHash: row.inputHash,
            decidedAt: row.decidedAt,
            consumedAt: row.consumedAt,
            binding: prepared.bindingInput,
          };
        }
        // No async boundary between current authority, one-use consumption and source insertion.
        const finalPrepared = this.prepare(request, actor, tx);
        if (finalPrepared.inputHash !== prepared.inputHash)
          throw new DocRouteGrantError('GRANT_BINDING_CHANGED');
        const grantId = ulid();
        this.deps.store.insertGrant(
          {
            grantId,
            documentId: request.documentId,
            routeId: prepared.route.id,
            revision: 1,
            normalizedRoute: prepared.route,
            routeHash: hashApprovalInput(prepared.route),
            declarationHash: prepared.declarationHash,
            manifestHash: prepared.manifestHash,
            openerAgentId: prepared.openerAgentId,
            targetAgentId: prepared.target.agentId,
            targetSessionId: prepared.target.sessionId,
            targetRuntime: prepared.target.runtime,
            approvedBy,
            approvalId,
            approvalEvidence,
            allowedTypes: prepared.allowedTypes,
            limits: prepared.limits,
            writeOperation: request.write ?? null,
            createdAt: this.now(),
            expiresAt: request.expiresAt,
          },
          tx
        );
        return { kind: 'granted', grant: this.deps.store.getGrant(grantId, tx)! };
      });
    } catch (error) {
      for (const settlement of settlements) this.deps.approvals.discardConsumption(settlement);
      throw error;
    }
    for (const settlement of settlements) this.deps.approvals.publishConsumption(settlement);
    return result;
  }
  /** Explicit revoke; a later grant never implicitly retries input saved under this one. */
  revoke(documentId: string, grantId: string, actor: DocGrantActor): void {
    this.deps.store.transaction((tx) => {
      this.access(documentId, actor, tx);
      const row = this.deps.store.getGrant(grantId, tx);
      if (!row || row.documentId !== documentId)
        throw new DocRouteGrantError('GRANT_NOT_FOUND', 404);
      const claims = actor.principal.claims;
      if (
        claims.kind !== 'operator' &&
        (!(claims.kind === 'agent' || claims.kind === 'runtime') ||
          claims.agentId !== row.openerAgentId)
      )
        throw new DocRouteGrantError('OPENER_REQUIRED');
      this.deps.store.revokeGrant(grantId, row.revision, this.now(), tx);
    });
  }
}
