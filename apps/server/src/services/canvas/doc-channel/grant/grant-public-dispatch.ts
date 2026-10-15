import * as dispatch from './grant-original-dispatch.js';
type WithoutOwner<T extends readonly unknown[]> = T extends readonly [object, ...infer Rest]
  ? Rest
  : never;
/** Original public grant callable contracts omit only the unreachable private module key. */
export interface OriginalGrantPublicDispatch {
  documentDependenciesBeforeOriginalGrantInsertion: (
    ...args: WithoutOwner<
      Parameters<typeof dispatch.documentDependenciesBeforeOriginalGrantInsertion>
    >
  ) => ReturnType<typeof dispatch.documentDependenciesBeforeOriginalGrantInsertion>;
  readOriginalCurrentDocReplayRouting: (
    ...args: WithoutOwner<Parameters<typeof dispatch.readOriginalCurrentDocReplayRouting>>
  ) => ReturnType<typeof dispatch.readOriginalCurrentDocReplayRouting>;
  prepareCurrentDocGrantRoutes: (
    ...args: WithoutOwner<Parameters<typeof dispatch.prepareCurrentDocGrantRoutes>>
  ) => ReturnType<typeof dispatch.prepareCurrentDocGrantRoutes>;
  prepareCurrentDocCheckboxGrantRoutes: (
    ...args: WithoutOwner<Parameters<typeof dispatch.prepareCurrentDocCheckboxGrantRoutes>>
  ) => ReturnType<typeof dispatch.prepareCurrentDocCheckboxGrantRoutes>;
  auditCurrentDocGrantRows: (
    ...args: WithoutOwner<Parameters<typeof dispatch.auditCurrentDocGrantRows>>
  ) => ReturnType<typeof dispatch.auditCurrentDocGrantRows>;
  refreshCurrentDocGrantAuthority: (
    ...args: WithoutOwner<Parameters<typeof dispatch.refreshCurrentDocGrantAuthority>>
  ) => ReturnType<typeof dispatch.refreshCurrentDocGrantAuthority>;
  readCurrentOriginalRoomGrantSource: (
    ...args: WithoutOwner<Parameters<typeof dispatch.readCurrentOriginalRoomGrantSource>>
  ) => ReturnType<typeof dispatch.readCurrentOriginalRoomGrantSource>;
  captureCurrentDocumentGrantDependencies: (
    ...args: WithoutOwner<Parameters<typeof dispatch.captureCurrentDocumentGrantDependencies>>
  ) => ReturnType<typeof dispatch.captureCurrentDocumentGrantDependencies>;
  requireCurrentDocumentGrantFinal: (
    ...args: WithoutOwner<Parameters<typeof dispatch.requireCurrentDocumentGrantFinal>>
  ) => ReturnType<typeof dispatch.requireCurrentDocumentGrantFinal>;
  readOriginalTokenDocumentManifest: (
    ...args: WithoutOwner<Parameters<typeof dispatch.readOriginalTokenDocumentManifest>>
  ) => ReturnType<typeof dispatch.readOriginalTokenDocumentManifest>;
  requireOriginalTokenDocumentManifestClosed: (
    ...args: WithoutOwner<Parameters<typeof dispatch.requireOriginalTokenDocumentManifestClosed>>
  ) => ReturnType<typeof dispatch.requireOriginalTokenDocumentManifestClosed>;
  prepareOriginalTokenGrantInput: (
    ...args: WithoutOwner<Parameters<typeof dispatch.prepareOriginalTokenGrantInput>>
  ) => ReturnType<typeof dispatch.prepareOriginalTokenGrantInput>;
  requireOriginalDocumentRelayGrants: (
    ...args: WithoutOwner<Parameters<typeof dispatch.requireOriginalDocumentRelayGrants>>
  ) => ReturnType<typeof dispatch.requireOriginalDocumentRelayGrants>;
  requireCurrentDocGrantEngine: (
    ...args: WithoutOwner<Parameters<typeof dispatch.requireCurrentDocGrantEngine>>
  ) => ReturnType<typeof dispatch.requireCurrentDocGrantEngine>;
  grantOriginalPreparedCheckboxRoute: (
    ...args: WithoutOwner<Parameters<typeof dispatch.grantOriginalPreparedCheckboxRoute>>
  ) => ReturnType<typeof dispatch.grantOriginalPreparedCheckboxRoute>;
  configureOriginalDocChannel: (
    ...args: WithoutOwner<Parameters<typeof dispatch.configureOriginalDocChannel>>
  ) => ReturnType<typeof dispatch.configureOriginalDocChannel>;
  approveOriginalDocRoute: (
    ...args: WithoutOwner<Parameters<typeof dispatch.approveOriginalDocRoute>>
  ) => ReturnType<typeof dispatch.approveOriginalDocRoute>;
  revokeOriginalDocRoute: (
    ...args: WithoutOwner<Parameters<typeof dispatch.revokeOriginalDocRoute>>
  ) => ReturnType<typeof dispatch.revokeOriginalDocRoute>;
  readOriginalReviewedDocReplayRoute: (
    ...args: WithoutOwner<Parameters<typeof dispatch.readOriginalReviewedDocReplayRoute>>
  ) => ReturnType<typeof dispatch.readOriginalReviewedDocReplayRoute>;
}
/** Fixed original public dispatch closures; only the root retains the genuine private key. */
export function createOriginalGrantPublicDispatch(
  owner: object
): Readonly<OriginalGrantPublicDispatch> {
  return Object.freeze({
    documentDependenciesBeforeOriginalGrantInsertion: (
      ...args: WithoutOwner<
        Parameters<typeof dispatch.documentDependenciesBeforeOriginalGrantInsertion>
      >
    ) => dispatch.documentDependenciesBeforeOriginalGrantInsertion(owner, ...args),
    readOriginalCurrentDocReplayRouting: (
      ...args: WithoutOwner<Parameters<typeof dispatch.readOriginalCurrentDocReplayRouting>>
    ) => dispatch.readOriginalCurrentDocReplayRouting(owner, ...args),
    prepareCurrentDocGrantRoutes: (
      ...args: WithoutOwner<Parameters<typeof dispatch.prepareCurrentDocGrantRoutes>>
    ) => dispatch.prepareCurrentDocGrantRoutes(owner, ...args),
    prepareCurrentDocCheckboxGrantRoutes: (
      ...args: WithoutOwner<Parameters<typeof dispatch.prepareCurrentDocCheckboxGrantRoutes>>
    ) => dispatch.prepareCurrentDocCheckboxGrantRoutes(owner, ...args),
    auditCurrentDocGrantRows: (
      ...args: WithoutOwner<Parameters<typeof dispatch.auditCurrentDocGrantRows>>
    ) => dispatch.auditCurrentDocGrantRows(owner, ...args),
    refreshCurrentDocGrantAuthority: (
      ...args: WithoutOwner<Parameters<typeof dispatch.refreshCurrentDocGrantAuthority>>
    ) => dispatch.refreshCurrentDocGrantAuthority(owner, ...args),
    readCurrentOriginalRoomGrantSource: (
      ...args: WithoutOwner<Parameters<typeof dispatch.readCurrentOriginalRoomGrantSource>>
    ) => dispatch.readCurrentOriginalRoomGrantSource(owner, ...args),
    captureCurrentDocumentGrantDependencies: (
      ...args: WithoutOwner<Parameters<typeof dispatch.captureCurrentDocumentGrantDependencies>>
    ) => dispatch.captureCurrentDocumentGrantDependencies(owner, ...args),
    requireCurrentDocumentGrantFinal: (
      ...args: WithoutOwner<Parameters<typeof dispatch.requireCurrentDocumentGrantFinal>>
    ) => dispatch.requireCurrentDocumentGrantFinal(owner, ...args),
    readOriginalTokenDocumentManifest: (
      ...args: WithoutOwner<Parameters<typeof dispatch.readOriginalTokenDocumentManifest>>
    ) => dispatch.readOriginalTokenDocumentManifest(owner, ...args),
    requireOriginalTokenDocumentManifestClosed: (
      ...args: WithoutOwner<Parameters<typeof dispatch.requireOriginalTokenDocumentManifestClosed>>
    ) => dispatch.requireOriginalTokenDocumentManifestClosed(owner, ...args),
    prepareOriginalTokenGrantInput: (
      ...args: WithoutOwner<Parameters<typeof dispatch.prepareOriginalTokenGrantInput>>
    ) => dispatch.prepareOriginalTokenGrantInput(owner, ...args),
    requireOriginalDocumentRelayGrants: (
      ...args: WithoutOwner<Parameters<typeof dispatch.requireOriginalDocumentRelayGrants>>
    ) => dispatch.requireOriginalDocumentRelayGrants(owner, ...args),
    requireCurrentDocGrantEngine: (
      ...args: WithoutOwner<Parameters<typeof dispatch.requireCurrentDocGrantEngine>>
    ) => dispatch.requireCurrentDocGrantEngine(owner, ...args),
    grantOriginalPreparedCheckboxRoute: (
      ...args: WithoutOwner<Parameters<typeof dispatch.grantOriginalPreparedCheckboxRoute>>
    ) => dispatch.grantOriginalPreparedCheckboxRoute(owner, ...args),
    configureOriginalDocChannel: (
      ...args: WithoutOwner<Parameters<typeof dispatch.configureOriginalDocChannel>>
    ) => dispatch.configureOriginalDocChannel(owner, ...args),
    approveOriginalDocRoute: (
      ...args: WithoutOwner<Parameters<typeof dispatch.approveOriginalDocRoute>>
    ) => dispatch.approveOriginalDocRoute(owner, ...args),
    revokeOriginalDocRoute: (
      ...args: WithoutOwner<Parameters<typeof dispatch.revokeOriginalDocRoute>>
    ) => dispatch.revokeOriginalDocRoute(owner, ...args),
    readOriginalReviewedDocReplayRoute: (
      ...args: WithoutOwner<Parameters<typeof dispatch.readOriginalReviewedDocReplayRoute>>
    ) => dispatch.readOriginalReviewedDocReplayRoute(owner, ...args),
  });
}
