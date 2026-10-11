import type { ApprovalService, ApprovalTicket } from '../../../core/approvals/approval-service.js';
import type { DocGrantAuthority, DocRouteGrantRequest } from '../grant-policy.js';
import type { approvals, Db } from '@dorkos/db';
import type { CanvasChannelRoute } from '@dorkos/shared/canvas-channel-schemas';
import type { DocChannelStore, DocGrantRow } from '../store.js';
import type { DocGrantTarget, DocOriginalWriteObservation } from '../grant-policy.js';

/** Exact current dependency DATA selected by original native grant readers. */
export interface OriginalCurrentDocumentGrantDependencies {
  manifestHash: string | null;
  originalRows: {
    grants: DocGrantRow[];
    approvals: (typeof approvals.$inferSelect)[];
    channel: Omit<
      import('../store.js').DocChannelRow,
      'nextDocSeq' | 'updatedAt' | 'receiptRetentionFloor'
    >;
  };
  grants: DocGrantRow[];
  approvals: (typeof approvals.$inferSelect)[];
}
/** Original token write evidence is private to the grant constructor. */
export type OriginalTokenWriteObservation =
  DocOriginalWriteObservation | Readonly<{ manifestHash: string | null; write: null }>;
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
  limits: OriginalGrantPlatformLimits;
  self: boolean;
}
/** Outcomes distinguish existing/active grant from a pending actual operator decision. */
export type DocGrantResult =
  { kind: 'granted'; grant: DocGrantRow } | { kind: 'approval_required'; ticket: ApprovalTicket };
/** Exact scalar shape of the original private platform ceiling. */
export interface OriginalGrantPlatformLimits {
  envelopeBytes: number;
  eventsPerMinute: number;
  turnsPerHour: number;
}
/** Original fixed grant creation dependencies. */
export interface OriginalGrantCreationDependencies {
  db: Db;
  store: DocChannelStore;
  approvals: ApprovalService;
  authority: DocGrantAuthority;
  now?: () => Date;
}
