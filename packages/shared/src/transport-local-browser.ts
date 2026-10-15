import type {
  LocalBrowserCapabilities,
  LocalBrowserOpen,
  LocalBrowserState,
} from './local-browser.js';

/** Human controls for a local, live browser; agent actions use a separate scoped tool surface. */
export interface LocalBrowserTransport {
  getLocalBrowserState(): Promise<LocalBrowserState>;
  getLocalBrowserCapabilities(): Promise<LocalBrowserCapabilities>;
  openLocalBrowser(input: LocalBrowserOpen): Promise<LocalBrowserState>;
  selectLocalBrowserTab(id: string): Promise<LocalBrowserState>;
  navigateLocalBrowser(url: string): Promise<LocalBrowserState>;
  pauseLocalBrowser(): Promise<LocalBrowserState>;
  resumeLocalBrowser(): Promise<LocalBrowserState>;
  disconnectLocalBrowser(): Promise<LocalBrowserState>;
}
