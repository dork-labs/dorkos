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
  getLocalBrowserState(): Promise<LocalBrowserPersonState>;
  getLocalBrowserCapabilities(): Promise<LocalBrowserCapabilities>;
  /** Profile metadata for the person's browser controls. */
  listLocalBrowserProfiles(): Promise<{ profiles: LocalBrowserProfile[] }>;
  /** Forget every site in one profile; null selects the shared default. */
  forgetLocalBrowserSignIns(profileId: string | null): Promise<{ success: true }>;
  /** Remove a named profile, its saved site data and agent access. */
  deleteLocalBrowserProfile(profileId: string): Promise<{ success: true }>;
  openLocalBrowser(input: LocalBrowserOpen): Promise<LocalBrowserPersonState>;
  selectLocalBrowserTab(id: string): Promise<LocalBrowserState>;
  /** A person's navigation, which takes the page from an agent sharing it (DOR-4428). */
  navigateLocalBrowser(url: string): Promise<LocalBrowserPersonState>;
  /** Take the page from the chat it is shared with, until the person resumes the agent. */
  takeOverLocalBrowser(): Promise<LocalBrowserPersonState>;
  pauseLocalBrowser(): Promise<LocalBrowserState>;
  resumeLocalBrowser(): Promise<LocalBrowserPersonState>;
  disconnectLocalBrowser(): Promise<LocalBrowserPersonState>;
  /** Open the plain sign-in window, which no agent can reach. */
  signInLocalBrowser(input: LocalBrowserSignInRequest): Promise<LocalBrowserPersonState>;
  /** Give the browser back to the agent that handed it over. */
  handBackLocalBrowser(handoffId: string): Promise<LocalBrowserPersonState>;
  /** End the agent's task. The browser stays open for the person. */
  stopLocalBrowserHandoff(handoffId: string): Promise<LocalBrowserPersonState>;
}
