import * as lifetime0 from './http-file-request-lifetime.js';
import * as lifetime1 from './http-room-file-request-lifetime.js';
import * as lifetime2 from './http-room-session-placement.js';
import * as lifetime3 from './http-room-repo-request-lifetime.js';
type WithoutCustodyOwner<T extends readonly unknown[]> = T extends readonly [object, ...infer Rest]
  ? Rest
  : never;
/** Original public HTTP request operation signatures; private custody argument is omitted. */
export interface OriginalHttpRequestOperations {
  requireOriginalHttpRoomReconcilerOwner: (
    ...args: WithoutCustodyOwner<
      Parameters<typeof lifetime0.requireOriginalHttpRoomReconcilerOwner>
    >
  ) => ReturnType<typeof lifetime0.requireOriginalHttpRoomReconcilerOwner>;
  requireOriginalHttpRoomReconcilerAdmission: (
    ...args: WithoutCustodyOwner<
      Parameters<typeof lifetime0.requireOriginalHttpRoomReconcilerAdmission>
    >
  ) => ReturnType<typeof lifetime0.requireOriginalHttpRoomReconcilerAdmission>;
  requireOriginalHttpRoomWorktreeOwner: (
    ...args: WithoutCustodyOwner<Parameters<typeof lifetime0.requireOriginalHttpRoomWorktreeOwner>>
  ) => ReturnType<typeof lifetime0.requireOriginalHttpRoomWorktreeOwner>;
  requireOriginalHttpRoomWorktreeAdmission: (
    ...args: WithoutCustodyOwner<
      Parameters<typeof lifetime0.requireOriginalHttpRoomWorktreeAdmission>
    >
  ) => ReturnType<typeof lifetime0.requireOriginalHttpRoomWorktreeAdmission>;
  captureDocHttpFileWriteCaller: (
    ...args: WithoutCustodyOwner<Parameters<typeof lifetime0.captureDocHttpFileWriteCaller>>
  ) => ReturnType<typeof lifetime0.captureDocHttpFileWriteCaller>;
  requireDocHttpFileWriteCurrent: (
    ...args: WithoutCustodyOwner<Parameters<typeof lifetime0.requireDocHttpFileWriteCurrent>>
  ) => ReturnType<typeof lifetime0.requireDocHttpFileWriteCurrent>;
  retireDocHttpFileWriteCaller: (
    ...args: WithoutCustodyOwner<Parameters<typeof lifetime0.retireDocHttpFileWriteCaller>>
  ) => ReturnType<typeof lifetime0.retireDocHttpFileWriteCaller>;
  captureDocHttpRoomFileWriteCaller: (
    ...args: WithoutCustodyOwner<Parameters<typeof lifetime1.captureDocHttpRoomFileWriteCaller>>
  ) => ReturnType<typeof lifetime1.captureDocHttpRoomFileWriteCaller>;
  checkDocHttpRoomFileWriteCurrent: (
    ...args: WithoutCustodyOwner<Parameters<typeof lifetime1.checkDocHttpRoomFileWriteCurrent>>
  ) => ReturnType<typeof lifetime1.checkDocHttpRoomFileWriteCurrent>;
  requireDocHttpRoomFileWriteCurrent: (
    ...args: WithoutCustodyOwner<Parameters<typeof lifetime1.requireDocHttpRoomFileWriteCurrent>>
  ) => ReturnType<typeof lifetime1.requireDocHttpRoomFileWriteCurrent>;
  readDocHttpRoomFileWriteAttribution: (
    ...args: WithoutCustodyOwner<Parameters<typeof lifetime1.readDocHttpRoomFileWriteAttribution>>
  ) => ReturnType<typeof lifetime1.readDocHttpRoomFileWriteAttribution>;
  originalHttpRoomSessionPlacementRefusal: (
    ...args: WithoutCustodyOwner<
      Parameters<typeof lifetime1.originalHttpRoomSessionPlacementRefusal>
    >
  ) => ReturnType<typeof lifetime1.originalHttpRoomSessionPlacementRefusal>;
  readOriginalHttpRoomSessionPlacement: (
    ...args: WithoutCustodyOwner<Parameters<typeof lifetime2.readOriginalHttpRoomSessionPlacement>>
  ) => ReturnType<typeof lifetime2.readOriginalHttpRoomSessionPlacement>;
  checkOriginalHttpRoomSessionPlacement: (
    ...args: WithoutCustodyOwner<Parameters<typeof lifetime2.checkOriginalHttpRoomSessionPlacement>>
  ) => ReturnType<typeof lifetime2.checkOriginalHttpRoomSessionPlacement>;
  captureOriginalHttpRoomSessionPlacement: (
    ...args: WithoutCustodyOwner<
      Parameters<typeof lifetime2.captureOriginalHttpRoomSessionPlacement>
    >
  ) => ReturnType<typeof lifetime2.captureOriginalHttpRoomSessionPlacement>;
  retireDocHttpRoomFileWriteCaller: (
    ...args: WithoutCustodyOwner<Parameters<typeof lifetime2.retireDocHttpRoomFileWriteCaller>>
  ) => ReturnType<typeof lifetime2.retireDocHttpRoomFileWriteCaller>;
  captureDocHttpRoomRepoCaller: (
    ...args: WithoutCustodyOwner<Parameters<typeof lifetime3.captureDocHttpRoomRepoCaller>>
  ) => ReturnType<typeof lifetime3.captureDocHttpRoomRepoCaller>;
  checkDocHttpRoomRepoCaller: (
    ...args: WithoutCustodyOwner<Parameters<typeof lifetime3.checkDocHttpRoomRepoCaller>>
  ) => ReturnType<typeof lifetime3.checkDocHttpRoomRepoCaller>;
  requireDocHttpRoomRepoCaller: (
    ...args: WithoutCustodyOwner<Parameters<typeof lifetime3.requireDocHttpRoomRepoCaller>>
  ) => ReturnType<typeof lifetime3.requireDocHttpRoomRepoCaller>;
  readDocHttpRoomRepoCaller: (
    ...args: WithoutCustodyOwner<Parameters<typeof lifetime3.readDocHttpRoomRepoCaller>>
  ) => ReturnType<typeof lifetime3.readDocHttpRoomRepoCaller>;
  retireDocHttpRoomRepoCaller: (
    ...args: WithoutCustodyOwner<Parameters<typeof lifetime3.retireDocHttpRoomRepoCaller>>
  ) => ReturnType<typeof lifetime3.retireDocHttpRoomRepoCaller>;
}
/** Capture a private selector in fixed public operations; fake selectors still refuse in every leaf. */
export function createOriginalHttpRequestOperations(
  httpCustodyKey: object
): Readonly<OriginalHttpRequestOperations> {
  return Object.freeze({
    requireOriginalHttpRoomReconcilerOwner: (
      ...args: WithoutCustodyOwner<
        Parameters<typeof lifetime0.requireOriginalHttpRoomReconcilerOwner>
      >
    ) => lifetime0.requireOriginalHttpRoomReconcilerOwner(httpCustodyKey, ...args),
    requireOriginalHttpRoomReconcilerAdmission: (
      ...args: WithoutCustodyOwner<
        Parameters<typeof lifetime0.requireOriginalHttpRoomReconcilerAdmission>
      >
    ) => lifetime0.requireOriginalHttpRoomReconcilerAdmission(httpCustodyKey, ...args),
    requireOriginalHttpRoomWorktreeOwner: (
      ...args: WithoutCustodyOwner<
        Parameters<typeof lifetime0.requireOriginalHttpRoomWorktreeOwner>
      >
    ) => lifetime0.requireOriginalHttpRoomWorktreeOwner(httpCustodyKey, ...args),
    requireOriginalHttpRoomWorktreeAdmission: (
      ...args: WithoutCustodyOwner<
        Parameters<typeof lifetime0.requireOriginalHttpRoomWorktreeAdmission>
      >
    ) => lifetime0.requireOriginalHttpRoomWorktreeAdmission(httpCustodyKey, ...args),
    captureDocHttpFileWriteCaller: (
      ...args: WithoutCustodyOwner<Parameters<typeof lifetime0.captureDocHttpFileWriteCaller>>
    ) => lifetime0.captureDocHttpFileWriteCaller(httpCustodyKey, ...args),
    requireDocHttpFileWriteCurrent: (
      ...args: WithoutCustodyOwner<Parameters<typeof lifetime0.requireDocHttpFileWriteCurrent>>
    ) => lifetime0.requireDocHttpFileWriteCurrent(httpCustodyKey, ...args),
    retireDocHttpFileWriteCaller: (
      ...args: WithoutCustodyOwner<Parameters<typeof lifetime0.retireDocHttpFileWriteCaller>>
    ) => lifetime0.retireDocHttpFileWriteCaller(httpCustodyKey, ...args),
    captureDocHttpRoomFileWriteCaller: (
      ...args: WithoutCustodyOwner<Parameters<typeof lifetime1.captureDocHttpRoomFileWriteCaller>>
    ) => lifetime1.captureDocHttpRoomFileWriteCaller(httpCustodyKey, ...args),
    checkDocHttpRoomFileWriteCurrent: (
      ...args: WithoutCustodyOwner<Parameters<typeof lifetime1.checkDocHttpRoomFileWriteCurrent>>
    ) => lifetime1.checkDocHttpRoomFileWriteCurrent(httpCustodyKey, ...args),
    requireDocHttpRoomFileWriteCurrent: (
      ...args: WithoutCustodyOwner<Parameters<typeof lifetime1.requireDocHttpRoomFileWriteCurrent>>
    ) => lifetime1.requireDocHttpRoomFileWriteCurrent(httpCustodyKey, ...args),
    readDocHttpRoomFileWriteAttribution: (
      ...args: WithoutCustodyOwner<Parameters<typeof lifetime1.readDocHttpRoomFileWriteAttribution>>
    ) => lifetime1.readDocHttpRoomFileWriteAttribution(httpCustodyKey, ...args),
    originalHttpRoomSessionPlacementRefusal: (
      ...args: WithoutCustodyOwner<
        Parameters<typeof lifetime1.originalHttpRoomSessionPlacementRefusal>
      >
    ) => lifetime1.originalHttpRoomSessionPlacementRefusal(httpCustodyKey, ...args),
    readOriginalHttpRoomSessionPlacement: (
      ...args: WithoutCustodyOwner<
        Parameters<typeof lifetime2.readOriginalHttpRoomSessionPlacement>
      >
    ) => lifetime2.readOriginalHttpRoomSessionPlacement(httpCustodyKey, ...args),
    checkOriginalHttpRoomSessionPlacement: (
      ...args: WithoutCustodyOwner<
        Parameters<typeof lifetime2.checkOriginalHttpRoomSessionPlacement>
      >
    ) => lifetime2.checkOriginalHttpRoomSessionPlacement(httpCustodyKey, ...args),
    captureOriginalHttpRoomSessionPlacement: (
      ...args: WithoutCustodyOwner<
        Parameters<typeof lifetime2.captureOriginalHttpRoomSessionPlacement>
      >
    ) => lifetime2.captureOriginalHttpRoomSessionPlacement(httpCustodyKey, ...args),
    retireDocHttpRoomFileWriteCaller: (
      ...args: WithoutCustodyOwner<Parameters<typeof lifetime2.retireDocHttpRoomFileWriteCaller>>
    ) => lifetime2.retireDocHttpRoomFileWriteCaller(httpCustodyKey, ...args),
    captureDocHttpRoomRepoCaller: (
      ...args: WithoutCustodyOwner<Parameters<typeof lifetime3.captureDocHttpRoomRepoCaller>>
    ) => lifetime3.captureDocHttpRoomRepoCaller(httpCustodyKey, ...args),
    checkDocHttpRoomRepoCaller: (
      ...args: WithoutCustodyOwner<Parameters<typeof lifetime3.checkDocHttpRoomRepoCaller>>
    ) => lifetime3.checkDocHttpRoomRepoCaller(httpCustodyKey, ...args),
    requireDocHttpRoomRepoCaller: (
      ...args: WithoutCustodyOwner<Parameters<typeof lifetime3.requireDocHttpRoomRepoCaller>>
    ) => lifetime3.requireDocHttpRoomRepoCaller(httpCustodyKey, ...args),
    readDocHttpRoomRepoCaller: (
      ...args: WithoutCustodyOwner<Parameters<typeof lifetime3.readDocHttpRoomRepoCaller>>
    ) => lifetime3.readDocHttpRoomRepoCaller(httpCustodyKey, ...args),
    retireDocHttpRoomRepoCaller: (
      ...args: WithoutCustodyOwner<Parameters<typeof lifetime3.retireDocHttpRoomRepoCaller>>
    ) => lifetime3.retireDocHttpRoomRepoCaller(httpCustodyKey, ...args),
  });
}
