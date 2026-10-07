import { requireServerNativeDatabaseQueryCustody } from '@dorkos/db/internal-server';
import type { Db } from '@dorkos/db';
export type OriginalDocTokenNativeRow = Readonly<Record<string, string | number | null>>;
export interface OriginalDocTokenNativeFacts {
  readonly physical: OriginalDocTokenNativeRow;
  readonly channel: OriginalDocTokenNativeRow;
  readonly grants: readonly OriginalDocTokenNativeRow[];
  readonly approvals: readonly OriginalDocTokenNativeRow[];
  readonly owner: Readonly<{ id: string }> | null;
}

const apply = Reflect.apply;
const ownKeys = Object.keys;
const ownDescriptor = Object.getOwnPropertyDescriptor;
const freeze = Object.freeze;

function refuse(): never {
  throw new Error('Original document token native source is unavailable.');
}

function scalarRow(value: unknown): OriginalDocTokenNativeRow {
  if (!value || typeof value !== 'object') refuse();
  const keys = ownKeys(value);
  if (keys.length > 128) refuse();
  const result: Record<string, string | number | null> = Object.create(null);
  for (let index = 0; index < keys.length; index++) {
    const key = keys[index]!;
    const descriptor = ownDescriptor(value, key);
    const slot = descriptor && ownDescriptor(descriptor, 'value');
    if (!slot) refuse();
    const item: unknown = slot.value;
    if (
      item !== null &&
      typeof item !== 'string' &&
      !(typeof item === 'number' && Number.isFinite(item))
    )
      refuse();
    Object.defineProperty(result, key, { value: item, enumerable: true });
  }
  return freeze(result);
}

/** Fixed raw native DATA reads. The original engine alone turns comparisons into a gate. */
export function createOriginalDocTokenNativeFactsReader(
  db: Db
): (documentId: string) => OriginalDocTokenNativeFacts {
  requireServerNativeDatabaseQueryCustody(db);
  const client = db.$client;
  const prepare = client.prepare;
  const fixed = (sql: string) => apply(prepare, client, [sql]);
  const physical = fixed('SELECT * FROM main.canvas_documents WHERE id=? LIMIT 1');
  const channel = fixed(`SELECT document_id,scope,declaration,declaration_hash,opener_agent_id,
    manifest_hash,closed_at,closure_evidence,created_at FROM main.canvas_doc_channels
    WHERE document_id=? LIMIT 1`);
  const grants = fixed(`SELECT * FROM main.canvas_doc_grants WHERE document_id=?
    ORDER BY grant_id ASC LIMIT 1025`);
  const approval = fixed('SELECT * FROM main.approvals WHERE id=? LIMIT 1');
  const owner = fixed('SELECT id FROM main.user ORDER BY created_at ASC LIMIT 1');
  // Statements remain private. Captured methods never depend on a later public builder.
  const physicalGet = physical.get;
  const channelGet = channel.get;
  const grantsAll = grants.all;
  const approvalGet = approval.get;
  const ownerGet = owner.get;
  return (documentId) => {
    requireServerNativeDatabaseQueryCustody(db);
    if (typeof documentId !== 'string' || !documentId) refuse();
    const physicalRow = scalarRow(apply(physicalGet, physical, [documentId]));
    const channelRow = scalarRow(apply(channelGet, channel, [documentId]));
    const grantRows = apply(grantsAll, grants, [documentId]);
    if (grantRows.length > 1024) refuse();
    const retainedGrants: OriginalDocTokenNativeRow[] = [];
    const retainedApprovals: OriginalDocTokenNativeRow[] = [];
    for (let index = 0; index < grantRows.length; index++) {
      const row = scalarRow(grantRows[index]);
      if (row.document_id !== documentId) refuse();
      retainedGrants[index] = row;
      if (row.approval_id !== null) {
        if (typeof row.approval_id !== 'string') refuse();
        const approved = scalarRow(apply(approvalGet, approval, [row.approval_id]));
        if (approved.id !== row.approval_id) refuse();
        retainedApprovals[retainedApprovals.length] = approved;
      }
    }
    const ownerRow = apply(ownerGet, owner, []);
    const retainedOwner = ownerRow === undefined ? null : scalarRow(ownerRow);
    if (retainedOwner && (typeof retainedOwner.id !== 'string' || !retainedOwner.id)) refuse();
    requireServerNativeDatabaseQueryCustody(db);
    return freeze({
      physical: physicalRow,
      channel: channelRow,
      grants: freeze(retainedGrants),
      approvals: freeze(retainedApprovals),
      owner: retainedOwner ? freeze({ id: retainedOwner.id as string }) : null,
    });
  };
}
