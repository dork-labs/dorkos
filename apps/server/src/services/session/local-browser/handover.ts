/**
 * Handing the Agent browser to the person and back (DOR-3218).
 *
 * An agent that meets a step only a person can finish hands the browser over.
 * From then until the person presses Hand back or Stop task, the agent can't
 * read or use the browser. A separate window becomes a plain browser;
 * the Mac app’s view keeps its page with the debugger detached. This record is the one source
 * every place that shows the handoff reads.
 */
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import type {
  LocalBrowserHandoff,
  LocalBrowserHandoffOutcome,
  LocalBrowserHandoffReason,
  LocalBrowserOpen,
  LocalBrowserPersonState,
  LocalBrowserSignInRequest,
  LocalBrowserState,
} from '@dorkos/shared/local-browser';
import { logger } from '../../../lib/logger.js';
import { LocalBrowserError } from './errors.js';
import { prepareProfileFolder } from './profile-folders.js';
import type { SignInWindow } from './sign-in-window.js';

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

import { assertSignInUrl, siteOnly } from './handover/urls.js';
export { assertSignInUrl, siteOnly } from './handover/urls.js';

/** One handoff at a time, and the plain sign-in window it can open. */
export class BrowserHandover {
  private signingIn = 0;
  private preparingHandoff = false;
  private preparingFor: string | null = null;
  private answeringHandoff = false;

  /** Includes preparation, saving, and a handoff that can reopen this profile. */
  holdsProfile(profileId: string | null): boolean {
    return (
      this.preparingHandoff ||
      this.signingIn > 0 ||
      this.signIns.holds(this.folderOf(profileId)) ||
      (this.record?.outcome === null && this.record.profileId === profileId)
    );
  }

  /** Clear stale success notices only after the disk operation succeeded. */
  forgetProfileState(profileId: string | null): void {
    this.signIns.forgetSaved(profileId);
    this.changed();
  }
  private record: LocalBrowserHandoff | null = null;
  private reopenAt?: ReopenAt;
  // The agent's page when it asked. Saved here, so Continue never takes a URL from the agent.
  private askedUrl?: string;
  // After Stop task the browser stays open for the person (2FA, a payment), so that
  // chat reads nothing until a person opens or resumes the browser for it again.
  private readonly stoppedFor = new Set<string>();
  // Fails closed until startup says how to read a turn's marks.
  private outsideTurn: OutsideTurnCheck = async () => true;
  // The registry id of the agent in a folder; none until startup wires the mesh.
  private agentIdAt: (agentFolder: string) => string | undefined = () => undefined;
  private changed: () => void = () => undefined;
  private handedOver: (handoff: LocalBrowserHandoff) => void = () => undefined;
  private ended: (handoff: LocalBrowserHandoff) => void = () => undefined;

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

  /** Set once at startup: the mesh registry's id for the agent in a folder. */
  useAgentIdLookup(lookup: (agentFolder: string) => string | undefined): void {
    this.agentIdAt = lookup;
  }

  /**
   * Set once at startup: called when a handoff starts or ends, or a sign-in moves,
   * so an open card re-reads the state instead of polling for it.
   *
   * @param listener - Told that something changed, and nothing else.
   */
  useChangeListener(listener: () => void): void {
    this.changed = listener;
    this.signIns.onChange(listener);
  }

  /**
   * Set once at startup: called once for each new handoff, for the Inbox's record.
   *
   * @param listener - Given the new handoff.
   */
  useHandoffListener(listener: (handoff: LocalBrowserHandoff) => void): void {
    this.handedOver = listener;
  }

  /**
   * Set once at startup: called once when a handoff ends, with its outcome (DOR-3112).
   *
   * @param listener - Given the ended handoff.
   */
  useEndListener(listener: (handoff: LocalBrowserHandoff) => void): void {
    this.ended = listener;
  }

  /**
   * What a person's controls see. While a person has the browser, each tab shows
   * only its site, with no title: a sign-in page's path, query or fragment can carry
   * a code or token, a title can carry private text, and this state is read by more
   * than the person's own window (DOR-4163).
   */
  async state(sessionId?: string): Promise<LocalBrowserPersonState> {
    const before = this.record?.outcome === null ? this.record : null;
    // The global handoff card must follow the held tab, not the last chat that opened one.
    const scope =
      sessionId ??
      (before && this.browser.usesPageLeases?.(before.sessionId) ? before.sessionId : undefined);
    const tabs = await this.browser.personTabs?.(scope);
    const state = this.trimmed(await this.browser.state(scope));
    const open = this.record?.outcome === null ? this.record : null;
    // A handoff can start while state is being read. Never pair its card with another tab.
    if (
      sessionId === undefined &&
      open &&
      state.sessionId !== open.sessionId &&
      this.browser.usesPageLeases?.(open.sessionId)
    )
      return this.state(open.sessionId);
    const elsewhere =
      state.status === 'connected' &&
      state.mode === 'new-window' &&
      sessionId !== undefined &&
      open &&
      open.sessionId !== sessionId &&
      this.browser.usesPageLeases?.(open.sessionId);
    return {
      ...state,
      ...tabs,
      handoff: sessionId === undefined || this.record?.sessionId === sessionId ? this.record : null,
      signIn: this.signIns.current,
      signInElsewhere: elsewhere ? { handoffId: open.id } : null,
      handoffAttached:
        !!open &&
        (sessionId === undefined || sessionId === open.sessionId) &&
        !!this.browser.usesPageLeases?.(open.sessionId),
    };
  }

  /** A person's Pause, answered with the same trimmed tabs as {@link state}. */
  async pause(sessionId?: string): Promise<LocalBrowserState> {
    return this.trimmed(await this.browser.pause(sessionId));
  }

  /** Every tab cut to its site, with no title, while a person has the browser. */
  private trimmed(state: LocalBrowserState): LocalBrowserState {
    if (this.record?.outcome !== null) return state;
    if (this.record.sessionId !== state.sessionId && this.browser.usesPageLeases?.()) return state;
    const tabs = state.tabs.map((tab) => ({ ...tab, url: siteOnly(tab.url), title: '' }));
    return { ...state, tabs };
  }

  /**
   * Refuse an agent's browser call while a person has the browser.
   *
   * @param sessionId - The calling chat.
   */
  async requireAgentMayUse(sessionId: string): Promise<void> {
    this.refuseStopped(sessionId);
    if (
      (this.preparingHandoff &&
        (this.preparingFor === sessionId ||
          !this.browser.usesPageLeases?.(this.preparingFor ?? undefined))) ||
      (this.record?.outcome === null &&
        (this.record.sessionId === sessionId ||
          !this.browser.usesPageLeases?.(this.record.sessionId)))
    ) {
      // QA reads these: every browser call an agent tried while a person had the browser.
      logger.info('[Browser] Refused an agent call during a handoff', {
        handoffId: this.record?.id,
        sessionId,
      });
      throw new LocalBrowserError(
        'handed_to_person',
        'A person has the browser. Wait until they hand it back.'
      );
    }
    if (this.signIns.active && (await this.signInOnAgentProfile()))
      throw new LocalBrowserError('signing_in', 'A person is signing in. Wait until they finish.');
  }

  /** A different tab can steal focus with a popup during sign-in. Reads stay scoped and usable. */
  requireAgentMayAct(): void {
    if (
      this.preparingHandoff ||
      this.answeringHandoff ||
      this.record?.outcome === null ||
      this.signingIn > 0 ||
      this.signIns.active
    )
      throw new LocalBrowserError(
        'signing_in_elsewhere',
        'The person is signing in for another chat. Acting is paused until they finish. Reading still works.'
      );
  }

  /**
   * The agent hands the browser to the person and stops.
   *
   * @param sessionId - The calling chat, already checked as the one the browser is shared with.
   * @param reason - Why: a password or sign-in, or another step only a person can finish.
   * @param asker - The asking agent's name and folder from its verified identity, for the person's card.
   */
  async ask(
    sessionId: string,
    reason: LocalBrowserHandoffReason,
    asker: { name: string; folder: string } | null = null
  ): Promise<{ handoffId: string; site: string; next: string }> {
    // A stranger's words must not be able to raise a window or ask the person anything.
    if (await this.outsideTurn(sessionId))
      throw new LocalBrowserError(
        'outside_turn',
        'This turn read words from outside your team, so it can’t hand the browser to a person.'
      );
    this.refuseStopped(sessionId);
    if (this.preparingHandoff || this.answeringHandoff)
      throw new LocalBrowserError('busy', 'The browser handoff is changing. Wait a moment.');
    const open = this.record?.outcome === null ? this.record : null;
    if (open?.sessionId === sessionId)
      return { handoffId: open.id, site: open.site, next: HANDED_OVER_NEXT };
    if (open || this.signIns.active)
      throw new LocalBrowserError('busy', 'A browser handoff is already open. Finish it first.');
    this.preparingHandoff = true;
    this.preparingFor = sessionId;
    try {
      return await this.prepareHandoff(sessionId, reason, asker);
    } finally {
      this.preparingHandoff = false;
      this.preparingFor = null;
    }
  }

  private async prepareHandoff(
    sessionId: string,
    reason: LocalBrowserHandoffReason,
    asker: { name: string; folder: string } | null
  ) {
    const state = await this.browser.state(sessionId);
    const tab = state.tabs.find((candidate) => candidate.id === state.selectedTabId);
    if (state.status !== 'connected' || !tab)
      throw new LocalBrowserError('no_tab', 'Choose the tab your agent should use.');
    const site = new URL(tab.url).host;
    if (!site) throw new LocalBrowserError('no_site', 'Open the website first, then ask again.');
    if (state.mode === 'new-window') assertSignInUrl(tab.url);
    await this.browser.handToPerson(sessionId);
    const profileId = this.browser.currentProfileId();
    this.record = {
      id: randomUUID(),
      sessionId,
      agentName: asker?.name ?? null,
      agentId: asker ? (this.agentIdAt(asker.folder) ?? null) : null,
      agentFolder: asker?.folder ?? null,
      profileId: this.browser.currentProfileId(),
      reason,
      site,
      askedAt: new Date(this.now()).toISOString(),
      outcome: null,
    };
    this.reopenAt = undefined;
    this.askedUrl = tab.url;
    if (state.mode === 'new-window' && !this.browser.usesPageLeases?.(sessionId)) {
      this.reopenAt = { sessionId, profileId, url: tab.url };
      // No page-reading connection, automation pipe or theme extension survives
      // into the person's window. Form fields do not survive this deliberate swap.
      await this.browser.disconnect();
      const folder = await prepareProfileFolder(this.dataDirectory(), profileId);
      await this.signIns.start(folder, profileId, assertSignInUrl(tab.url).href);
    }
    // Bring the agent's window to the person. Its strip and card are drawn by DorkOS.
    if (state.mode === 'embedded')
      await this.browser.selectTab(tab.id, sessionId).catch(() => undefined);
    this.changed();
    this.handedOver(this.record);
    logger.info('[Browser] An agent handed the browser to a person', {
      handoffId: this.record.id,
      sessionId,
      site,
      reason,
    });
    return { handoffId: this.record.id, site, next: HANDED_OVER_NEXT };
  }

  /**
   * Open the plain sign-in window. Person only.
   *
   * @param input - A page the person typed, or the open handoff, whose site is the agent's current page.
   */
  async signIn(input: LocalBrowserSignInRequest): Promise<LocalBrowserPersonState> {
    this.browser.profileRemoval?.assertAvailable();
    this.signingIn++;
    try {
      return await this.startSignIn(input);
    } finally {
      this.signingIn--;
    }
  }

  private async startSignIn(input: LocalBrowserSignInRequest): Promise<LocalBrowserPersonState> {
    const state = await this.browser.state();
    let url: URL;
    let profileId: string | null;
    if ('handoffId' in input) {
      const handoff = this.openHandoff(input.handoffId);
      if (this.browser.usesPageLeases?.(handoff.sessionId)) {
        const shared = await this.browser.state(handoff.sessionId);
        if (shared.selectedTabId)
          await this.browser.selectTab(shared.selectedTabId, handoff.sessionId);
        return this.state(handoff.sessionId);
      }
      this.assertProfileExists(this.browser.currentProfileId());
      if (state.mode === 'embedded' && state.status === 'connected') {
        await this.browser.handToPerson();
        return this.state();
      }
      if (this.reopenAt?.url) {
        if (!this.signIns.active) {
          // The saved page's profile can differ from the current one; refuse it too (DOR-4180).
          this.assertProfileExists(this.reopenAt.profileId);
          const folder = await prepareProfileFolder(this.dataDirectory(), this.reopenAt.profileId);
          await this.signIns.start(
            folder,
            this.reopenAt.profileId,
            assertSignInUrl(this.reopenAt.url).href
          );
        }
        return this.state();
      }
      // The origin the agent's browser is on now, never one the agent named.
      const tab = state.tabs.find((candidate) => candidate.id === state.selectedTabId);
      if (!tab) throw new LocalBrowserError('no_tab', 'Open the website first, then try again.');
      // The card names the site the agent asked on. A page that moved since then
      // (a redirect, a click) must not get the person's sign-in under that name.
      if (new URL(tab.url).host !== handoff.site)
        throw new LocalBrowserError(
          'site_changed',
          `The page left ${handoff.site}. Check the browser, then try again.`
        );
      url = assertSignInUrl(new URL(tab.url).origin);
      profileId = this.browser.currentProfileId();
      this.reopenAt = { sessionId: handoff.sessionId, profileId, url: this.askedUrl ?? tab.url };
    } else {
      url = assertSignInUrl(input.url);
      profileId = input.profileId ?? null;
      this.assertProfileExists(profileId);
    }
    if (this.browser.usesPageLeases?.() && this.browser.currentProfileId() === profileId)
      throw new LocalBrowserError(
        'profile_busy',
        'Close the Agent browser before opening a separate sign-in window.'
      );
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
   * Refuse a sign-in on a named profile that's gone, before any folder is made: making
   * one would bring a deleted profile back, with no entry to see or delete it (DOR-4180).
   * The default profile has no id and always exists.
   *
   * @param profileId - The profile the sign-in would land in.
   */
  private assertProfileExists(profileId: string | null): void {
    if (profileId !== null && !this.browser.profileExists(profileId))
      throw new LocalBrowserError('profile_not_found', 'That browser profile no longer exists.');
  }

  /**
   * The person gives the browser back to the agent. Person only.
   *
   * @param handoffId - The handoff being answered.
   */
  async handBack(handoffId: string): Promise<LocalBrowserPersonState> {
    const handoff = this.openHandoff(handoffId);
    this.answeringHandoff = true;
    try {
      return await this.finishHandBack(handoff);
    } finally {
      this.answeringHandoff = false;
    }
  }

  private async finishHandBack(handoff: LocalBrowserHandoff): Promise<LocalBrowserPersonState> {
    if (this.signIns.active) throw new LocalBrowserError('signing_in', 'Finish signing in first.');
    const reopenAt = this.reopenAt;
    if (reopenAt && this.signIns.current?.status === 'failed')
      throw new LocalBrowserError(
        'sign_in_failed',
        'Couldn’t save your sign-in. Open the sign-in window again.'
      );
    const state = await this.browser.state(handoff.sessionId);
    if (reopenAt && state.status === 'disconnected')
      await this.browser.open({
        mode: 'new-window',
        sessionId: reopenAt.sessionId,
        ...(reopenAt.profileId ? { profileId: reopenAt.profileId } : {}),
        ...(reopenAt.url ? { url: reopenAt.url } : {}),
      });
    else await this.browser.resume(handoff.sessionId);
    this.end(handoff, 'handed-back');
    return this.state(handoff.sessionId);
  }

  /**
   * The person ends the agent's task. The browser stays open for the person, and
   * that chat can't read or use it until a person opens or resumes it again.
   * Person only; the app stops the chat's turn itself.
   *
   * @param handoffId - The handoff being answered.
   */
  async stop(handoffId: string): Promise<LocalBrowserPersonState> {
    const handoff = this.openHandoff(handoffId);
    this.answeringHandoff = true;
    try {
      this.stoppedFor.add(handoff.sessionId);
      await this.browser.pause(handoff.sessionId);
      await this.browser.abandon?.(handoff.sessionId);
      this.end(handoff, 'stopped');
      return this.state(handoff.sessionId);
    } finally {
      this.answeringHandoff = false;
    }
  }

  /**
   * A person's open goes through here, so it can't take a profile a sign-in holds, or
   * close a window out from under a person partway through another chat's handoff.
   *
   * @param input - The person's choice.
   */
  async open(input: LocalBrowserOpen): Promise<LocalBrowserPersonState> {
    if (this.preparingHandoff || this.answeringHandoff)
      throw new LocalBrowserError('busy', 'The browser handoff is changing. Wait a moment.');
    if (
      this.record?.sessionId !== input.sessionId &&
      !(
        input.mode === 'new-window' &&
        this.browser.usesPageLeases?.() &&
        this.browser.currentProfileId() === (input.profileId ?? null)
      )
    )
      this.refuseDuringHandoff();
    if (input.mode === 'new-window' && this.signIns.holds(this.folderOf(input.profileId ?? null)))
      throw new LocalBrowserError('signing_in', 'Finish signing in first.');
    if (this.record?.outcome === null && this.record.sessionId === input.sessionId) {
      if (this.browser.usesPageLeases?.(input.sessionId)) return this.state(input.sessionId);
      const handoff = this.record;
      if (input.mode === 'new-window') {
        const url = assertSignInUrl(this.askedUrl ?? input.url ?? '').href;
        await this.browser.disconnect();
        this.reopenAt = { sessionId: handoff.sessionId, profileId: handoff.profileId, url };
        const folder = await prepareProfileFolder(this.dataDirectory(), handoff.profileId);
        await this.signIns.start(folder, handoff.profileId, url);
      } else {
        await this.browser.open({ ...input, url: this.askedUrl ?? input.url });
        await this.browser.handToPerson();
      }
    } else {
      await this.browser.open(input);
    }
    this.stoppedFor.delete(input.sessionId ?? '');
    return this.state(input.sessionId);
  }

  /** The window closed on its own, so a card saying "finish it in the window" re-reads the state. */
  waitingForPerson(sessionId: string): boolean {
    return this.record?.sessionId === sessionId && this.record.outcome === null;
  }
  tabClosed(sessionId: string): void {
    if (this.record?.outcome === null && this.record.sessionId === sessionId) {
      this.stoppedFor.add(sessionId);
      this.end(this.record, 'window-closed');
    }
  }
  windowClosed(): void {
    this.changed();
  }

  /**
   * A person's Resume answers an open handoff as Hand back, so the agent is never
   * unpaused while the record still says a person has the browser.
   */
  async resume(sessionId?: string): Promise<LocalBrowserPersonState> {
    if (this.preparingHandoff || this.answeringHandoff)
      throw new LocalBrowserError('busy', 'The browser handoff is changing. Wait a moment.');
    if (
      this.record?.outcome === null &&
      (sessionId === undefined || this.record.sessionId === sessionId)
    )
      return this.handBack(this.record.id);
    if (this.signIns.active)
      throw new LocalBrowserError('signing_in', 'Close the sign-in window first.');
    const resumed = await this.browser.resume(sessionId);
    this.stoppedFor.delete(resumed.sessionId ?? '');
    return this.state(sessionId);
  }

  /**
   * A person's tab choice. Raising the agent's own tab is how Show window works. Any
   * other tab would move the page out from under an open card.
   *
   * @param id - The tab to select.
   */
  async selectTab(id: string, sessionId?: string): Promise<LocalBrowserState> {
    if (
      this.record?.outcome === null &&
      (sessionId === undefined || this.record.sessionId === sessionId) &&
      id !== (await this.browser.state(sessionId)).selectedTabId
    )
      this.refuseDuringHandoff();
    return this.trimmed(await this.browser.selectTab(id, sessionId));
  }

  /**
   * A person's address bar, refused during a handoff so the page can't leave the site
   * the card names.
   *
   * @param url - The address to open.
   */
  async navigate(url: string, sessionId?: string): Promise<LocalBrowserState> {
    this.refuseDuringHandoff(sessionId);
    return this.browser.navigate(url, sessionId);
  }

  /**
   * A person's Disconnect. During a handoff it ends as Stop task does, so no card stays
   * up over a closed window. If the window won't close, the handoff stays open.
   */
  async disconnect(sessionId?: string): Promise<LocalBrowserPersonState> {
    if (this.preparingHandoff || this.answeringHandoff)
      throw new LocalBrowserError('busy', 'The browser handoff is changing. Wait a moment.');
    await this.browser.disconnect(sessionId);
    if (
      this.record?.outcome === null &&
      (sessionId === undefined || this.record.sessionId === sessionId)
    ) {
      this.stoppedFor.add(this.record.sessionId);
      this.end(this.record, 'window-closed');
    }
    return this.state(sessionId);
  }

  /**
   * Refuse a chat whose task a person stopped. Checked before sharing, so a chat whose
   * browser a person also closed still learns the person stopped it.
   *
   * @param sessionId - The calling chat.
   */
  refuseStopped(sessionId: string): void {
    if (this.stoppedFor.has(sessionId))
      throw new LocalBrowserError(
        'task_stopped',
        'The person stopped this task. They can open the browser for you again.'
      );
  }

  private refuseDuringHandoff(sessionId?: string): void {
    if (
      this.record?.outcome === null &&
      (sessionId === undefined || this.record.sessionId === sessionId)
    )
      throw new LocalBrowserError(
        'handoff_open',
        'An agent is waiting on you in this browser. Answer its card first.'
      );
  }

  private openHandoff(id: string): LocalBrowserHandoff {
    if (this.preparingHandoff || this.answeringHandoff)
      throw new LocalBrowserError('busy', 'The browser handoff is changing. Wait a moment.');
    if (!this.record || this.record.id !== id || this.record.outcome !== null)
      throw new LocalBrowserError('handoff_ended', 'This handoff already ended.');
    return this.record;
  }

  private end(handoff: LocalBrowserHandoff, outcome: LocalBrowserHandoffOutcome): void {
    if (this.record?.id === handoff.id) this.record = { ...handoff, outcome };
    logger.info('[Browser] A browser handoff ended', { handoffId: handoff.id, outcome });
    this.reopenAt = undefined;
    this.askedUrl = undefined;
    this.changed();
    // A handoff ends once (openHandoff refuses an ended one), so this fires once.
    this.ended({ ...handoff, outcome });
  }

  private async signInOnAgentProfile(): Promise<boolean> {
    return this.signIns.holds(this.folderOf(this.browser.currentProfileId()));
  }

  /** The folder `prepareProfileFolder` gives a profile, without touching the disk. */
  private folderOf(profileId: string | null): string {
    return path.join(this.dataDirectory(), 'browser-profiles', profileId ?? 'default');
  }
}
