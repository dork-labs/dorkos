import type {
  LocalBrowserPersonState,
  LocalBrowserOpen,
  LocalBrowserState,
} from '@dorkos/shared/local-browser';

/** The parts of the browser service a handoff steers. */
export interface HandoverBrowser {
  personTabs?(
    sessionId?: string
  ): Promise<Pick<LocalBrowserPersonState, 'waitingForTab' | 'openChatTabs' | 'idleTabToClose'>>;
  profileRemoval?: { assertAvailable(): void };
  state(sessionId?: string): Promise<LocalBrowserState>;
  usesPageLeases?(sessionId?: string): boolean;
  abandon?(sessionId: string): void | Promise<void>;
  capabilities(): { newWindow: boolean };
  currentProfileId(): string | null;
  /** Whether a named profile exists. False until startup wires the profile list. */
  profileExists(id: string): boolean;
  open(input: LocalBrowserOpen): Promise<LocalBrowserState>;
  selectTab(id: string, sessionId?: string): Promise<LocalBrowserState>;
  navigate(url: string, sessionId?: string): Promise<LocalBrowserState>;
  pause(sessionId?: string): Promise<LocalBrowserState>;
  handToPerson(sessionId?: string): Promise<LocalBrowserState>;
  resume(sessionId?: string): Promise<LocalBrowserState>;
  disconnect(sessionId?: string): Promise<LocalBrowserState>;
}

/** Where to put the agent back when the person hands the browser back. */
export interface ReopenAt {
  sessionId: string;
  profileId: string | null;
  url?: string;
}
