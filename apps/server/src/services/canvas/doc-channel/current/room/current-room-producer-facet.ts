import { requireServiceOriginalTokenDependencies } from '../../service.js';
import {
  readOriginalRoomTokenSource,
  readOriginalRoomOperatorSource,
} from '../../operations/room-current-operation.js';
import { sql, type DbTransaction } from '@dorkos/db';
import { type DocChannelStore } from '../../store.js';
import { checkboxAuthoritySync } from '../../writes/authority/authority-snapshot.js';
import { copyCurrentDocData, sameCurrentDocData } from '../current-operation-data.js';
import { readCurrentDocIngressInput, DocChannelNotFoundError } from '../../authorization.js';
import { readOriginalRoomProducerFacet } from '../current-operation-engine.js';
/** Read the durable original Room operator source rows for the captured document and key. */
export function operatorRows(
  owner: object,
  documentId: string,
  roomId: string,
  key: string,
  tx?: DbTransaction
) {
  const facet = readOriginalRoomProducerFacet(owner);
  // Only the recognized emission lane supplies its generated query facade.
  // Every invocation reads the same complete original source rows afresh.
  if (tx)
    return tx.get<
      Record<string, unknown>
    >(sql`SELECT a.id AS operatorAuthorId,a.natural_key AS operatorNaturalKey,
      a.linked_owner_key AS operatorLinkedOwnerKey,d.author_id AS authorId,d.opened_at AS openedAt,
      c.created_at AS channelCreatedAt,c.opener_agent_id AS openerAgentId,
      c.declaration_hash AS declarationHash,c.manifest_hash AS manifestHash
      FROM main.authors a JOIN main.room_members m ON m.author_id=a.id
      JOIN main.canvas_documents d ON d.id=${documentId} JOIN main.canvas_doc_channels c ON c.document_id=d.id
      WHERE a.kind='human' AND a.natural_key=${key} AND a.retired_at IS NULL AND m.room_id=${roomId}
      AND d.scope=${`room:${roomId}`} AND d.room_id=${roomId} AND c.closed_at IS NULL`);
  return facet
    .nativePrepare(
      `SELECT a.id AS operatorAuthorId,a.natural_key AS operatorNaturalKey,
      a.linked_owner_key AS operatorLinkedOwnerKey,d.author_id AS authorId,d.opened_at AS openedAt,
      c.created_at AS channelCreatedAt,c.opener_agent_id AS openerAgentId,
      c.declaration_hash AS declarationHash,c.manifest_hash AS manifestHash
      FROM main.authors a JOIN main.room_members m ON m.author_id=a.id
      JOIN main.canvas_documents d ON d.id=? JOIN main.canvas_doc_channels c ON c.document_id=d.id
      WHERE a.kind='human' AND a.natural_key=? AND a.retired_at IS NULL AND m.room_id=?
      AND d.scope=? AND d.room_id=? AND c.closed_at IS NULL`
    )
    .get(documentId, key, roomId, `room:${roomId}`, roomId) as Record<string, unknown> | undefined;
}
/** Require the original durable rows for the captured Room producer. */
export function requireOperatorRows(
  engineOwner: object,
  producer:
    | import('../current-operation-types.js').OriginalRoomOperatorProducer
    | import('../current-operation-types.js').OriginalRoomTokenProducer,
  tx?: DbTransaction
): void {
  const facet = readOriginalRoomProducerFacet(engineOwner);
  const owner = tx
    ? tx.get<{ id: string }>(sql`SELECT id FROM main.user ORDER BY created_at ASC LIMIT 1`)
    : (facet.nativePrepare('SELECT id FROM main.user ORDER BY created_at ASC LIMIT 1').get() as
        { id: string } | undefined);
  if (producer.owner.kind === 'user' ? owner?.id !== producer.owner.userId : owner !== undefined)
    throw new DocChannelNotFoundError();
  const row = facet.operatorRows(
    producer.birth.documentId,
    producer.birth.roomId,
    producer.operatorNaturalKey,
    tx
  );
  const expected = {
    operatorAuthorId: producer.operatorAuthorId,
    operatorNaturalKey: producer.operatorNaturalKey,
    operatorLinkedOwnerKey: producer.operatorLinkedOwnerKey,
    authorId: producer.birth.authorId,
    openedAt: producer.birth.openedAt,
    channelCreatedAt: producer.birth.channelCreatedAt,
    openerAgentId: producer.birth.openerAgentId,
    declarationHash: producer.birth.declarationHash,
    manifestHash: producer.birth.manifestHash,
  };
  if (!sameCurrentDocData(row, expected)) throw new DocChannelNotFoundError();
}
/** Capture an original operator producer from the current document transaction. */
export function captureRoomOperatorProducer(
  owner: object,
  store: DocChannelStore,
  tx: DbTransaction
) {
  const facet = readOriginalRoomProducerFacet(owner);
  const input = readCurrentDocIngressInput(facet.authorization, store, tx);
  if (!input.actor || input.tokenScope) throw new DocChannelNotFoundError();
  const claims = input.actor.principal.claims;
  if (claims.kind !== 'operator' || !input.scope.startsWith('room:'))
    throw new DocChannelNotFoundError();
  facet.fixedCurrent(input.documentId, input.actor, true, tx, true);
  const roomId = input.scope.slice(5),
    key = claims.owner.kind === 'user' ? `user:${claims.owner.userId}` : 'local';
  const row = facet.operatorRows(input.documentId, roomId, key);
  if (!row) throw new DocChannelNotFoundError();
  const producer = copyCurrentDocData({
    kind: 'operator' as const,
    owner: claims.owner,
    operatorAuthorId: row.operatorAuthorId,
    operatorNaturalKey: row.operatorNaturalKey,
    operatorLinkedOwnerKey: row.operatorLinkedOwnerKey,
    birth: {
      documentId: input.documentId,
      scope: input.scope,
      roomId,
      authorId: row.authorId,
      openedAt: row.openedAt,
      channelCreatedAt: row.channelCreatedAt,
      openerAgentId: row.openerAgentId,
      declarationHash: row.declarationHash,
      manifestHash: row.manifestHash,
    },
  }) as import('../current-operation-types.js').OriginalRoomOperatorProducer;
  const finalInput = readCurrentDocIngressInput(facet.authorization, store, tx);
  if (
    finalInput.actor !== input.actor ||
    finalInput.event !== input.event ||
    finalInput.documentId !== input.documentId ||
    finalInput.scope !== input.scope
  )
    throw new DocChannelNotFoundError();
  facet.requireOperatorRows(producer);
  return Object.freeze(producer);
}
/** Capture an original token producer from the current document transaction. */
export function captureRoomTokenProducer(
  engineOwner: object,
  store: DocChannelStore,
  tx: DbTransaction
) {
  const facet = readOriginalRoomProducerFacet(engineOwner);
  const input = readCurrentDocIngressInput(facet.authorization, store, tx);
  if (input.actor || !input.tokenScope || !input.scope.startsWith('room:'))
    throw new DocChannelNotFoundError();
  facet.finalCurrent(store, tx);
  const own = facet.restoredTokens.get(input.tokenScope)!;
  const { header, data } = facet.tokenNativeCurrent(own),
    owner = data.owner;
  const roomId = input.scope.slice(5),
    key = owner.kind === 'user' ? `user:${owner.userId}` : 'local';
  const row = facet.operatorRows(input.documentId, roomId, key);
  if (!row) throw new DocChannelNotFoundError();
  const producer = copyCurrentDocData({
    kind: 'doc_token' as const,
    owner,
    tokenId: header.tokenId,
    tokenHash: header.tokenHash,
    tokenCreatedAt: header.createdAt,
    tokenExpiresAt: header.expiresAt,
    tokenIssuerJson: header.issuerJson,
    operatorAuthorId: row.operatorAuthorId,
    operatorNaturalKey: row.operatorNaturalKey,
    operatorLinkedOwnerKey: row.operatorLinkedOwnerKey,
    birth: {
      documentId: input.documentId,
      scope: input.scope,
      roomId,
      authorId: row.authorId,
      openedAt: row.openedAt,
      channelCreatedAt: row.channelCreatedAt,
      openerAgentId: row.openerAgentId,
      declarationHash: row.declarationHash,
      manifestHash: row.manifestHash,
    },
  }) as import('../current-operation-types.js').OriginalRoomTokenProducer;
  facet.finalCurrent(store, tx);
  return Object.freeze(producer);
}
/** Recheck the original durable Room token source and captured service dependencies. */
export function requireRoomTokenSource(owner: object, token: object): void {
  const facet = readOriginalRoomProducerFacet(owner);
  const own = readOriginalRoomTokenSource(token, facet.core, facet.db),
    dependencies = facet.tokenSourceDependencies;
  if (!dependencies || facet.db.$client.inTransaction) throw new DocChannelNotFoundError();
  requireServiceOriginalTokenDependencies(
    dependencies.service,
    facet.authorization,
    dependencies.store,
    dependencies.grants
  );
  facet.retainTokenManifestOwner(dependencies.grants, dependencies.store);
  facet.initializeTokenReaders();
  const current = facet.prepareTokenNativeRead({ ...dependencies, hash: own.producer.tokenHash });
  if (
    current.header.tokenId !== own.producer.tokenId ||
    current.header.issuerJson !== own.producer.tokenIssuerJson ||
    current.header.createdAt !== own.producer.tokenCreatedAt ||
    current.header.expiresAt !== own.producer.tokenExpiresAt ||
    current.header.documentId !== own.source.documentId
  )
    throw new DocChannelNotFoundError();
  const final = readOriginalRoomTokenSource(token, facet.core, facet.db);
  if (!sameCurrentDocData(final, own)) throw new DocChannelNotFoundError();
  facet.requireOperatorRows(own.producer);
}
/** Recheck the original durable Room operator source without renewing HTTP authority. */
export function requireRoomOperatorSource(owner: object, token: object): void {
  const facet = readOriginalRoomProducerFacet(owner);
  const own = readOriginalRoomOperatorSource(token, facet.core, facet.db),
    producer = own.producer;
  // Durable native source custody outlives its original HTTP request, without reopening that request principal.
  const claims = { kind: 'operator' as const, owner: producer.owner };
  if (
    checkboxAuthoritySync(facet.fixedPorts.ownsInstallation(claims)) !== true ||
    !checkboxAuthoritySync(facet.fixedPorts.roomMembership(own.source.roomId, claims))
  )
    throw new DocChannelNotFoundError();
  const final = readOriginalRoomOperatorSource(token, facet.core, facet.db);
  if (!sameCurrentDocData(final, own)) throw new DocChannelNotFoundError();
  facet.requireOperatorRows(producer); // Fixed native tail, after every observable owner/member callback.
}
