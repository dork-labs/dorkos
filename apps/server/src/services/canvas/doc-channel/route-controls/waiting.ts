/**
 * Which open agent requests for a route belong to one document.
 *
 * An agent's `approve_doc_route` request stores its exact grant binding as the
 * approval's detail, and the approval's `inputHash` is that binding's hash. The
 * stored copy is swept for token-shaped text, so a 32-hex document id and the
 * binding's own hashes read `(hidden)`. Matching on what survives (scope, opener,
 * route) cannot tell two documents with the same declaration apart, so this does
 * not match at all: it puts THIS document's id and current hashes back into the
 * stored binding and accepts the request only when the result hashes to the
 * approval's own `inputHash`. A request for any other document, or for a
 * declaration that has since changed, cannot pass that check. A binding with any
 * other field hidden fails it too, and simply is not shown as waiting.
 *
 * @module services/canvas/doc-channel/route-controls/waiting
 */
import { and, eq, isNull, approvals, type Db } from '@dorkos/db';
import type { CanvasChannelRoute } from '@dorkos/shared/canvas-channel-schemas';
import { hashApprovalInput } from '../../../core/approvals/approval-input-hash.js';
import { REDACTED_SUMMARY_VALUE } from '../../../core/approvals/approval-summary.js';
import type { DocChannelRow } from '../store.js';

/** The capability whose approvals a route's grant consumes. */
export const APPROVE_DOC_ROUTE = 'ui.approve_doc_route';

/** One open request for a route. */
export interface WaitingRequest {
  approvalId: string;
  expiresAt: string;
}

function rebind(
  subject: Record<string, unknown>,
  channel: DocChannelRow
): Record<string, unknown> | undefined {
  const hidden = (value: unknown) => value === REDACTED_SUMMARY_VALUE;
  if (subject.documentId !== channel.documentId && !hidden(subject.documentId)) return undefined;
  return {
    ...subject,
    documentId: channel.documentId,
    routeHash: hashApprovalInput(subject.route),
    declarationHash: hidden(subject.declarationHash)
      ? channel.declarationHash
      : subject.declarationHash,
    manifestHash: hidden(subject.manifestHash) ? channel.manifestHash : subject.manifestHash,
  };
}

/** Whether a rebuilt binding hashes to the approval's own input hash. */
function boundTo(candidate: Record<string, unknown> | undefined, inputHash: string): boolean {
  if (!candidate) return false;
  try {
    return hashApprovalInput(candidate) === inputHash;
  } catch {
    return false; // Not a bindable shape: not this document's request.
  }
}

/**
 * Every open, unexpired agent request for each declared route of one document,
 * newest first.
 *
 * @param db - The database the approvals live in.
 * @param channel - The document's current channel row.
 * @param routes - Its declared routes.
 * @param now - The current time.
 */
export function findWaitingRequests(
  db: Db,
  channel: DocChannelRow,
  routes: readonly CanvasChannelRoute[],
  now: Date
): Map<string, WaitingRequest[]> {
  const rows = db
    .select()
    .from(approvals)
    .where(
      and(
        eq(approvals.capabilityId, APPROVE_DOC_ROUTE),
        eq(approvals.state, 'pending'),
        isNull(approvals.consumedAt)
      )
    )
    .all()
    .filter((row) => row.expiresAt > now.toISOString())
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  const waiting = new Map<string, WaitingRequest[]>();
  for (const row of rows) {
    let subject: Record<string, unknown> | undefined;
    try {
      subject = row.detail ? JSON.parse(row.detail) : undefined;
    } catch {
      continue; // A clamped subject names nothing reliably; it is not shown.
    }
    const routeId = (subject?.route as { id?: unknown } | undefined)?.id;
    if (!subject || !routes.some((route) => route.id === routeId)) continue;
    if (!boundTo(rebind(subject, channel), row.inputHash)) continue;
    const list = waiting.get(routeId as string) ?? [];
    list.push({ approvalId: row.id, expiresAt: row.expiresAt });
    waiting.set(routeId as string, list);
  }
  return waiting;
}
