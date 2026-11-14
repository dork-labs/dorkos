import type {
  LocalBrowserCapabilities,
  LocalBrowserOpen,
  LocalBrowserPersonState,
  LocalBrowserProfile,
  LocalBrowserSignInRequest,
  LocalBrowserState,
} from './local-browser.js';

/** Human controls for a local, live browser; agent actions use a separate scoped tool surface. */
export interface LocalBrowserTransport {
  /** Scan profile metadata only after a person taps Find my browsers. Never cache the response. */
  scanYourBrowsers(): Promise<import('./your-browser.js').YourBrowserScan>;
  getLocalBrowserState(sessionId?: string): Promise<LocalBrowserPersonState>;
  getLocalBrowserCapabilities(): Promise<LocalBrowserCapabilities>;
  /** Profile metadata for the person's browser controls. */
  listLocalBrowserProfiles(): Promise<{ profiles: LocalBrowserProfile[] }>;
  /** Forget every site in one profile; null selects the shared default. */
  forgetLocalBrowserSignIns(profileId: string | null): Promise<{ success: true }>;
  /** Remove a named profile, its saved site data and agent access. */
  deleteLocalBrowserProfile(profileId: string): Promise<{ success: true }>;
  openLocalBrowser(input: LocalBrowserOpen): Promise<LocalBrowserPersonState>;
  closeIdleLocalBrowserTab(
    targetSessionId: string,
    sessionId: string
  ): Promise<LocalBrowserPersonState>;
  selectLocalBrowserTab(id: string, sessionId?: string): Promise<LocalBrowserState>;
  navigateLocalBrowser(url: string, sessionId?: string): Promise<LocalBrowserState>;
  pauseLocalBrowser(sessionId?: string): Promise<LocalBrowserState>;
  resumeLocalBrowser(sessionId?: string): Promise<LocalBrowserPersonState>;
  disconnectLocalBrowser(sessionId?: string): Promise<LocalBrowserPersonState>;
  /** Open the plain sign-in window, which no agent can reach. */
  signInLocalBrowser(input: LocalBrowserSignInRequest): Promise<LocalBrowserPersonState>;
  /** Give the browser back to the agent that handed it over. */
  handBackLocalBrowser(handoffId: string): Promise<LocalBrowserPersonState>;
  /** End the agent's task. The browser stays open for the person. */
  stopLocalBrowserHandoff(handoffId: string): Promise<LocalBrowserPersonState>;
}
