/** Fixed checkbox row policies return data; private scoped authority remains in the owning factory. */
import { types as utilTypes } from 'node:util';
import { and, eq, isNull, authors, canvasDocuments, type Db, type DbTransaction } from '@dorkos/db';
import { matchesCanvasChannelEvent } from '@dorkos/shared/canvas-channel-schemas';
import type { CanvasDocumentStore } from '../../canvas-document-store.js';
import { canvasEditorLockHolder } from '../../canvas-editor-policy.js';
import { parseScope, SESSION_AGENT_AUTHOR, SESSION_OWNER_AUTHOR } from '../../scopes.js';
import type { RoomService } from '../../../rooms/room-service.js';
import type { RoomRepoStore } from '../../../rooms/repo/room-repo-store.js';
import type { DocChannelActor, DocChannelAuthorization } from '../authorization.js';
import type { DocChannelGrants } from '../grants.js';
import type { DocChannelStore, DocWriteIntentRow } from '../store.js';
import { RoomError } from '../../../rooms/room-errors.js';
import { DocChannelArchivedError } from '../authorization.js';
import { DocRouteGrantError } from '../grant-policy.js';
import { declaredRoute } from '../grant-policy.js';
import {
  docInstallationOwner,
  sameDocOwnerAuthority,
  readDocSourceDescriptor,
} from '../doc-source-policy.js';
import {
  freezeCheckboxData,
  VerifiedCheckboxAuthoritySchema,
  type VerifiedCheckboxAuthority,
  type CheckboxRequest,
} from './checkbox-evidence.js';
import {
  CheckboxAuthorityRefusal,
  checkboxAuthoritySync,
  checkboxSourceBinding,
  checkboxDocumentGeneration,
  type CheckboxSourceObservation,
} from './authority-snapshot.js';

/** Required existing server instances on the same SQLite connection; no fallback authority. */
export interface CheckboxAuthorityDependencies {
  db: Db;
  documents: CanvasDocumentStore;
  roomRepos: RoomRepoStore;
  rooms: RoomService;
  authorization: DocChannelAuthorization;
  grants: DocChannelGrants;
  store: DocChannelStore;
  installationId: string;
  now: () => Date;
}
/** Capture only inspectable own dependency fields; this returns no private authority witness. */
export function captureCheckboxDependencies(
  input: CheckboxAuthorityDependencies
): Readonly<CheckboxAuthorityDependencies> {
  if (utilTypes.isProxy(input) || Object.getPrototypeOf(input) !== Object.prototype)
    throw new Error('Checkbox authority dependencies must be plain own data.');
  const captured = {} as CheckboxAuthorityDependencies;
  for (const key of [
    'db',
    'documents',
    'roomRepos',
    'rooms',
    'authorization',
    'grants',
    'store',
    'installationId',
    'now',
  ] as const) {
    const field = Object.getOwnPropertyDescriptor(input, key);
    if (!field || !('value' in field))
      throw new Error('Checkbox authority dependency is not own data.');
    Object.defineProperty(captured, key, { value: field.value, enumerable: true });
  }
  return Object.freeze(captured);
}

/** Closed live or existing-recovery subject; verified data alone grants no transaction authority. */
export type CheckboxReservationSubject =
  | {
      kind: 'live';
      request: CheckboxRequest;
      actor: DocChannelActor;
      approved: VerifiedCheckboxAuthority;
    }
  | { kind: 'recovery'; intent: DocWriteIntentRow; approved: VerifiedCheckboxAuthority };
/** Original owner equality; no current permission is minted by this row policy. */
export function requireCheckboxOriginalOwner(
  deps: Readonly<CheckboxAuthorityDependencies>,
  grantId: string,
  tx: DbTransaction
): void {
  const recorded = deps.store.getGrant(grantId, tx);
  const owner = (recorded?.approvalEvidence as { binding?: { origin?: { owner?: unknown } } })
    ?.binding?.origin?.owner;
  if (!sameDocOwnerAuthority(owner, docInstallationOwner(deps.installationId)))
    throw new CheckboxAuthorityRefusal('ORIGINAL_OWNER_CHANGED');
}
/** Exact shared editor policy at a mandatory time captured by the owning guarded phase. */
export function requireCheckboxEditor(
  deps: Readonly<CheckboxAuthorityDependencies>,
  documentId: string,
  actor: DocChannelActor | undefined,
  tx: DbTransaction,
  options: { grantId?: string; time: number }
): void {
  const time = options.time;
  const grantId = options.grantId;
  const physical = tx
    .select()
    .from(canvasDocuments)
    .where(eq(canvasDocuments.id, documentId))
    .get();
  if (!physical) throw new CheckboxAuthorityRefusal('DOCUMENT_CLOSED');
  const scope = parseScope(
    checkboxAuthoritySync(deps.documents.lifecycle.resolveScope(physical.scope))
  );
  let authorId: string;
  if (scope.kind === 'session')
    authorId =
      actor?.principal.claims.kind === 'runtime' ? SESSION_AGENT_AUTHOR : SESSION_OWNER_AUTHOR;
  else if (scope.kind === 'room') {
    const owner = docInstallationOwner(deps.installationId);
    const claims = actor?.principal.claims;
    const recordedOwner = grantId
      ? (
          deps.store.getGrant(grantId, tx)?.approvalEvidence as {
            binding?: { origin?: { owner?: unknown } };
          }
        )?.binding?.origin?.owner
      : claims?.owner;
    if (!sameDocOwnerAuthority(recordedOwner, owner))
      throw new CheckboxAuthorityRefusal('ORIGINAL_OWNER_CHANGED');
    const agent = claims?.kind === 'runtime' || claims?.kind === 'agent';
    const naturalKey = agent
      ? claims.agentPath
      : owner.kind === 'user'
        ? `user:${owner.userId}`
        : 'local';
    const author = tx
      .select()
      .from(authors)
      .where(
        and(
          eq(authors.kind, agent ? 'agent' : 'human'),
          eq(authors.naturalKey, naturalKey),
          isNull(authors.retiredAt)
        )
      )
      .get();
    if (!author || (agent && author.mintedForManifestId !== claims.agentId))
      throw new CheckboxAuthorityRefusal('EDITOR_AUTHORITY_LOST');
    authorId = author.id;
    checkboxAuthoritySync(deps.rooms.assertCanWriteFiles(scope.id, authorId));
  } else throw new CheckboxAuthorityRefusal('DOCUMENT_SCOPE_CHANGED');
  const held = canvasEditorLockHolder(physical, time);
  if (held && held !== authorId) throw new CheckboxAuthorityRefusal('EDITOR_LOCKED');
}
/** Detached checked rows only; the owning A consumes snapshots and enforces scope provenance. */
export function readCheckboxCurrentRows(
  deps: Readonly<CheckboxAuthorityDependencies>,
  documentId: string,
  grantId: string,
  revision: number,
  observation: CheckboxSourceObservation,
  tx: DbTransaction,
  actor: DocChannelActor | undefined,
  time: number
): VerifiedCheckboxAuthority {
  if (
    JSON.stringify(checkboxAuthoritySync(readDocSourceDescriptor(deps, documentId, tx))) !==
    JSON.stringify(observation.descriptor)
  )
    throw new CheckboxAuthorityRefusal('SOURCE_DESCRIPTOR_CHANGED');
  requireCheckboxOriginalOwner(deps, grantId, tx);
  const observedBinding = checkboxSourceBinding(observation.descriptor, observation.canonicalPath);
  const grant = checkboxAuthoritySync(
    deps.grants.revalidateOriginalWriteGrant(
      documentId,
      grantId,
      revision,
      observation.descriptor.scope,
      { manifestHash: observation.manifestHash, write: observedBinding },
      tx
    )
  );
  const source = checkboxAuthoritySync(readDocSourceDescriptor(deps, documentId, tx));
  if (JSON.stringify(source) !== JSON.stringify(observation.descriptor))
    throw new CheckboxAuthorityRefusal('SOURCE_DESCRIPTOR_CHANGED');
  const physical = tx
    .select()
    .from(canvasDocuments)
    .where(eq(canvasDocuments.id, documentId))
    .get();
  const channel = deps.store.getChannel(documentId, tx);
  if (
    !physical ||
    !channel ||
    channel.closedAt ||
    channel.documentId !== physical.id ||
    !Number.isFinite(Date.parse(physical.openedAt)) ||
    !Number.isFinite(Date.parse(channel.createdAt))
  )
    throw new CheckboxAuthorityRefusal('DOCUMENT_INCARNATION_CHANGED');
  const binding = checkboxSourceBinding(source, observation.canonicalPath);
  requireCheckboxOriginalOwner(deps, grantId, tx);
  // All configured clocks have run; final editor and actor checks use captured time.
  requireCheckboxEditor(deps, documentId, actor, tx, { grantId, time });
  if (actor) checkboxAuthoritySync(deps.authorization.requireCurrent(documentId, actor, true, tx));
  if (
    !grant.allowedTypes.some((type) => matchesCanvasChannelEvent(type, 'md.task.toggled')) ||
    !grant.routeId
  )
    throw new CheckboxAuthorityRefusal('CHECKBOX_ROUTE_REQUIRED');
  const route = declaredRoute(channel, grant.routeId);
  if (!matchesCanvasChannelEvent(route.on, 'md.task.toggled'))
    throw new CheckboxAuthorityRefusal('CHECKBOX_ROUTE_REQUIRED');
  return freezeCheckboxData(
    VerifiedCheckboxAuthoritySchema.parse({
      documentId,
      binding,
      grantId: grant.grantId,
      grantRevision: grant.revision,
      documentGeneration: checkboxDocumentGeneration(physical, channel),
      routeId: grant.routeId,
      routeHash: grant.routeHash,
    })
  );
}

/** The existing access-phase physical presence query; no configured callback or authority token. */
export function readCheckboxPhysicalId(
  tx: DbTransaction,
  documentId: string
): { id: string } | undefined {
  return tx
    .select({ id: canvasDocuments.id })
    .from(canvasDocuments)
    .where(eq(canvasDocuments.id, documentId))
    .get();
}
/** The existing conversion-phase label query; guard and result validation stay in the owning factory. */
export function readCheckboxPhysicalTitle(
  tx: DbTransaction,
  documentId: string
): { title: string } | undefined {
  return tx
    .select({ title: canvasDocuments.title })
    .from(canvasDocuments)
    .where(eq(canvasDocuments.id, documentId))
    .get();
}

/** Conservative typed reductions; unknown storage and recovery causes retain uncertainty. */
export function isCheckboxAuthorityRefusal(error: unknown): boolean {
  if (error instanceof CheckboxAuthorityRefusal || error instanceof DocChannelArchivedError)
    return true;
  if (error instanceof RoomError)
    return ['PEOPLE_ONLY', 'ROOM_ARCHIVED', 'ROOM_NOT_FOUND'].includes(error.code);
  return (
    error instanceof DocRouteGrantError &&
    [
      'GRANT_EVIDENCE_MISMATCH',
      'GRANT_BINDING_CHANGED',
      'DECLARATION_CHANGED',
      'TARGET_IDENTITY_CHANGED',
      'GRANT_NOT_FOUND',
      'GRANT_REVOKED',
      'GRANT_EXPIRED',
      'GRANT_REVISION_CHANGED',
      'GRANT_AUTHORITY_LOST',
      'APPROVAL_EVIDENCE_CHANGED',
      'APPROVAL_EVIDENCE_INVALID',
      'DECLARATION_HASH_MISMATCH',
      'MANIFEST_CHANGED',
      'WRITE_BINDING_MISMATCH',
      'TARGET_IDENTITY_MISMATCH',
      'TARGET_SCOPE_MISMATCH',
      'ORIGIN_AUTHORITY_LOST',
      'ROUTE_UNDECLARED',
      'ORIGINAL_WRITE_GRANT_REQUIRED',
    ].includes(error.code)
  );
}
