import { sameOriginalDocTokenData } from '../../tokens/token-native-comparison.js';
import { createOriginalDocTokenFileSourceReader } from '../../tokens/token-native-file-source.js';
import {
  authenticateOriginalDocTokenIssuance,
  verifyOriginalDocTokenNativeCapsule,
} from '../../../../core/auth/index.js';
import {
  encodeOriginalDocTokenIssuanceAuthentication,
  encodeOriginalDocTokenHeaderAuthentication,
} from '../../tokens/token-authentication-message.js';
import { createOriginalDocTokenNativeFactsReader } from '../../tokens/token-native-facts.js';
import { randomBytes, randomUUID, createHash } from 'node:crypto';
import {
  readOriginalDocTokenRevocationData,
  writeOriginalDocTokenRevocationInsideCurrent,
  writeOriginalDocTokenIssuanceInsideCurrent,
  readOriginalNativeDocTokenHeaderByHash,
  type OriginalStoredDocTokenData,
} from '../../tokens/token-store.js';
import { CanvasChannelTokenRequestSchema } from '@dorkos/shared/canvas-channel-schemas';
import { type DocChannelStore } from '../../store.js';
import { type DocChannelGrants } from '../../grants.js';
import { documentTransaction } from '../../storage/store-transaction.js';
import { copyCurrentDocData } from '../current-operation-data.js';
import {
  captureCurrentHttpDocActor,
  DocChannelNotFoundError,
  requireCurrentDocConstructorEngines,
  requireCurrentDocEngineOrigin,
  type DocChannelActor,
} from '../../authorization.js';
import { readOriginalTokenIssuanceFacet } from '../current-operation-engine.js';
/** Revoke the requested document token under the original actor and grant authority. */
export async function revokeToken(
  owner: object,
  store: DocChannelStore,
  grants: DocChannelGrants,
  rawActor: DocChannelActor,
  documentId: string,
  tokenId: string
) {
  const facet = readOriginalTokenIssuanceFacet(owner);
  const actor = captureCurrentHttpDocActor(rawActor);
  if (
    actor.principal.claims.kind !== 'operator' ||
    typeof documentId !== 'string' ||
    !documentId ||
    documentId.length > 200
  )
    throw new DocChannelNotFoundError();
  requireCurrentDocConstructorEngines(facet.authorization, store, undefined, grants);
  facet.retainTokenManifestOwner(grants, store);
  const captured = await facet.captureDocument(store, grants, documentId, actor, []);
  const source = facet.readDocumentAuthority(store, grants, captured.authority);
  const tokenStore = facet.originalTokenStore();
  const before = readOriginalDocTokenRevocationData(tokenStore, facet.db, tokenId);
  if (!before || before.documentId !== documentId) throw new DocChannelNotFoundError();
  const revokedAt =
    before.revokedAt ??
    Reflect.apply(
      facet.maintenanceIso,
      new facet.MaintenanceDate(Reflect.apply(facet.maintenanceNow, facet.MaintenanceDate, [])),
      []
    );
  return documentTransaction(facet.db, (tx) => {
    facet.beginCurrent(
      store,
      tx,
      documentId,
      source.actor,
      false,
      { expectedGeneration: source.data.generation },
      captured.authority
    );
    try {
      facet.finalCurrent(store, tx);
      const current = readOriginalDocTokenRevocationData(tokenStore, facet.db, tokenId);
      if (!sameOriginalDocTokenData(current, before)) throw new DocChannelNotFoundError();
      if (before.revokedAt === null) {
        const stage = Object.freeze({ kind: 'original-doc-token-revocation-stage' as const });
        const own = {
          db: facet.db,
          store: tokenStore,
          tx,
          active: true,
          consumed: false,
          data: Object.freeze({ ...before, revokedAt }),
          requireCurrent: () => {
            if (facet.roomPumpStopped) throw new DocChannelNotFoundError();
            facet.finalCurrent(store, tx);
            if (
              !sameOriginalDocTokenData(
                readOriginalDocTokenRevocationData(tokenStore, facet.db, tokenId),
                before
              )
            )
              throw new DocChannelNotFoundError();
          },
        };
        facet.originalTokenRevocations.set(stage, own);
        try {
          writeOriginalDocTokenRevocationInsideCurrent(stage, tokenStore, facet.db, tx);
        } finally {
          own.active = false;
        }
      }
      facet.finalCurrent(store, tx);
      const after = readOriginalDocTokenRevocationData(tokenStore, facet.db, tokenId);
      if (!sameOriginalDocTokenData(after, { ...before, revokedAt }))
        throw new DocChannelNotFoundError();
      return Object.freeze({ tokenId, revokedAt });
    } finally {
      facet.retireCurrent(tx);
    }
  });
}
/** Prepare document token issuance after the original request and source checks. */
export async function prepareTokenIssuance(
  engineOwner: object,
  store: DocChannelStore,
  grants: DocChannelGrants,
  rawActor: DocChannelActor,
  rawRequest: unknown,
  grantIds: readonly string[]
) {
  const facet = readOriginalTokenIssuanceFacet(engineOwner);
  const actor = captureCurrentHttpDocActor(rawActor);
  if (actor.principal.claims.kind !== 'operator') throw new DocChannelNotFoundError();
  const request = CanvasChannelTokenRequestSchema.parse(rawRequest);
  requireCurrentDocConstructorEngines(facet.authorization, store, undefined, grants);
  // Retain the actual constructor-owned manifest FD witness before the first dependency/manifest read.
  facet.retainTokenManifestOwner(grants, store);
  const fileSourceReader = (facet.tokenFileSourceReader ??= createOriginalDocTokenFileSourceReader(
    facet.db,
    facet.fixedPorts.originalRoomRepoStore
  ));
  const fileSource = fileSourceReader.observe(request.documentId);
  const captured = await facet.captureDocument(
    store,
    grants,
    request.documentId,
    actor,
    grantIds,
    undefined,
    fileSource
  );
  const own = facet.readDocumentAuthority(store, grants, captured.authority);
  const tokenStore = facet.originalTokenStore();
  const readNativeFacts = (facet.readTokenNativeFacts ??= createOriginalDocTokenNativeFactsReader(
    facet.db
  ));
  const nativeFacts = readNativeFacts(request.documentId);
  if (
    nativeFacts.physical.id !== captured.birth.physicalId ||
    nativeFacts.physical.opened_at !== captured.birth.openedAt ||
    nativeFacts.channel.document_id !== captured.birth.documentId ||
    nativeFacts.channel.created_at !== captured.birth.createdAt ||
    nativeFacts.channel.closed_at !== null
  )
    throw new DocChannelNotFoundError();
  const baseline = own.baseline as {
    channel: Record<string, unknown>;
    dependencies: { manifestHash: unknown; grants: unknown };
  };
  const claims = actor.principal.claims;
  const owner = claims.owner;
  if (owner.kind === 'user' ? nativeFacts.owner?.id !== owner.userId : nativeFacts.owner !== null)
    throw new DocChannelNotFoundError();
  const createdAt = Reflect.apply(
    facet.maintenanceIso,
    new facet.MaintenanceDate(Reflect.apply(facet.maintenanceNow, facet.MaintenanceDate, [])),
    []
  );
  if (
    Reflect.apply(facet.maintenanceParse, facet.MaintenanceDate, [request.expiresAt]) <=
      Reflect.apply(facet.maintenanceParse, facet.MaintenanceDate, [createdAt]) ||
    typeof baseline.channel.declarationHash !== 'string' ||
    (baseline.dependencies.manifestHash !== null &&
      typeof baseline.dependencies.manifestHash !== 'string')
  )
    throw new DocChannelNotFoundError();
  const token = 'dct_' + randomBytes(32).toString('base64url');
  const record = Object.freeze({
    tokenId: randomUUID(),
    tokenHash: createHash('sha256').update(token).digest('hex'),
    documentId: request.documentId,
    allowedTypes: Object.freeze([...request.allowedTypes]),
    directions: Object.freeze([...request.directions]),
    permissions: Object.freeze([...request.permissions]),
    creatorId: owner.kind === 'user' ? owner.userId : owner.installationId,
    createdAt,
    expiresAt: request.expiresAt,
    revokedAt: null,
  });
  const boundedJson = (value: unknown, limit: number) => {
    const encode = (item: unknown, depth: number): string => {
      if (depth > 32) throw new DocChannelNotFoundError();
      if (item === null) return 'null';
      if (
        typeof item === 'string' ||
        typeof item === 'boolean' ||
        (typeof item === 'number' && Number.isFinite(item))
      )
        return Reflect.apply(facet.tokenScalarJson, JSON, [item]);
      if (!item || typeof item !== 'object') throw new DocChannelNotFoundError();
      let text = Array.isArray(item) ? '[' : '{';
      const keys = Array.isArray(item)
        ? Array.from({ length: facet.tokenOwnDescriptor(item, 'length')!.value }, (_, index) =>
            String(index)
          )
        : facet.tokenOwnKeys(item);
      for (let index = 0; index < keys.length; index++) {
        const key = keys[index]!,
          field = facet.tokenOwnDescriptor(item, key);
        if (!field || !('value' in field)) throw new DocChannelNotFoundError();
        text +=
          (index ? ',' : '') +
          (Array.isArray(item) ? '' : Reflect.apply(facet.tokenScalarJson, JSON, [key]) + ':') +
          encode(field.value, depth + 1);
        if (Reflect.apply(facet.tokenUtf8Bytes, Buffer, [text]) > limit)
          throw new DocChannelNotFoundError();
      }
      return text + (Array.isArray(item) ? ']' : '}');
    };
    const json = encode(value, 0);
    if (Reflect.apply(facet.tokenUtf8Bytes, Buffer, [json]) > limit)
      throw new DocChannelNotFoundError();
    return json;
  };
  const data: OriginalStoredDocTokenData = Object.freeze({
    record,
    binding: Object.freeze({
      version: 1,
      scope: captured.scope,
      generation: captured.generation,
      birthJson: boundedJson(captured.birth, 4096),
      incarnationJson: boundedJson(own.baseline, 262144),
      declarationHash: baseline.channel.declarationHash,
      manifestHash: baseline.dependencies.manifestHash,
      approvedGrantsJson: boundedJson(baseline.dependencies.grants, 262144),
      issuerJson: boundedJson(
        {
          kind: 'original-native-doc-token-issuer-v1',
          owner: copyCurrentDocData(owner),
          grantIds: [...own.grantIds],
          nativeFacts,
          fileSource,
        },
        262144
      ),
    }),
  });
  const stage = Object.freeze({ kind: 'original-doc-token-issuance-stage' as const });
  facet.tokenStages.set(stage, {
    store,
    grants,
    authority: captured.authority,
    state: 'prepared',
    fileSource,
  });
  facet.originalTokenIssues.set(stage, {
    db: facet.db,
    tokenStore,
    consumed: false,
    data,
    unsignedData: data,
    requireCurrent: () => {
      requireCurrentDocEngineOrigin(facet.authorization, facet.core, facet.db);
      if (facet.roomPumpStopped) throw new DocChannelNotFoundError();
      const active = facet.originalTokenIssues.get(stage)?.activeTx;
      if (!active) throw new DocChannelNotFoundError();
      if (
        Reflect.apply(facet.maintenanceParse, facet.MaintenanceDate, [record.expiresAt]) <=
        Reflect.apply(facet.maintenanceNow, facet.MaintenanceDate, [])
      )
        throw new DocChannelNotFoundError();
      facet.finalCurrent(store, active);
      if (
        !sameOriginalDocTokenData(
          fileSource.policies,
          fileSourceReader.policies(request.documentId)
        )
      )
        throw new DocChannelNotFoundError();
      if (!sameOriginalDocTokenData(nativeFacts, readNativeFacts(request.documentId)))
        throw new DocChannelNotFoundError();
    },
  });
  return Object.freeze({ stage, token, record });
}
/** Commit only the original captured token issuance stage after currentness rechecks. */
export async function commitTokenIssuance(
  owner: object,
  stage: import('../current-operation-types.js').OriginalDocTokenIssuanceStage
) {
  const facet = readOriginalTokenIssuanceFacet(owner);
  const own = facet.tokenStages.get(stage),
    issue = facet.originalTokenIssues.get(stage);
  if (!own || !issue || own.state !== 'prepared' || issue.db !== facet.db)
    throw new DocChannelNotFoundError();
  own.state = 'committing';
  try {
    if (!facet.tokenFileSourceReader) throw new DocChannelNotFoundError();
    await facet.captureDocument(
      own.store,
      own.grants,
      issue.data.record.documentId,
      facet.readDocumentAuthority(own.store, own.grants, own.authority).actor,
      facet.readDocumentAuthority(own.store, own.grants, own.authority).grantIds,
      own.authority,
      facet.tokenFileSourceReader.observe(issue.data.record.documentId)
    );
    facet.originalTokenStore();
    if (
      !facet.tokenFileSourceReader ||
      !sameOriginalDocTokenData(
        own.fileSource,
        facet.tokenFileSourceReader.observe(issue.data.record.documentId)
      )
    )
      throw new DocChannelNotFoundError();
    documentTransaction(facet.db, (tx) => {
      const source = facet.readDocumentAuthority(own.store, own.grants, own.authority);
      facet.beginCurrent(
        own.store,
        tx,
        source.documentId,
        source.actor,
        false,
        { expectedGeneration: source.data.generation },
        own.authority
      );
      issue.activeTx = tx;
      try {
        if (
          Reflect.apply(facet.maintenanceParse, facet.MaintenanceDate, [
            issue.data.record.expiresAt,
          ]) <= Reflect.apply(facet.maintenanceNow, facet.MaintenanceDate, [])
        )
          throw new DocChannelNotFoundError();
        facet.finalCurrent(own.store, tx);
        const authenticatedIssuerJson = authenticateOriginalDocTokenIssuance(stage, facet.db, tx);
        issue.data = Object.freeze({
          record: issue.unsignedData.record,
          binding: Object.freeze({
            ...issue.unsignedData.binding,
            issuerJson: authenticatedIssuerJson,
          }),
        });
        writeOriginalDocTokenIssuanceInsideCurrent(stage, issue.tokenStore, facet.db, tx);
        facet.finalCurrent(own.store, tx);
        const retained = readOriginalNativeDocTokenHeaderByHash(
          issue.tokenStore,
          facet.db,
          issue.data.record.tokenHash
        );
        if (!retained) throw new DocChannelNotFoundError();
        const payload = verifyOriginalDocTokenNativeCapsule(facet.db, retained);
        if (
          payload !== issue.unsignedData.binding.issuerJson ||
          encodeOriginalDocTokenHeaderAuthentication(retained, payload) !==
            encodeOriginalDocTokenIssuanceAuthentication(issue.unsignedData)
        )
          throw new DocChannelNotFoundError();
        issue.requireCurrent();
      } finally {
        issue.activeTx = undefined;
        facet.retireCurrent(tx);
      }
    });
  } catch (cause) {
    if (
      (!facet.db.$client.open || facet.db.$client.inTransaction) &&
      !facet.tokenNativeCloseFailure
    )
      facet.tokenNativeCloseFailure = { cause };
    throw cause;
  } finally {
    own.state = 'retired';
    issue.activeTx = undefined;
  }
}
