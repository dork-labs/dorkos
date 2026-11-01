/**
 * Handing the Agent browser to the person and back (DOR-3218).
 *
 * An agent that meets a step only a person can finish hands the browser over.
 * From then until the person presses Hand back or Stop task, the agent can't
 * read or use the browser. A password wall sends the person to the plain
 * sign-in window instead of the agent's window. This record is the one source
 * every place that shows the handoff reads.
 */
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import type {
  LocalBrowserHandoff,
  LocalBrowserHandoffReason,
  LocalBrowserOpen,
  LocalBrowserPersonState,
  LocalBrowserSignInRequest,
  LocalBrowserState,
} from '@dorkos/shared/local-browser';
import { LocalBrowserError } from './errors.js';
import { prepareProfileFolder } from './profile-folders.js';
import type { SignInWindow } from './sign-in-window.js';

/** The parts of the browser service a handoff steers. */
export interface HandoverBrowser {
  state(): Promise<LocalBrowserState>;
  currentProfileId(): string | null;
  open(input: LocalBrowserOpen): Promise<LocalBrowserState>;
  selectTab(id: string): Promise<LocalBrowserState>;
  pause(): Promise<LocalBrowserState>;
  resume(): Promise<LocalBrowserState>;
  disconnect(): Promise<LocalBrowserState>;
}

/** Whether a chat's current turn was started by, or read words from, someone outside the team. */
export type OutsideTurnCheck = (sessionId: string) => Promise<boolean>;

/** Where to put the agent back when the person hands the browser back. */
interface ReopenAt {
  sessionId: string;
  profileId: string | null;
  url?: string;
}

/** What the agent is told after it hands the browser over. */
export const HANDED_OVER_NEXT =
  'The person has the browser now. End your turn and wait. You get a message when they hand it back. Never ask again or retry on your own.';

/**
 * A sign-in page must be `https:`, or `http:` on this computer only.
 *
 * @param value - The address to open.
 */
export function assertSignInUrl(value: string): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new LocalBrowserError(
      'unsupported_address',
      'Use a website address starting with https.'
    );
  }
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && local))
    throw new LocalBrowserError(
      'unsupported_address',
      'Use a website address starting with https.'
    );
  return url;
}

/** One handoff at a time, and the plain sign-in window it can open. */
export class BrowserHandover {
  private record: LocalBrowserHandoff | null = null;
  private reopenAt?: ReopenAt;
  // Fails closed until startup says how to read a turn's marks.
  private outsideTurn: OutsideTurnCheck = async () => true;

  constructor(
    private readonly browser: HandoverBrowser,
    private readonly signIns: SignInWindow,
    /** The DorkOS data folder, read when needed. */
    private readonly dataDirectory: () => string,
    private readonly now: () => number = Date.now
  ) {}

  /** Set once at startup. */
  useOutsideTurnCheck(check: OutsideTurnCheck): void {
    this.outsideTurn = check;
  }

  /** What a person's controls see. */
  async state(): Promise<LocalBrowserPersonState> {
    return { ...(await this.browser.state()), handoff: this.record, signIn: this.signIns.current };
  }

  /**
   * Refuse an agent's browser call while a person has the browser.
   *
   * @param sessionId - The calling chat.
   */
  async requireAgentMayUse(sessionId: string): Promise<void> {
    if (this.record && this.record.outcome === null && this.record.sessionId === sessionId)
      throw new LocalBrowserError(
        'handed_to_person',
        'A person has the browser. Wait until they hand it back.'
      );
    if (this.signIns.active && (await this.signInOnAgentProfile()))
      throw new LocalBrowserError('signing_in', 'A person is signing in. Wait until they finish.');
  }

  /**
   * The agent hands the browser to the person and stops.
   *
   * @param sessionId - The calling chat, already checked as the one the browser is shared with.
   * @param reason - Why: a password or sign-in, or another step only a person can finish.
   */
  async ask(
    sessionId: string,
    reason: LocalBrowserHandoffReason
  ): Promise<{ handoffId: string; site: string; next: string }> {
    // A stranger's words must not be able to raise a window or ask the person anything.
    if (await this.outsideTurn(sessionId))
      throw new LocalBrowserError(
        'outside_turn',
        'This turn read words from outside your team, so it can’t hand the browser to a person.'
      );
    const open = this.record?.outcome === null ? this.record : null;
    if (open?.sessionId === sessionId)
      return { handoffId: open.id, site: open.site, next: HANDED_OVER_NEXT };
    const state = await this.browser.state();
    const tab = state.tabs.find((candidate) => candidate.id === state.selectedTabId);
    if (state.status !== 'connected' || !tab)
      throw new LocalBrowserError('no_tab', 'Choose the tab your agent should use.');
    const site = new URL(tab.url).host;
    if (!site) throw new LocalBrowserError('no_site', 'Open the website first, then ask again.');
    await this.browser.pause();
    this.record = {
      id: randomUUID(),
      sessionId,
      reason,
      site,
      askedAt: new Date(this.now()).toISOString(),
      outcome: null,
    };
    this.reopenAt = undefined;
    // Bring the agent's window to the person. Its strip and card are drawn by DorkOS.
    await this.browser.selectTab(tab.id).catch(() => undefined);
    return { handoffId: this.record.id, site, next: HANDED_OVER_NEXT };
  }

  /**
   * Open the plain sign-in window. Person only.
   *
   * @param input - A page the person typed, or the open handoff, whose site is the agent's current page.
   */
  async signIn(input: LocalBrowserSignInRequest): Promise<LocalBrowserPersonState> {
    const state = await this.browser.state();
    let url: URL;
    let profileId: string | null;
    if ('handoffId' in input) {
      const handoff = this.openHandoff(input.handoffId);
      if (state.mode === 'embedded')
        throw new LocalBrowserError('unsupported', 'Open the browser in a new window to sign in.');
      // The origin the agent's browser is on now, never one the agent named.
      const tab = state.tabs.find((candidate) => candidate.id === state.selectedTabId);
      if (!tab) throw new LocalBrowserError('no_tab', 'Open the website first, then try again.');
      url = assertSignInUrl(new URL(tab.url).origin);
      profileId = this.browser.currentProfileId();
      this.reopenAt = { sessionId: handoff.sessionId, profileId, url: tab.url };
    } else {
      url = assertSignInUrl(input.url);
      profileId = input.profileId ?? null;
    }
    const folder = await prepareProfileFolder(this.dataDirectory(), profileId);
    // Only one Chromium can hold a profile, so the agent's window on it closes first.
    if (
      state.mode === 'new-window' &&
      state.status !== 'disconnected' &&
      this.browser.currentProfileId() === profileId
    )
      await this.browser.disconnect();
    await this.signIns.start(folder, profileId, url.href);
    return this.state();
  }

  /**
   * The person gives the browser back to the agent. Person only.
   *
   * @param handoffId - The handoff being answered.
   */
  async handBack(handoffId: string): Promise<LocalBrowserPersonState> {
    const handoff = this.openHandoff(handoffId);
    if (this.signIns.active) throw new LocalBrowserError('signing_in', 'Finish signing in first.');
    const reopenAt = this.reopenAt;
    const state = await this.browser.state();
    if (reopenAt && state.status === 'disconnected')
      await this.browser.open({
        mode: 'new-window',
        sessionId: reopenAt.sessionId,
        ...(reopenAt.profileId ? { profileId: reopenAt.profileId } : {}),
        ...(reopenAt.url ? { url: reopenAt.url } : {}),
      });
    else await this.browser.resume();
    this.end(handoff, 'handed-back');
    return this.state();
  }

  /**
   * The person ends the agent's task. The browser stays paused. Person only;
   * the app stops the chat's turn itself.
   *
   * @param handoffId - The handoff being answered.
   */
  async stop(handoffId: string): Promise<LocalBrowserPersonState> {
    const handoff = this.openHandoff(handoffId);
    await this.browser.pause();
    this.end(handoff, 'stopped');
    return this.state();
  }

  /**
   * A person's open goes through here, so it can't take a profile a sign-in holds.
   * Opening the browser for another chat ends that chat's handoff.
   *
   * @param input - The person's choice.
   */
  async open(input: LocalBrowserOpen): Promise<LocalBrowserPersonState> {
    if (input.mode === 'new-window' && this.signIns.holds(this.folderOf(input.profileId ?? null)))
      throw new LocalBrowserError('signing_in', 'Finish signing in first.');
    await this.browser.open(input);
    if (this.record?.outcome === null && this.record.sessionId !== input.sessionId)
      this.end(this.record, 'stopped');
    return this.state();
  }

  /**
   * A person's Resume answers an open handoff as Hand back, so the agent is never
   * unpaused while the record still says a person has the browser.
   */
  async resume(): Promise<LocalBrowserPersonState> {
    if (this.record?.outcome === null) return this.handBack(this.record.id);
    await this.browser.resume();
    return this.state();
  }

  private openHandoff(id: string): LocalBrowserHandoff {
    if (!this.record || this.record.id !== id || this.record.outcome !== null)
      throw new LocalBrowserError('handoff_ended', 'This handoff already ended.');
    return this.record;
  }

  private end(handoff: LocalBrowserHandoff, outcome: 'handed-back' | 'stopped'): void {
    if (this.record?.id === handoff.id) this.record = { ...handoff, outcome };
    this.reopenAt = undefined;
  }

  private async signInOnAgentProfile(): Promise<boolean> {
    return this.signIns.holds(this.folderOf(this.browser.currentProfileId()));
  }

  /** The folder `prepareProfileFolder` gives a profile, without touching the disk. */
  private folderOf(profileId: string | null): string {
    return path.join(this.dataDirectory(), 'browser-profiles', profileId ?? 'default');
  }
}
