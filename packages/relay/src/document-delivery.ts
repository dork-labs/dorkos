/** Construction custody for a new original server Relay, never an attach API. */
declare const originBrand: unique symbol;
export interface ServerDocumentRelayOrigin {
  readonly [originBrand]: true;
}

/** These checks read the original bus ACL; they do not certify native effects. */
export interface ServerDocumentRelayAccess {
  requireExplicitOpenerAccess(openerAgentId: string, targetAgentId: string): void;
  requireOpen(): void;
  /** Actual original Relay transport of bounded identifiers only; no native claim/effect authority. */
  publishAcceptedDocumentWake(
    wake: OriginalDocumentRelayWake
  ): Promise<import('./types.js').PublishResult>;
  /** Bounded DATA transport subscription only; listener cannot mint source/producer authority. */
  subscribeDocumentWakes(listener: (wake: OriginalDocumentRelayWake) => void): () => void;
  /** Internal exact shared counter reservation, not a source/producer permission. */
  reserveDocumentTurn(targetAgentId: string): Readonly<{
    allowed: boolean;
    counted: boolean;
    scope?: 'agent' | 'global';
    refundKnownNoStart(): void;
  }>;
}

/** Source custody for the real freshly installed CCA, not a native producer permission. */
declare const installedAdapterBrand: unique symbol;
export interface InstalledDocumentAdapterOrigin {
  readonly [installedAdapterBrand]: true;
}
export interface InstalledDocumentAdapterSource {
  requireNotRetired(): void;
  requireReady(): void;
  /** Exact constructor map pointer only; native server must recognize original runtime constructor/entry. */
  readRuntime(runtimeType: string): import('./adapters/claude-code/types.js').AgentRuntimeLike;
  /** Actual original shared pool facts only, never reservation/current-operation/close authority. */
  readPoolCensus(): Readonly<{ running: number; waiting: number }>;
  /** Actual private shared pool and local child custody, not native-operation permission. */
  reserveDocumentProcess(
    runtimeType: string
  ): import('./document-process-custody.js').OriginalDocumentProcessReservation | null;
}

/** No input text, actor proof, receipt state or claimed native operation travels on the bus. */
export interface OriginalDocumentRelayWake {
  readonly documentId: string;
  readonly batchId: string;
  readonly generation: string;
  readonly openerAgentId: string;
  readonly targetAgentId: string;
}
