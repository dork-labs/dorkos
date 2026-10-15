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
