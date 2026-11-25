/** Owner authentication is proved by the viewer router before calling this server-only port. */
export interface BrowserViewerIdentity {
  readonly ownerId: string;
  readonly appSessionId: string;
  readonly clientInstanceId: string;
  readonly viewerId: string;
}

/** Immutable binding derived by the host; a viewer cannot choose a target or profile. */
export interface BrowserPageBinding {
  readonly sessionId: string;
  readonly profileId: string | null;
  readonly connectionId: string;
  readonly profileConnectionGeneration: string;
  readonly leaseId: string;
  readonly tabId: string;
}

/** Finite page-input vocabulary, never a JavaScript expression or arbitrary protocol command. */
export type BrowserPersonInput =
  | import('@dorkos/shared/browser-viewer-control').BrowserViewerInput
  | { kind: 'move'; x: number; y: number }
  | { kind: 'down' | 'up'; button: 'left' | 'middle' | 'right' }
  | { kind: 'wheel'; deltaX: number; deltaY: number }
  | { kind: 'keyDown' | 'keyUp'; key: string }
  | { kind: 'text'; text: string };

/** One screencast's page-scoped events; Chrome's receipt id is not application authority. */
export interface BrowserScreencastFrame {
  readonly data: string;
  readonly sessionId: number;
  readonly metadata: {
    readonly offsetTop: number;
    readonly pageScaleFactor: number;
    readonly deviceWidth: number;
    readonly deviceHeight: number;
    readonly scrollOffsetX: number;
    readonly scrollOffsetY: number;
    readonly timestamp?: number;
  };
}

/** Only the owned session's screencast commands escape, with no generic send or target lookup. */
export interface BrowserPageScreencast {
  start(options: { quality: number; maxWidth: number; maxHeight: number }): Promise<void>;
  acknowledge(sessionId: number): Promise<void>;
  onFrame(listener: (frame: BrowserScreencastFrame) => void): () => void;
  close(): Promise<void>;
}

export interface BrowserPageFacts {
  readonly revision: number;
  readonly navigationGeneration: number;
  readonly controlEpoch: number;
}

/** Existing Page only; never a Browser, BrowserContext or borrowed CDP target. */
export interface BrowserViewerPageHandle {
  readonly binding: BrowserPageBinding;
  readonly identity: BrowserViewerIdentity;
  isCurrent(): boolean;
  assertCurrent(): void;
  /** Existing protected-origin/sign-in fence, without reading page content. */
  assertWatchAllowed(): void;
  /** Page-local metadata only; viewport transforms come from the exact screencast frames. */
  facts(): BrowserPageFacts;
  onPageChange(listener: (facts: BrowserPageFacts) => void): () => void;
  /** Recheck live profile/runtime facts before publishing bytes after any await. */
  assertAuthorized(): Promise<void>;
  onRevoked(listener: () => void): () => void;
  openScreencast(): Promise<BrowserPageScreencast>;
  close(): Promise<void>;
}

/** Generations from a server-verified painted receipt and its person address snapshot. */
export interface BrowserPersonPaint {
  readonly navigationGeneration: number;
  readonly addressGeneration: number;
  readonly viewportGeneration: number;
}

/** One held controller; only a server-verified paint/address pair can enable input.
 * Operation assertions are server-only receipt/viewport fences, never request-supplied callbacks. */
export interface BrowserPersonInputLease {
  readonly epoch: number;
  isCurrent(): boolean;
  inputReady(): boolean;
  confirmPaint(paint: BrowserPersonPaint): void;
  runPerson(input: BrowserPersonInput, assertOperation?: () => void): Promise<void>;
  readSelection(assertOperation?: () => void): Promise<string>;
  onFileChooser(
    listener: (ticket: import('@dorkos/shared/browser-viewer-control').BrowserViewerChooser) => void
  ): () => void;
  chooseFiles(
    ticketId: string,
    files: readonly BrowserPersonFile[],
    settled?: () => void,
    assertOperation?: () => void
  ): Promise<void>;
  cancelFileChooser(ticketId: string): Promise<void>;
}

/** Server-owned multipart payloads, never paths. Cleared after physical consumption settles. */
export interface BrowserPersonFile {
  readonly name: string;
  readonly mimeType: string;
  readonly buffer: Buffer;
}
