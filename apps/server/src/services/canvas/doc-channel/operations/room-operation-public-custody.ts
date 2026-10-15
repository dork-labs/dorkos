import * as custody from './room-operation-source-custody.js';
type WithoutOwner<T extends readonly unknown[]> = T extends readonly [object, ...infer Rest]
  ? Rest
  : never;
/** Original room-operation membership callable shapes without private selector. */
export interface OriginalRoomOperationPublicCustody {
  readOriginalRoomPendingWriteCount: (
    ...args: WithoutOwner<Parameters<typeof custody.readOriginalRoomPendingWriteCount>>
  ) => ReturnType<typeof custody.readOriginalRoomPendingWriteCount>;
  readOriginalRoomReplayAvailability: (
    ...args: WithoutOwner<Parameters<typeof custody.readOriginalRoomReplayAvailability>>
  ) => ReturnType<typeof custody.readOriginalRoomReplayAvailability>;
  requireOriginalRoomResponderOwner: (
    ...args: WithoutOwner<Parameters<typeof custody.requireOriginalRoomResponderOwner>>
  ) => ReturnType<typeof custody.requireOriginalRoomResponderOwner>;
  readOriginalRoomResponderFrozenSource: (
    ...args: WithoutOwner<Parameters<typeof custody.readOriginalRoomResponderFrozenSource>>
  ) => ReturnType<typeof custody.readOriginalRoomResponderFrozenSource>;
  readOriginalRoomOperatorSource: (
    ...args: WithoutOwner<Parameters<typeof custody.readOriginalRoomOperatorSource>>
  ) => ReturnType<typeof custody.readOriginalRoomOperatorSource>;
  readOriginalRoomTokenSource: (
    ...args: WithoutOwner<Parameters<typeof custody.readOriginalRoomTokenSource>>
  ) => ReturnType<typeof custody.readOriginalRoomTokenSource>;
  readOriginalFrozenRoomTarget: (
    ...args: WithoutOwner<Parameters<typeof custody.readOriginalFrozenRoomTarget>>
  ) => ReturnType<typeof custody.readOriginalFrozenRoomTarget>;
  requireOriginalRoomPrincipalService: (
    ...args: WithoutOwner<Parameters<typeof custody.requireOriginalRoomPrincipalService>>
  ) => ReturnType<typeof custody.requireOriginalRoomPrincipalService>;
}
/** Fixed public membership lookups; fake keys refuse in guarded source leaves. */
export function createOriginalRoomOperationPublicCustody(
  owner: object
): Readonly<OriginalRoomOperationPublicCustody> {
  return Object.freeze({
    readOriginalRoomPendingWriteCount: (
      ...args: WithoutOwner<Parameters<typeof custody.readOriginalRoomPendingWriteCount>>
    ) => custody.readOriginalRoomPendingWriteCount(owner, ...args),
    readOriginalRoomReplayAvailability: (
      ...args: WithoutOwner<Parameters<typeof custody.readOriginalRoomReplayAvailability>>
    ) => custody.readOriginalRoomReplayAvailability(owner, ...args),
    requireOriginalRoomResponderOwner: (
      ...args: WithoutOwner<Parameters<typeof custody.requireOriginalRoomResponderOwner>>
    ) => custody.requireOriginalRoomResponderOwner(owner, ...args),
    readOriginalRoomResponderFrozenSource: (
      ...args: WithoutOwner<Parameters<typeof custody.readOriginalRoomResponderFrozenSource>>
    ) => custody.readOriginalRoomResponderFrozenSource(owner, ...args),
    readOriginalRoomOperatorSource: (
      ...args: WithoutOwner<Parameters<typeof custody.readOriginalRoomOperatorSource>>
    ) => custody.readOriginalRoomOperatorSource(owner, ...args),
    readOriginalRoomTokenSource: (
      ...args: WithoutOwner<Parameters<typeof custody.readOriginalRoomTokenSource>>
    ) => custody.readOriginalRoomTokenSource(owner, ...args),
    readOriginalFrozenRoomTarget: (
      ...args: WithoutOwner<Parameters<typeof custody.readOriginalFrozenRoomTarget>>
    ) => custody.readOriginalFrozenRoomTarget(owner, ...args),
    requireOriginalRoomPrincipalService: (
      ...args: WithoutOwner<Parameters<typeof custody.requireOriginalRoomPrincipalService>>
    ) => custody.requireOriginalRoomPrincipalService(owner, ...args),
  });
}
