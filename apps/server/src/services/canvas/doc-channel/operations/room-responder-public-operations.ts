import type { Db } from '@dorkos/db';
import type {
  OriginalCommittedRoomResponder,
  PreparedRoomResponder,
} from '../current/current-operation-types.js';
import {
  isServerPrincipal,
  type ServerPrincipalProof,
} from '../../../connectors/principal/server-principal.js';
import {
  isOriginalResolvedRuntimePrincipal,
  resolveOriginalNativePrincipal,
  type ConnectorRuntimePrincipalService,
} from '../../../connectors/principal/runtime-principal-service.js';
import {
  readOriginalRoomResponderCustodyView,
  readOriginalRoomResponderCommitView,
} from './room-responder-operation.js';
import * as custody from './room-responder-emission-custody.js';
type WithoutOwner<T extends readonly unknown[]> = T extends readonly [object, ...infer Rest]
  ? Rest
  : never;
/** Original public emission custody signatures; only the private selector is omitted. */
export interface OriginalRoomResponderPublicOperations {
  prepareOriginalRoomResponderEmission: (
    ...args: WithoutOwner<Parameters<typeof custody.prepareOriginalRoomResponderEmission>>
  ) => ReturnType<typeof custody.prepareOriginalRoomResponderEmission>;
  refreshOriginalRoomEmissionStage: (
    ...args: WithoutOwner<Parameters<typeof custody.refreshOriginalRoomEmissionStage>>
  ) => ReturnType<typeof custody.refreshOriginalRoomEmissionStage>;
  requireOriginalRoomEmissionTransaction: (
    ...args: WithoutOwner<Parameters<typeof custody.requireOriginalRoomEmissionTransaction>>
  ) => ReturnType<typeof custody.requireOriginalRoomEmissionTransaction>;
  requireOriginalRoomEmissionFrameTransaction: (
    ...args: WithoutOwner<Parameters<typeof custody.requireOriginalRoomEmissionFrameTransaction>>
  ) => ReturnType<typeof custody.requireOriginalRoomEmissionFrameTransaction>;
  readOriginalRoomEmissionRuntimeBindingRow: (
    ...args: WithoutOwner<Parameters<typeof custody.readOriginalRoomEmissionRuntimeBindingRow>>
  ) => ReturnType<typeof custody.readOriginalRoomEmissionRuntimeBindingRow>;
  readOriginalRoomEmissionTargetBindingRow: (
    ...args: WithoutOwner<Parameters<typeof custody.readOriginalRoomEmissionTargetBindingRow>>
  ) => ReturnType<typeof custody.readOriginalRoomEmissionTargetBindingRow>;
  executeOriginalRoomResponderEmission: (
    ...args: WithoutOwner<Parameters<typeof custody.executeOriginalRoomResponderEmission>>
  ) => ReturnType<typeof custody.executeOriginalRoomResponderEmission>;
  requireOriginalRoomEmissionStageClosed: (
    ...args: WithoutOwner<Parameters<typeof custody.requireOriginalRoomEmissionStageClosed>>
  ) => ReturnType<typeof custody.requireOriginalRoomEmissionStageClosed>;
  requireOriginalRoomEmissionPrincipalPort: (
    ...args: WithoutOwner<Parameters<typeof custody.requireOriginalRoomEmissionPrincipalPort>>
  ) => ReturnType<typeof custody.requireOriginalRoomEmissionPrincipalPort>;
  readOriginalRoomEmissionPrincipal: (
    ...args: WithoutOwner<Parameters<typeof custody.readOriginalRoomEmissionPrincipal>>
  ) => ReturnType<typeof custody.readOriginalRoomEmissionPrincipal>;
  readOriginalRoomEmissionSource: (
    ...args: WithoutOwner<Parameters<typeof custody.readOriginalRoomEmissionSource>>
  ) => ReturnType<typeof custody.readOriginalRoomEmissionSource>;
  retireOriginalRoomEmissionStage: (
    ...args: WithoutOwner<Parameters<typeof custody.retireOriginalRoomEmissionStage>>
  ) => ReturnType<typeof custody.retireOriginalRoomEmissionStage>;
  requireOriginalCommittedRoomResponder: (
    ...args: WithoutOwner<Parameters<typeof custody.requireOriginalCommittedRoomResponder>>
  ) => ReturnType<typeof custody.requireOriginalCommittedRoomResponder>;
  requireCurrentOriginalCommittedRoomResponder: (
    ...args: WithoutOwner<Parameters<typeof custody.requireCurrentOriginalCommittedRoomResponder>>
  ) => ReturnType<typeof custody.requireCurrentOriginalCommittedRoomResponder>;
  consumeOriginalCommittedRoomResponder: (
    ...args: WithoutOwner<Parameters<typeof custody.consumeOriginalCommittedRoomResponder>>
  ) => ReturnType<typeof custody.consumeOriginalCommittedRoomResponder>;
  retireOriginalCommittedRoomResponder: (
    ...args: WithoutOwner<Parameters<typeof custody.retireOriginalCommittedRoomResponder>>
  ) => ReturnType<typeof custody.retireOriginalCommittedRoomResponder>;
  observeOriginalRoomResponderProjection: (
    ...args: WithoutOwner<Parameters<typeof custody.observeOriginalRoomResponderProjection>>
  ) => ReturnType<typeof custody.observeOriginalRoomResponderProjection>;
  settleOriginalRoomResponderProjection: (
    ...args: WithoutOwner<Parameters<typeof custody.settleOriginalRoomResponderProjection>>
  ) => ReturnType<typeof custody.settleOriginalRoomResponderProjection>;
}
/** Fixed forwarding operations; unrelated keys refuse in every custody leaf. */
export function createOriginalRoomResponderPublicOperations(
  owner: object
): Readonly<OriginalRoomResponderPublicOperations> {
  return Object.freeze({
    prepareOriginalRoomResponderEmission: (
      ...args: WithoutOwner<Parameters<typeof custody.prepareOriginalRoomResponderEmission>>
    ) => custody.prepareOriginalRoomResponderEmission(owner, ...args),
    refreshOriginalRoomEmissionStage: (
      ...args: WithoutOwner<Parameters<typeof custody.refreshOriginalRoomEmissionStage>>
    ) => custody.refreshOriginalRoomEmissionStage(owner, ...args),
    requireOriginalRoomEmissionTransaction: (
      ...args: WithoutOwner<Parameters<typeof custody.requireOriginalRoomEmissionTransaction>>
    ) => custody.requireOriginalRoomEmissionTransaction(owner, ...args),
    requireOriginalRoomEmissionFrameTransaction: (
      ...args: WithoutOwner<Parameters<typeof custody.requireOriginalRoomEmissionFrameTransaction>>
    ) => custody.requireOriginalRoomEmissionFrameTransaction(owner, ...args),
    readOriginalRoomEmissionRuntimeBindingRow: (
      ...args: WithoutOwner<Parameters<typeof custody.readOriginalRoomEmissionRuntimeBindingRow>>
    ) => custody.readOriginalRoomEmissionRuntimeBindingRow(owner, ...args),
    readOriginalRoomEmissionTargetBindingRow: (
      ...args: WithoutOwner<Parameters<typeof custody.readOriginalRoomEmissionTargetBindingRow>>
    ) => custody.readOriginalRoomEmissionTargetBindingRow(owner, ...args),
    executeOriginalRoomResponderEmission: (
      ...args: WithoutOwner<Parameters<typeof custody.executeOriginalRoomResponderEmission>>
    ) => custody.executeOriginalRoomResponderEmission(owner, ...args),
    requireOriginalRoomEmissionStageClosed: (
      ...args: WithoutOwner<Parameters<typeof custody.requireOriginalRoomEmissionStageClosed>>
    ) => custody.requireOriginalRoomEmissionStageClosed(owner, ...args),
    requireOriginalRoomEmissionPrincipalPort: (
      ...args: WithoutOwner<Parameters<typeof custody.requireOriginalRoomEmissionPrincipalPort>>
    ) => custody.requireOriginalRoomEmissionPrincipalPort(owner, ...args),
    readOriginalRoomEmissionPrincipal: (
      ...args: WithoutOwner<Parameters<typeof custody.readOriginalRoomEmissionPrincipal>>
    ) => custody.readOriginalRoomEmissionPrincipal(owner, ...args),
    readOriginalRoomEmissionSource: (
      ...args: WithoutOwner<Parameters<typeof custody.readOriginalRoomEmissionSource>>
    ) => custody.readOriginalRoomEmissionSource(owner, ...args),
    retireOriginalRoomEmissionStage: (
      ...args: WithoutOwner<Parameters<typeof custody.retireOriginalRoomEmissionStage>>
    ) => custody.retireOriginalRoomEmissionStage(owner, ...args),
    requireOriginalCommittedRoomResponder: (
      ...args: WithoutOwner<Parameters<typeof custody.requireOriginalCommittedRoomResponder>>
    ) => custody.requireOriginalCommittedRoomResponder(owner, ...args),
    requireCurrentOriginalCommittedRoomResponder: (
      ...args: WithoutOwner<Parameters<typeof custody.requireCurrentOriginalCommittedRoomResponder>>
    ) => custody.requireCurrentOriginalCommittedRoomResponder(owner, ...args),
    consumeOriginalCommittedRoomResponder: (
      ...args: WithoutOwner<Parameters<typeof custody.consumeOriginalCommittedRoomResponder>>
    ) => custody.consumeOriginalCommittedRoomResponder(owner, ...args),
    retireOriginalCommittedRoomResponder: (
      ...args: WithoutOwner<Parameters<typeof custody.retireOriginalCommittedRoomResponder>>
    ) => custody.retireOriginalCommittedRoomResponder(owner, ...args),
    observeOriginalRoomResponderProjection: (
      ...args: WithoutOwner<Parameters<typeof custody.observeOriginalRoomResponderProjection>>
    ) => custody.observeOriginalRoomResponderProjection(owner, ...args),
    settleOriginalRoomResponderProjection: (
      ...args: WithoutOwner<Parameters<typeof custody.settleOriginalRoomResponderProjection>>
    ) => custody.settleOriginalRoomResponderProjection(owner, ...args),
  });
}

/** Original committed responder correlation DATA; copied tuples never establish private custody. */
export interface RoomCapabilityResponder {
  token: OriginalCommittedRoomResponder;
  runtime: object;
  prepared: PreparedRoomResponder;
  operation: object;
  documentId: string;
  batchId: string;
  principals: ConnectorRuntimePrincipalService;
}
/** Allocate unrelated capability lookup custody; only Main's private module retains its real instance. */
export function createIsolatedRoomCapabilityResponderCustody(custodyOwner: object) {
  const capabilityResponders = new WeakMap<Db, Set<RoomCapabilityResponder>>();
  const preparedCapabilityResponders = new WeakMap<
    PreparedRoomResponder,
    RoomCapabilityResponder
  >();
  function register(
    commitOwner: object,
    token: OriginalCommittedRoomResponder,
    runtime: object,
    prepared: PreparedRoomResponder
  ): void {
    const facet = readOriginalRoomResponderCommitView(commitOwner);
    const own = facet.readPrepared(runtime, prepared);
    runtime = own.runtime;
    const committed =
      readOriginalRoomResponderCustodyView(custodyOwner).committedRoomResponders.get(token);
    if (
      !committed ||
      committed.runtime !== runtime ||
      committed.prepared !== prepared ||
      committed.operation !== own.nativeOperation ||
      preparedCapabilityResponders.has(prepared)
    )
      throw new Error('Original committed capability responder custody required.');
    const responder: RoomCapabilityResponder = {
      token,
      runtime,
      prepared,
      operation: own.nativeOperation,
      documentId: own.own.source.documentId,
      batchId: own.own.source.batchId,
      principals: facet.principals,
    };
    const responders = capabilityResponders.get(facet.db) ?? new Set<RoomCapabilityResponder>();
    capabilityResponders.set(facet.db, responders);
    responders.add(responder);
    preparedCapabilityResponders.set(prepared, responder);
  }
  function retire(db: Db, prepared: PreparedRoomResponder): void {
    const responder = preparedCapabilityResponders.get(prepared);
    if (responder) capabilityResponders.get(db)?.delete(responder);
    preparedCapabilityResponders.delete(prepared);
  }
  /** Recheck exact original committed/prepared custody around awaited native work. */
  async function resolve(
    db: Db,
    principal: ServerPrincipalProof,
    selection: Readonly<{ documentId: string; batchId: string }>
  ): Promise<RoomCapabilityResponder | undefined> {
    const facet = readOriginalRoomResponderCustodyView(custodyOwner);
    if (!isServerPrincipal(principal) || principal.claims.kind !== 'runtime') return undefined;
    const claims = principal.claims;
    for (const responder of capabilityResponders.get(db) ?? []) {
      const committed = facet.committedRoomResponders.get(responder.token);
      if (
        !isOriginalResolvedRuntimePrincipal(responder.principals, principal) ||
        responder.documentId !== selection.documentId ||
        responder.batchId !== selection.batchId ||
        committed?.consumed !== true ||
        preparedCapabilityResponders.get(responder.prepared) !== responder
      )
        continue;
      committed.requireCurrent();
      const resolved = await resolveOriginalNativePrincipal(
        responder.principals,
        responder.operation
      );
      if (resolved.status !== 'resolved' || resolved.principal.claims.kind !== 'runtime') continue;
      const current = resolved.principal.claims;
      if (
        current.bindingId !== claims.bindingId ||
        current.agentId !== claims.agentId ||
        current.runtime !== claims.runtime ||
        current.canonicalSessionId !== claims.canonicalSessionId ||
        current.agentPath !== claims.agentPath ||
        preparedCapabilityResponders.get(responder.prepared) !== responder ||
        facet.committedRoomResponders.get(responder.token) !== committed ||
        committed.consumed !== true
      )
        continue;
      committed.requireCurrent();
      if (
        preparedCapabilityResponders.get(responder.prepared) !== responder ||
        facet.committedRoomResponders.get(responder.token) !== committed ||
        committed.consumed !== true
      )
        continue;
      return responder;
    }
    return undefined;
  }
  return Object.freeze({ register, retire, resolve });
}
