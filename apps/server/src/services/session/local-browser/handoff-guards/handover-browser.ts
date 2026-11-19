/**
 * The parts of the browser service a handoff steers, apart so the handover's guards can name
 * them without importing the handover itself.
 *
 * @module services/session/local-browser/handoff-guards/handover-browser
 */
import type {
  LocalBrowserHistoryDirection,
  LocalBrowserOpen,
  LocalBrowserState,
} from '@dorkos/shared/local-browser';

/** The parts of the browser service a handoff steers. */
export interface HandoverBrowser {
  profileRemoval?: { assertAvailable(): void };
  state(): Promise<LocalBrowserState>;
  capabilities(): { newWindow: boolean };
  currentProfileId(): string | null;
  /** The host of the page DorkOS last read, when that reading was a refusal (DOR-4097). */
  lastRefusalHost?(): string | null;
  /** Whether a named profile exists. False until startup wires the profile list. */
  profileExists(id: string): boolean;
  open(input: LocalBrowserOpen): Promise<LocalBrowserState>;
  selectTab(id: string): Promise<LocalBrowserState>;
  navigate(url: string, options?: { httpFallback?: boolean }): Promise<LocalBrowserState>;
  stepHistory(direction: LocalBrowserHistoryDirection): Promise<LocalBrowserState>;
  pause(): Promise<LocalBrowserState>;
  handToPerson(): Promise<LocalBrowserState>;
  resume(): Promise<LocalBrowserState>;
  disconnect(): Promise<LocalBrowserState>;
}
