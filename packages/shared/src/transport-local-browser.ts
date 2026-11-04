import type {
  LocalBrowserCapabilities,
  LocalBrowserOpen,
  LocalBrowserPersonState,
  LocalBrowserSignInRequest,
  LocalBrowserState,
} from './local-browser.js';

/** Human controls for a local, live browser; agent actions use a separate scoped tool surface. */
export interface LocalBrowserTransport {
  /** Scan profile metadata only after a person taps Find my browsers. Never cache the response. */
  scanYourBrowsers(): Promise<import('./your-browser.js').YourBrowserScan>;
  getLocalBrowserState(): Promise<LocalBrowserPersonState>;
  getLocalBrowserCapabilities(): Promise<LocalBrowserCapabilities>;
  openLocalBrowser(input: LocalBrowserOpen): Promise<LocalBrowserPersonState>;
  selectLocalBrowserTab(id: string): Promise<LocalBrowserState>;
  navigateLocalBrowser(url: string): Promise<LocalBrowserState>;
  pauseLocalBrowser(): Promise<LocalBrowserState>;
  resumeLocalBrowser(): Promise<LocalBrowserPersonState>;
  disconnectLocalBrowser(): Promise<LocalBrowserState>;
  /** Open the plain sign-in window, which no agent can reach. */
  signInLocalBrowser(input: LocalBrowserSignInRequest): Promise<LocalBrowserPersonState>;
  /** Give the browser back to the agent that handed it over. */
  handBackLocalBrowser(handoffId: string): Promise<LocalBrowserPersonState>;
  /** End the agent's task. The browser stays open for the person. */
  stopLocalBrowserHandoff(handoffId: string): Promise<LocalBrowserPersonState>;
}
