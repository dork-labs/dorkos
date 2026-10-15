import type { DocChannelAuthorization } from '../authorization.js';
import {
  submitAuthorizedCurrentDocEvent as submitAuthorizedCurrentDocEventLeaf,
  inspectCurrentDocReceipt as inspectCurrentDocReceiptLeaf,
  prepareAuthorizedCheckboxSource as prepareAuthorizedCheckboxSourceLeaf,
  completeAuthorizedCheckboxSource as completeAuthorizedCheckboxSourceLeaf,
  publishAuthorizedCheckboxSource as publishAuthorizedCheckboxSourceLeaf,
  abandonAuthorizedCheckboxSource as abandonAuthorizedCheckboxSourceLeaf,
  replayAuthorizedCurrentDoc as replayAuthorizedCurrentDocLeaf,
  maintainAuthorizedDocHistory as maintainAuthorizedDocHistoryLeaf,
  readAuthorizedRoomDueAt as readAuthorizedRoomDueAtLeaf,
  wakeAuthorizedRoomDue as wakeAuthorizedRoomDueLeaf,
  hintAuthorizedRoomRelay as hintAuthorizedRoomRelayLeaf,
  subscribeAuthorizedRoomRelay as subscribeAuthorizedRoomRelayLeaf,
  prepareAuthorizedRoomResponder as prepareAuthorizedRoomResponderLeaf,
  commitAuthorizedRoomResponder as commitAuthorizedRoomResponderLeaf,
  captureAuthorizedCurrentDocument as captureAuthorizedCurrentDocumentLeaf,
  requireAuthorizedCurrentDocument as requireAuthorizedCurrentDocumentLeaf,
  replayAuthorizedDocumentAuthority as replayAuthorizedDocumentAuthorityLeaf,
  inspectAuthorizedDocumentAuthority as inspectAuthorizedDocumentAuthorityLeaf,
  submitAuthorizedDocumentAuthority as submitAuthorizedDocumentAuthorityLeaf,
  pumpAuthorizedRoomDue as pumpAuthorizedRoomDueLeaf,
  stopAuthorizedRoomPump as stopAuthorizedRoomPumpLeaf,
  readAuthorizedRoomScenarioEvidence as readAuthorizedRoomScenarioEvidenceLeaf,
} from './authorization-document-operations.js';
import {
  requireAuthorizedDocumentInTransaction as requireAuthorizedDocumentInTransactionLeaf,
  restoreAuthorizedOriginalTokenScope as restoreAuthorizedOriginalTokenScopeLeaf,
  replayAuthorizedOriginalTokenScope as replayAuthorizedOriginalTokenScopeLeaf,
  readAuthorizedOriginalTokenEvent as readAuthorizedOriginalTokenEventLeaf,
  openAuthorizedOriginalTokenStream as openAuthorizedOriginalTokenStreamLeaf,
  nextAuthorizedOriginalTokenStream as nextAuthorizedOriginalTokenStreamLeaf,
  closeAuthorizedOriginalTokenStream as closeAuthorizedOriginalTokenStreamLeaf,
  closedAuthorizedOriginalTokenStream as closedAuthorizedOriginalTokenStreamLeaf,
  stateAuthorizedOriginalTokenStream as stateAuthorizedOriginalTokenStreamLeaf,
  drainDataAuthorizedOriginalTokenOwner as drainDataAuthorizedOriginalTokenOwnerLeaf,
  revokeAuthorizedOriginalDocToken as revokeAuthorizedOriginalDocTokenLeaf,
  admitAuthorizedOriginalTokenIngress as admitAuthorizedOriginalTokenIngressLeaf,
  submitAuthorizedOriginalTokenIngress as submitAuthorizedOriginalTokenIngressLeaf,
  bindAuthorizedOriginalTokenService as bindAuthorizedOriginalTokenServiceLeaf,
  inspectAuthorizedOriginalTokenInputReceipt as inspectAuthorizedOriginalTokenInputReceiptLeaf,
  requireOriginalCurrentDocAccess as requireOriginalCurrentDocAccessLeaf,
  readAuthorizedDocManagement as readAuthorizedDocManagementLeaf,
  askAuthorizedOriginalDocSelection as askAuthorizedOriginalDocSelectionLeaf,
  replayAuthorizedOriginalExpiredDocBatch as replayAuthorizedOriginalExpiredDocBatchLeaf,
  prepareAuthorizedOriginalDocumentSave as prepareAuthorizedOriginalDocumentSaveLeaf,
  completeAuthorizedOriginalDocumentSave as completeAuthorizedOriginalDocumentSaveLeaf,
  updateAuthorizedOriginalDocPresence as updateAuthorizedOriginalDocPresenceLeaf,
} from './authorization-token-editor-operations.js';
/** Preserve complete public operation tuples while naming the original leaf return types for declarations. */
type OriginalAuthorizationArguments<Args extends unknown[]> = Args extends [unknown, ...infer Rest]
  ? Rest
  : never;

/** Name the exact existing public operation signatures without exposing the private key. */
export interface OriginalAuthorizationPublicOperations {
  /** Submit through the original current-document authorization and ingress assembly. */
  readonly submitAuthorizedCurrentDocEvent: (
    ...args: OriginalAuthorizationArguments<Parameters<typeof submitAuthorizedCurrentDocEventLeaf>>
  ) => ReturnType<typeof submitAuthorizedCurrentDocEventLeaf>;
  /** Qualified absence includes the full server-derived incarnation tuple and current retained receipt floor. */
  readonly inspectCurrentDocReceipt: (
    ...args: OriginalAuthorizationArguments<Parameters<typeof inspectCurrentDocReceiptLeaf>>
  ) => ReturnType<typeof inspectCurrentDocReceiptLeaf>;
  /** Prepare the installed checkbox source under its captured authorization. */
  readonly prepareAuthorizedCheckboxSource: (
    ...args: OriginalAuthorizationArguments<Parameters<typeof prepareAuthorizedCheckboxSourceLeaf>>
  ) => ReturnType<typeof prepareAuthorizedCheckboxSourceLeaf>;
  /** Complete the original checkbox source in the owning transaction. */
  readonly completeAuthorizedCheckboxSource: (
    ...args: OriginalAuthorizationArguments<Parameters<typeof completeAuthorizedCheckboxSourceLeaf>>
  ) => ReturnType<typeof completeAuthorizedCheckboxSourceLeaf>;
  /** Publish the original checkbox completion through its captured authorization. */
  readonly publishAuthorizedCheckboxSource: (
    ...args: OriginalAuthorizationArguments<Parameters<typeof publishAuthorizedCheckboxSourceLeaf>>
  ) => ReturnType<typeof publishAuthorizedCheckboxSourceLeaf>;
  /** Abandon the original checkbox source in the owning transaction. */
  readonly abandonAuthorizedCheckboxSource: (
    ...args: OriginalAuthorizationArguments<Parameters<typeof abandonAuthorizedCheckboxSourceLeaf>>
  ) => ReturnType<typeof abandonAuthorizedCheckboxSourceLeaf>;
  /** Initial replay captures server birth through the original constructor-owned private engine. */
  readonly replayAuthorizedCurrentDoc: (
    ...args: OriginalAuthorizationArguments<Parameters<typeof replayAuthorizedCurrentDocLeaf>>
  ) => ReturnType<typeof replayAuthorizedCurrentDocLeaf>;
  /** Genuine original maintenance closure: callers supply no actor, clock, engine or facade. */
  readonly maintainAuthorizedDocHistory: (
    ...args: OriginalAuthorizationArguments<Parameters<typeof maintainAuthorizedDocHistoryLeaf>>
  ) => ReturnType<typeof maintainAuthorizedDocHistoryLeaf>;
  /** Fixed timer data/wake port from the genuine engine; never exposes engine, DB or source. */
  readonly readAuthorizedRoomDueAt: (
    ...args: OriginalAuthorizationArguments<Parameters<typeof readAuthorizedRoomDueAtLeaf>>
  ) => ReturnType<typeof readAuthorizedRoomDueAtLeaf>;
  /** Revisit original committed custody only; no actor or source DTO is accepted. */
  readonly wakeAuthorizedRoomDue: (
    ...args: OriginalAuthorizationArguments<Parameters<typeof wakeAuthorizedRoomDueLeaf>>
  ) => ReturnType<typeof wakeAuthorizedRoomDueLeaf>;
  /** Resolve Relay identifiers through this authorization's original Room engine only. */
  readonly hintAuthorizedRoomRelay: (
    ...args: OriginalAuthorizationArguments<Parameters<typeof hintAuthorizedRoomRelayLeaf>>
  ) => ReturnType<typeof hintAuthorizedRoomRelayLeaf>;
  /** Subscribe only through the original authorization's native Room operation owner. */
  readonly subscribeAuthorizedRoomRelay: (
    ...args: OriginalAuthorizationArguments<Parameters<typeof subscribeAuthorizedRoomRelayLeaf>>
  ) => ReturnType<typeof subscribeAuthorizedRoomRelayLeaf>;
  /** Genuine private source routing only, never a caller-supplied source or principal. */
  readonly prepareAuthorizedRoomResponder: (
    ...args: OriginalAuthorizationArguments<Parameters<typeof prepareAuthorizedRoomResponderLeaf>>
  ) => ReturnType<typeof prepareAuthorizedRoomResponderLeaf>;
  /** Original constructor engine commits only its own genuine prepared native entry. */
  readonly commitAuthorizedRoomResponder: (
    ...args: OriginalAuthorizationArguments<Parameters<typeof commitAuthorizedRoomResponderLeaf>>
  ) => ReturnType<typeof commitAuthorizedRoomResponderLeaf>;
  /** Genuine owning document-only issuance and current read, including an empty dependency list. */
  readonly captureAuthorizedCurrentDocument: (
    ...args: OriginalAuthorizationArguments<Parameters<typeof captureAuthorizedCurrentDocumentLeaf>>
  ) => ReturnType<typeof captureAuthorizedCurrentDocumentLeaf>;
  /** Require currentness of the original captured document authority. */
  readonly requireAuthorizedCurrentDocument: (
    ...args: OriginalAuthorizationArguments<Parameters<typeof requireAuthorizedCurrentDocumentLeaf>>
  ) => ReturnType<typeof requireAuthorizedCurrentDocumentLeaf>;
  /** Replay through the original captured document authority. */
  readonly replayAuthorizedDocumentAuthority: (
    ...args: OriginalAuthorizationArguments<
      Parameters<typeof replayAuthorizedDocumentAuthorityLeaf>
    >
  ) => ReturnType<typeof replayAuthorizedDocumentAuthorityLeaf>;
  /** Inspect an event through the original captured document authority. */
  readonly inspectAuthorizedDocumentAuthority: (
    ...args: OriginalAuthorizationArguments<
      Parameters<typeof inspectAuthorizedDocumentAuthorityLeaf>
    >
  ) => ReturnType<typeof inspectAuthorizedDocumentAuthorityLeaf>;
  /** Submit an event through the original captured document authority. */
  readonly submitAuthorizedDocumentAuthority: (
    ...args: OriginalAuthorizationArguments<
      Parameters<typeof submitAuthorizedDocumentAuthorityLeaf>
    >
  ) => ReturnType<typeof submitAuthorizedDocumentAuthorityLeaf>;
  /** Fixed original engine invocation; registry rows and timer hints never issue source custody. */
  readonly pumpAuthorizedRoomDue: (
    ...args: OriginalAuthorizationArguments<Parameters<typeof pumpAuthorizedRoomDueLeaf>>
  ) => ReturnType<typeof pumpAuthorizedRoomDueLeaf>;
  /** Stop the original authorization-owned Room pump. */
  readonly stopAuthorizedRoomPump: (
    ...args: OriginalAuthorizationArguments<Parameters<typeof stopAuthorizedRoomPumpLeaf>>
  ) => ReturnType<typeof stopAuthorizedRoomPumpLeaf>;
  /** Read scenario evidence from the original Room operation engine. */
  readonly readAuthorizedRoomScenarioEvidence: (
    ...args: OriginalAuthorizationArguments<
      Parameters<typeof readAuthorizedRoomScenarioEvidenceLeaf>
    >
  ) => ReturnType<typeof readAuthorizedRoomScenarioEvidenceLeaf>;
  /** Repeat only an actual original retained actor/document authority in the supplied same native transaction. */
  readonly requireAuthorizedDocumentInTransaction: (
    ...args: OriginalAuthorizationArguments<
      Parameters<typeof requireAuthorizedDocumentInTransactionLeaf>
    >
  ) => ReturnType<typeof requireAuthorizedDocumentInTransactionLeaf>;
  /** Fixed original constructor ingress for persistent native scopes; no actor input. */
  readonly restoreAuthorizedOriginalTokenScope: (
    ...args: OriginalAuthorizationArguments<
      Parameters<typeof restoreAuthorizedOriginalTokenScopeLeaf>
    >
  ) => ReturnType<typeof restoreAuthorizedOriginalTokenScopeLeaf>;
  /** Replay the original native token scope with its required permission. */
  readonly replayAuthorizedOriginalTokenScope: (
    ...args: OriginalAuthorizationArguments<
      Parameters<typeof replayAuthorizedOriginalTokenScopeLeaf>
    >
  ) => ReturnType<typeof replayAuthorizedOriginalTokenScopeLeaf>;
  /** Read an authorized event from the original native token scope. */
  readonly readAuthorizedOriginalTokenEvent: (
    ...args: OriginalAuthorizationArguments<Parameters<typeof readAuthorizedOriginalTokenEventLeaf>>
  ) => ReturnType<typeof readAuthorizedOriginalTokenEventLeaf>;
  /** Open a stream owned by the original native token scope. */
  readonly openAuthorizedOriginalTokenStream: (
    ...args: OriginalAuthorizationArguments<
      Parameters<typeof openAuthorizedOriginalTokenStreamLeaf>
    >
  ) => ReturnType<typeof openAuthorizedOriginalTokenStreamLeaf>;
  /** Read the next frame of the original authorization-owned token stream. */
  readonly nextAuthorizedOriginalTokenStream: (
    ...args: OriginalAuthorizationArguments<
      Parameters<typeof nextAuthorizedOriginalTokenStreamLeaf>
    >
  ) => ReturnType<typeof nextAuthorizedOriginalTokenStreamLeaf>;
  /** Close the original authorization-owned token stream. */
  readonly closeAuthorizedOriginalTokenStream: (
    ...args: OriginalAuthorizationArguments<
      Parameters<typeof closeAuthorizedOriginalTokenStreamLeaf>
    >
  ) => ReturnType<typeof closeAuthorizedOriginalTokenStreamLeaf>;
  /** Read whether the original token stream has closed. */
  readonly closedAuthorizedOriginalTokenStream: (
    ...args: OriginalAuthorizationArguments<
      Parameters<typeof closedAuthorizedOriginalTokenStreamLeaf>
    >
  ) => ReturnType<typeof closedAuthorizedOriginalTokenStreamLeaf>;
  /** Read the state of the original authorization-owned token stream. */
  readonly stateAuthorizedOriginalTokenStream: (
    ...args: OriginalAuthorizationArguments<
      Parameters<typeof stateAuthorizedOriginalTokenStreamLeaf>
    >
  ) => ReturnType<typeof stateAuthorizedOriginalTokenStreamLeaf>;
  /** Drain token-owner DATA through the original operation engine. */
  readonly drainDataAuthorizedOriginalTokenOwner: (
    ...args: OriginalAuthorizationArguments<
      Parameters<typeof drainDataAuthorizedOriginalTokenOwnerLeaf>
    >
  ) => ReturnType<typeof drainDataAuthorizedOriginalTokenOwnerLeaf>;
  /** Revocation is original operator/source authority; a bearer never restores an actor. */
  readonly revokeAuthorizedOriginalDocToken: (
    ...args: OriginalAuthorizationArguments<Parameters<typeof revokeAuthorizedOriginalDocTokenLeaf>>
  ) => ReturnType<typeof revokeAuthorizedOriginalDocTokenLeaf>;
  /** Authenticate original opaque input scope before a standalone parser consumes any body. */
  readonly admitAuthorizedOriginalTokenIngress: (
    ...args: OriginalAuthorizationArguments<
      Parameters<typeof admitAuthorizedOriginalTokenIngressLeaf>
    >
  ) => ReturnType<typeof admitAuthorizedOriginalTokenIngressLeaf>;
  /** Submit bearer ingress through the original native token scope. */
  readonly submitAuthorizedOriginalTokenIngress: (
    ...args: OriginalAuthorizationArguments<
      Parameters<typeof submitAuthorizedOriginalTokenIngressLeaf>
    >
  ) => ReturnType<typeof submitAuthorizedOriginalTokenIngressLeaf>;
  /** Original service constructor establishes the single retained token recovery dependency tuple. */
  readonly bindAuthorizedOriginalTokenService: (
    ...args: OriginalAuthorizationArguments<
      Parameters<typeof bindAuthorizedOriginalTokenServiceLeaf>
    >
  ) => ReturnType<typeof bindAuthorizedOriginalTokenServiceLeaf>;
  /** Inspect the original token ingress receipt by event identity. */
  readonly inspectAuthorizedOriginalTokenInputReceipt: (
    ...args: OriginalAuthorizationArguments<
      Parameters<typeof inspectAuthorizedOriginalTokenInputReceiptLeaf>
    >
  ) => ReturnType<typeof inspectAuthorizedOriginalTokenInputReceiptLeaf>;
  /** Revalidate through the original authorization engine rather than reflected public methods. */
  readonly requireOriginalCurrentDocAccess: (
    ...args: OriginalAuthorizationArguments<Parameters<typeof requireOriginalCurrentDocAccessLeaf>>
  ) => ReturnType<typeof requireOriginalCurrentDocAccessLeaf>;
  /** Original constructor-owned operator management projection; no caller reader or authority callback. */
  readonly readAuthorizedDocManagement: (
    ...args: OriginalAuthorizationArguments<Parameters<typeof readAuthorizedDocManagementLeaf>>
  ) => ReturnType<typeof readAuthorizedDocManagementLeaf>;
  /** Accept a host selection only through this original authorization's private engine. */
  readonly askAuthorizedOriginalDocSelection: (
    ...args: OriginalAuthorizationArguments<
      Parameters<typeof askAuthorizedOriginalDocSelectionLeaf>
    >
  ) => ReturnType<typeof askAuthorizedOriginalDocSelectionLeaf>;
  /** Enter the exact original operator replay engine, never the reflected legacy batch helper. */
  readonly replayAuthorizedOriginalExpiredDocBatch: (
    ...args: OriginalAuthorizationArguments<
      Parameters<typeof replayAuthorizedOriginalExpiredDocBatchLeaf>
    >
  ) => ReturnType<typeof replayAuthorizedOriginalExpiredDocBatchLeaf>;
  /** Original installed file owner invokes preparation with its actual retained HTTP actor. */
  readonly prepareAuthorizedOriginalDocumentSave: (
    ...args: OriginalAuthorizationArguments<
      Parameters<typeof prepareAuthorizedOriginalDocumentSaveLeaf>
    >
  ) => ReturnType<typeof prepareAuthorizedOriginalDocumentSaveLeaf>;
  /** Only the genuine private file-save scope can complete this reserved host event. */
  readonly completeAuthorizedOriginalDocumentSave: (
    ...args: OriginalAuthorizationArguments<
      Parameters<typeof completeAuthorizedOriginalDocumentSaveLeaf>
    >
  ) => ReturnType<typeof completeAuthorizedOriginalDocumentSaveLeaf>;
  /** Authenticated host presence follows only the constructor-retained original engine. */
  readonly updateAuthorizedOriginalDocPresence: (
    ...args: OriginalAuthorizationArguments<
      Parameters<typeof updateAuthorizedOriginalDocPresenceLeaf>
    >
  ) => ReturnType<typeof updateAuthorizedOriginalDocPresenceLeaf>;
}

/** Build wrappers over a privately retained key reader; each leaf independently requires original membership. */
export function createOriginalAuthorizationPublicOperations(
  readOwnerKey: (authorization: DocChannelAuthorization) => object | undefined
): OriginalAuthorizationPublicOperations {
  function bindOriginalAuthorizationOperation<
    Args extends [DocChannelAuthorization, ...unknown[]],
    Result,
  >(operation: (ownerKey: object | undefined, ...args: Args) => Result): (...args: Args) => Result {
    return (...args) => operation(readOwnerKey(args[0]), ...args);
  }

  return Object.freeze({
    submitAuthorizedCurrentDocEvent: bindOriginalAuthorizationOperation(
      submitAuthorizedCurrentDocEventLeaf
    ),
    inspectCurrentDocReceipt: bindOriginalAuthorizationOperation(inspectCurrentDocReceiptLeaf),
    prepareAuthorizedCheckboxSource: bindOriginalAuthorizationOperation(
      prepareAuthorizedCheckboxSourceLeaf
    ),
    completeAuthorizedCheckboxSource: bindOriginalAuthorizationOperation(
      completeAuthorizedCheckboxSourceLeaf
    ),
    publishAuthorizedCheckboxSource: bindOriginalAuthorizationOperation(
      publishAuthorizedCheckboxSourceLeaf
    ),
    abandonAuthorizedCheckboxSource: bindOriginalAuthorizationOperation(
      abandonAuthorizedCheckboxSourceLeaf
    ),
    replayAuthorizedCurrentDoc: bindOriginalAuthorizationOperation(replayAuthorizedCurrentDocLeaf),
    maintainAuthorizedDocHistory: bindOriginalAuthorizationOperation(
      maintainAuthorizedDocHistoryLeaf
    ),
    readAuthorizedRoomDueAt: bindOriginalAuthorizationOperation(readAuthorizedRoomDueAtLeaf),
    wakeAuthorizedRoomDue: bindOriginalAuthorizationOperation(wakeAuthorizedRoomDueLeaf),
    hintAuthorizedRoomRelay: bindOriginalAuthorizationOperation(hintAuthorizedRoomRelayLeaf),
    subscribeAuthorizedRoomRelay: bindOriginalAuthorizationOperation(
      subscribeAuthorizedRoomRelayLeaf
    ),
    prepareAuthorizedRoomResponder: bindOriginalAuthorizationOperation(
      prepareAuthorizedRoomResponderLeaf
    ),
    commitAuthorizedRoomResponder: bindOriginalAuthorizationOperation(
      commitAuthorizedRoomResponderLeaf
    ),
    captureAuthorizedCurrentDocument: bindOriginalAuthorizationOperation(
      captureAuthorizedCurrentDocumentLeaf
    ),
    requireAuthorizedCurrentDocument: bindOriginalAuthorizationOperation(
      requireAuthorizedCurrentDocumentLeaf
    ),
    replayAuthorizedDocumentAuthority: bindOriginalAuthorizationOperation(
      replayAuthorizedDocumentAuthorityLeaf
    ),
    inspectAuthorizedDocumentAuthority: bindOriginalAuthorizationOperation(
      inspectAuthorizedDocumentAuthorityLeaf
    ),
    submitAuthorizedDocumentAuthority: bindOriginalAuthorizationOperation(
      submitAuthorizedDocumentAuthorityLeaf
    ),
    pumpAuthorizedRoomDue: bindOriginalAuthorizationOperation(pumpAuthorizedRoomDueLeaf),
    stopAuthorizedRoomPump: bindOriginalAuthorizationOperation(stopAuthorizedRoomPumpLeaf),
    readAuthorizedRoomScenarioEvidence: bindOriginalAuthorizationOperation(
      readAuthorizedRoomScenarioEvidenceLeaf
    ),
    requireAuthorizedDocumentInTransaction: bindOriginalAuthorizationOperation(
      requireAuthorizedDocumentInTransactionLeaf
    ),
    restoreAuthorizedOriginalTokenScope: bindOriginalAuthorizationOperation(
      restoreAuthorizedOriginalTokenScopeLeaf
    ),
    replayAuthorizedOriginalTokenScope: bindOriginalAuthorizationOperation(
      replayAuthorizedOriginalTokenScopeLeaf
    ),
    readAuthorizedOriginalTokenEvent: bindOriginalAuthorizationOperation(
      readAuthorizedOriginalTokenEventLeaf
    ),
    openAuthorizedOriginalTokenStream: bindOriginalAuthorizationOperation(
      openAuthorizedOriginalTokenStreamLeaf
    ),
    nextAuthorizedOriginalTokenStream: bindOriginalAuthorizationOperation(
      nextAuthorizedOriginalTokenStreamLeaf
    ),
    closeAuthorizedOriginalTokenStream: bindOriginalAuthorizationOperation(
      closeAuthorizedOriginalTokenStreamLeaf
    ),
    closedAuthorizedOriginalTokenStream: bindOriginalAuthorizationOperation(
      closedAuthorizedOriginalTokenStreamLeaf
    ),
    stateAuthorizedOriginalTokenStream: bindOriginalAuthorizationOperation(
      stateAuthorizedOriginalTokenStreamLeaf
    ),
    drainDataAuthorizedOriginalTokenOwner: bindOriginalAuthorizationOperation(
      drainDataAuthorizedOriginalTokenOwnerLeaf
    ),
    revokeAuthorizedOriginalDocToken: bindOriginalAuthorizationOperation(
      revokeAuthorizedOriginalDocTokenLeaf
    ),
    admitAuthorizedOriginalTokenIngress: bindOriginalAuthorizationOperation(
      admitAuthorizedOriginalTokenIngressLeaf
    ),
    submitAuthorizedOriginalTokenIngress: bindOriginalAuthorizationOperation(
      submitAuthorizedOriginalTokenIngressLeaf
    ),
    bindAuthorizedOriginalTokenService: bindOriginalAuthorizationOperation(
      bindAuthorizedOriginalTokenServiceLeaf
    ),
    inspectAuthorizedOriginalTokenInputReceipt: bindOriginalAuthorizationOperation(
      inspectAuthorizedOriginalTokenInputReceiptLeaf
    ),
    requireOriginalCurrentDocAccess: bindOriginalAuthorizationOperation(
      requireOriginalCurrentDocAccessLeaf
    ),
    readAuthorizedDocManagement: bindOriginalAuthorizationOperation(
      readAuthorizedDocManagementLeaf
    ),
    askAuthorizedOriginalDocSelection: bindOriginalAuthorizationOperation(
      askAuthorizedOriginalDocSelectionLeaf
    ),
    replayAuthorizedOriginalExpiredDocBatch: bindOriginalAuthorizationOperation(
      replayAuthorizedOriginalExpiredDocBatchLeaf
    ),
    prepareAuthorizedOriginalDocumentSave: bindOriginalAuthorizationOperation(
      prepareAuthorizedOriginalDocumentSaveLeaf
    ),
    completeAuthorizedOriginalDocumentSave: bindOriginalAuthorizationOperation(
      completeAuthorizedOriginalDocumentSaveLeaf
    ),
    updateAuthorizedOriginalDocPresence: bindOriginalAuthorizationOperation(
      updateAuthorizedOriginalDocPresenceLeaf
    ),
  });
}
