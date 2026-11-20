import type { LocalBrowserOpen, LocalBrowserSignInRequest } from '@dorkos/shared/local-browser';
import type { BrowserHandover } from '../handover.js';
import type { LocalBrowserService } from '../service.js';
import { LocalBrowserError } from '../errors.js';
import { signingInRefusal } from '../handoff-guards/done-signing-in.js';
import { emptyBrowserPersonState } from '../presentation.js';

/** Install-wide handoff arbitration; each chat retains its own Stop and handoff records. */
export class BrowserHandoverPool {
  private readonly wiring: ((handover: BrowserHandover) => void)[] = [];
  private preparing = false;

  constructor(private readonly service: LocalBrowserService) {}
  configure(handover: BrowserHandover): void {
    for (const wire of this.wiring) wire(handover);
  }
  private wire(run: (handover: BrowserHandover) => void): void {
    this.wiring.push(run);
    for (const session of this.service.pageSessions()) run(session.handover);
  }
  useOutsideTurnCheck(...args: Parameters<BrowserHandover['useOutsideTurnCheck']>) {
    this.wire((h) => h.useOutsideTurnCheck(...args));
  }
  useAgentIdLookup(...args: Parameters<BrowserHandover['useAgentIdLookup']>) {
    this.wire((h) => h.useAgentIdLookup(...args));
  }
  useChangeListener(...args: Parameters<BrowserHandover['useChangeListener']>) {
    this.wire((h) => h.useChangeListener(...args));
  }
  useHandoffListener(...args: Parameters<BrowserHandover['useHandoffListener']>) {
    this.wire((h) => h.useHandoffListener(...args));
  }
  useEndListener(...args: Parameters<BrowserHandover['useEndListener']>) {
    this.wire((h) => h.useEndListener(...args));
  }
  refuseStopped(id: string) {
    this.service.findSession(id)?.handover.refuseStopped(id);
  }
  refuseWhileSigningIn(id: string | null) {
    const target = this.service.findSession(id);
    if (
      target &&
      this.service
        .pageSessions()
        .some((session) => session.handover.signInHoldsProfile(target.currentProfileId()))
    )
      throw signingInRefusal();
  }
  isOpenFor(id: string) {
    return this.service.findSession(id)?.handover.isOpenFor(id) ?? false;
  }
  outsideTurnReason(id: string) {
    return this.service.findSession(id)?.handover.outsideTurnReason(id) ?? Promise.resolve(null);
  }
  requireAgentMayUse(id: string) {
    return this.forChat(id).requireAgentMayUse(id);
  }
  private forChat(id: string): BrowserHandover {
    const session = this.service.findSession(id);
    if (!session)
      throw new LocalBrowserError(
        'not_opened',
        'This chat’s browser is not open. Ask the person to open it.'
      );
    return session.handover;
  }
  state() {
    const active = this.service
      .pageSessions()
      .find((session) => session.handover.hasActiveHandoff());
    return active ? active.handover.state() : Promise.resolve(emptyBrowserPersonState());
  }
  async open(input: LocalBrowserOpen) {
    return this.service.openForPerson(input);
  }
  async ask(...args: Parameters<BrowserHandover['ask']>) {
    const [id] = args;
    const target = this.forChat(id);
    if (
      this.preparing ||
      this.service
        .pageSessions()
        .some((session) => session.handover !== target && session.handover.hasActiveHandoff())
    )
      throw new LocalBrowserError(
        'busy',
        'A browser handoff is in progress. Wait until it finishes.'
      );
    this.preparing = true;
    try {
      return await target.ask(...args);
    } finally {
      this.preparing = false;
    }
  }
  signIn(input: Extract<LocalBrowserSignInRequest, { handoffId: string }>) {
    return this.forHandoff(input.handoffId).signIn(input);
  }
  finishSignIn(id: string) {
    return this.forHandoff(id).finishSignIn(id);
  }
  handBack(id: string) {
    return this.forHandoff(id).handBack(id);
  }
  stop(id: string) {
    return this.forHandoff(id).stop(id);
  }
  private forHandoff(id: string): BrowserHandover {
    const session = this.service.pageSessions().find((entry) => entry.handover.ownsHandoff(id));
    if (!session) throw new LocalBrowserError('handoff_ended', 'This handoff already ended.');
    return session.handover;
  }
  holdsProfile(id: string | null) {
    return this.service.pageSessions().some((session) => session.handover.holdsProfile(id));
  }
  forgetProfileState(id: string | null) {
    for (const session of this.service.pageSessions()) session.handover.forgetProfileState(id);
  }
}
