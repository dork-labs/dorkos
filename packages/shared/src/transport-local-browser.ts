import type {
  BrowserViewerInput,
  BrowserViewerMetadata,
  BrowserViewerOperation,
  BrowserViewerOutcome,
  BrowserViewerPaint,
} from './browser-viewer-control.js';
import type {
  LocalBrowserCapabilities,
  LocalBrowserHistoryDirection,
  LocalBrowserOpen,
  LocalBrowserPersonState,
  LocalBrowserProfile,
  LocalBrowserSignInRequest,
  LocalBrowserState,
} from './local-browser.js';

/** One volatile subscription, usable only beside its original authenticated app session. */
export interface BrowserViewerSubscription {
  metadata: BrowserViewerMetadata;
  viewerId: string;
  nonce: string;
  binding: { chatId: string; profileId: string | null; connectionId: string; tabId: string };
}

/** Bounded in-memory JPEG bytes and the receipt acknowledged only after painting. */
export interface BrowserViewerFrame {
  sequence: number;
  generation: number;
  width: number;
  height: number;
  byteLength: number;
  receipt: string;
  bytes: Uint8Array;
  view: BrowserViewerMetadata;
}

export interface BrowserViewerControlResult {
  metadata: BrowserViewerMetadata;
  outcome?: BrowserViewerOutcome;
  text?: string;
}
/** Finite person-only inputs; no browser acquisition or arbitrary document reads. */
export interface BrowserViewerTransport {
  /** Subscribe to the server-resolved existing page for a chat. */
  subscribeBrowserViewer(chatId: string, signal?: AbortSignal): Promise<BrowserViewerSubscription>;
  /** Acknowledge a painted frame and wait for one newer frame, or idle liveness. */
  nextBrowserViewerFrame(
    viewer: BrowserViewerSubscription,
    receipt?: string,
    signal?: AbortSignal,
    paint?: BrowserViewerPaint
  ): Promise<BrowserViewerFrame | null>;
  takeBrowserViewerControl(
    viewer: BrowserViewerSubscription,
    signal?: AbortSignal
  ): Promise<BrowserViewerControlResult>;
  sendBrowserViewerInput(
    viewer: BrowserViewerSubscription,
    operation: BrowserViewerOperation,
    input: BrowserViewerInput,
    signal?: AbortSignal
  ): Promise<BrowserViewerControlResult>;
  endBrowserViewerControl(
    viewer: BrowserViewerSubscription,
    controllerId: string,
    controlEpoch: number,
    action: 'resume' | 'abandon'
  ): Promise<BrowserViewerControlResult>;
  copyBrowserViewerSelection(
    viewer: BrowserViewerSubscription,
    operation: BrowserViewerOperation,
    signal?: AbortSignal
  ): Promise<BrowserViewerControlResult>;
  pasteBrowserViewerText(
    viewer: BrowserViewerSubscription,
    operation: BrowserViewerOperation,
    text: string,
    signal?: AbortSignal
  ): Promise<BrowserViewerControlResult>;
  uploadBrowserViewerFiles(
    viewer: BrowserViewerSubscription,
    operation: BrowserViewerOperation,
    ticketId: string,
    files: readonly File[],
    signal?: AbortSignal
  ): Promise<BrowserViewerControlResult>;
  cancelBrowserViewerFiles(
    viewer: BrowserViewerSubscription,
    controllerId: string,
    controlEpoch: number,
    ticketId: string
  ): Promise<BrowserViewerControlResult>;
  /** Release only this subscription, without closing its browser page. */
  closeBrowserViewer(viewer: BrowserViewerSubscription): Promise<void>;
}

/** Human controls for a local, live browser; agent actions use a separate scoped tool surface. */
export interface LocalBrowserTransport extends BrowserViewerTransport {
  /** Scan profile metadata only after a person taps Find my browsers. Never cache the response. */
  scanYourBrowsers(): Promise<import('./your-browser.js').YourBrowserScan>;
  getLocalBrowserState(
    sessionId?: string | null,
    viewer?: BrowserViewerSubscription
  ): Promise<LocalBrowserPersonState>;
  /** The install’s current handoff card, independent of the selected page. */
  getLocalBrowserHandoffState(): Promise<LocalBrowserPersonState>;
  getLocalBrowserCapabilities(): Promise<LocalBrowserCapabilities>;
  /** Profile metadata for the person's browser controls. */
  listLocalBrowserProfiles(): Promise<{ profiles: LocalBrowserProfile[] }>;
  /** Share one profile with the named agent after the person completes step-up. */
  bindLocalBrowserProfile(
    profileId: string,
    agentId: string,
    sessionId?: string
  ): Promise<LocalBrowserProfile>;
  /** Stop sharing on the next agent call. */
  unbindLocalBrowserProfile(
    profileId: string,
    agentId: string,
    sessionId?: string
  ): Promise<LocalBrowserProfile>;
  /** Forget every site in one profile; null selects the shared default. */
  forgetLocalBrowserSignIns(profileId: string | null): Promise<{ success: true }>;
  /** Remove a named profile, its saved site data and agent access. */
  deleteLocalBrowserProfile(profileId: string): Promise<{ success: true }>;
  openLocalBrowser(input: LocalBrowserOpen): Promise<LocalBrowserPersonState>;
  selectLocalBrowserTab(id: string, sessionId?: string | null): Promise<LocalBrowserState>;
  /**
   * A person's navigation, which takes the page from an agent sharing it (DOR-4428).
   *
   * @param url - The address to open.
   * @param options - Whether a bare host may ask the server for one HTTP fallback.
   */
  navigateLocalBrowser(
    url: string,
    options?: { httpFallback?: boolean; sessionId?: string | null }
  ): Promise<LocalBrowserPersonState>;
  /** Move the page one step back or forward through its own history. Takes the page from an agent. */
  stepLocalBrowserHistory(
    direction: LocalBrowserHistoryDirection,
    sessionId?: string | null
  ): Promise<LocalBrowserPersonState>;
  /** Take the page from the chat it is shared with, until the person resumes the agent. */
  takeOverLocalBrowser(sessionId?: string | null): Promise<LocalBrowserPersonState>;
  pauseLocalBrowser(sessionId?: string | null): Promise<LocalBrowserState>;
  resumeLocalBrowser(sessionId?: string | null): Promise<LocalBrowserPersonState>;
  disconnectLocalBrowser(sessionId?: string | null): Promise<LocalBrowserPersonState>;
  /** Open the plain sign-in window, which no agent can reach. */
  signInLocalBrowser(
    input: LocalBrowserSignInRequest,
    sessionId?: string | null
  ): Promise<LocalBrowserPersonState>;
  /** Finish the selected chat's sign-in, or the handoff named by its own identity. */
  finishLocalBrowserSignIn(handoffId?: string, sessionId?: string | null): Promise<void>;
  /** Give the browser back to the agent that handed it over. */
  handBackLocalBrowser(handoffId: string): Promise<LocalBrowserPersonState>;
  /** End the agent's task. The browser stays open for the person. */
  stopLocalBrowserHandoff(handoffId: string): Promise<LocalBrowserPersonState>;
}
