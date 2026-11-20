import { LocalBrowserError } from '../errors.js';
import type { HandoffCloseProof } from './handoff-close.js';
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

/** Where to put the agent back when the person hands the browser back. */
export interface HandoffReopenAt {
  sessionId: string;
  profileId: string | null;
  url?: string;
}

/** The parts of the browser service a handoff steers. */
export interface HandoverBrowser {
  /** A physical profile swap needs exclusive custody. */
  requireExclusiveProfile?(profileId?: string | null): void;
  /** Page custody also applies without a handoff record. */
  requireAgentPage?(): void;
  profileRemoval?: { assertAvailable(): void };
  state(): Promise<LocalBrowserState>;
  /** Only the exact Page session can certify its own completed close. */
  captureHandoffClose?(state: LocalBrowserState, profileId: string | null): HandoffCloseProof;
  capabilities(): { newWindow: boolean };
  currentProfileId(): string | null;
  /** The host of the page DorkOS last read, when that reading was a refusal (DOR-4097). */
  lastRefusalHost?(): string | null;
  /** Opaque server-only connection/tab/URL identity, rechecked across handoff awaits. */
  refusalIdentity?(): string | null;
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

/** The default profile always exists; a deleted saved profile cannot be reopened by a handoff. */
export function assertHandoffProfileExists(
  browser: HandoverBrowser,
  profileId: string | null
): void {
  if (profileId !== null && !browser.profileExists(profileId))
    throw new LocalBrowserError('profile_not_found', 'That browser profile no longer exists.');
}
