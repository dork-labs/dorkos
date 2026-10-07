import { randomBytes } from 'node:crypto';
import type { Request, Response } from 'express';
import { readCallerAuthority } from '../../../lib/caller-authority.js';
import { resolveDecisionAuthority } from '../../core/approvals/decision-authority.js';
import { verifyRequestAuth, verifiedRequestSession } from '../../core/auth/session-gate.js';
import { resolveCaller } from '../../../routes/room-caller.js';
import { authSessionRemovals } from '../../core/auth/session-removals.js';
import { BrowserGrantExpiry } from './grant-expiry.js';
import { BrowserApiRefusal } from './service.js';
import type { BrowserControllerActor, OwnedBrowserController } from './controller.js';

type Identity = Readonly<{
  owner: string;
  identity: object;
  sessionUserId?: string;
}>;

const originalIdentityRefusals = new WeakSet<object>();
/** Provenance of actual local auth refusal; producer-thrown errors remain unknown. */
export function isOriginalBrowserIdentityRefusal(value: unknown): boolean {
  return !!value && typeof value === 'object' && originalIdentityRefusals.has(value);
}
function identityRefusal(reason: BrowserApiRefusal['reason']): BrowserApiRefusal {
  const error = new BrowserApiRefusal(reason);
  originalIdentityRefusals.add(error);
  return error;
}

/** Private host identity bank. Session ids come only from the actual auth verifier. */
export class BrowserControllerIdentities {
  private readonly sessions = new Map<string, Identity>();
  private readonly locals = new Map<string, Identity>();

  private closed = false;
  private revision = 0;
  private readonly expiry: BrowserGrantExpiry;
  private readonly unsubscribe: () => void;
  private readonly losses = new Set<Promise<void>>();
  private readonly checks = new Set<Promise<BrowserControllerActor>>();
  private readonly closureRefusals = new WeakSet<object>();
  private revokeIdentity?: OwnedBrowserController['revokeController'];
  private closing?: Promise<void>;
  private readonly verifySession = verifyRequestAuth;
  private readonly sessionMetadata = verifiedRequestSession;

  constructor(events: Pick<typeof authSessionRemovals, 'subscribe'> = authSessionRemovals) {
    this.expiry = new BrowserGrantExpiry((identity) => this.lose(identity));
    const subscribe = events.subscribe.bind(events);
    this.unsubscribe = subscribe(({ sessionId, userId }) => {
      if (this.closed) return;
      this.revision++;
      const original = this.sessions.get(sessionId);
      if (original?.sessionUserId === userId) this.lose(original.identity);
    });
  }

  bindController(controller: Pick<OwnedBrowserController, 'revokeController'>): void {
    if (this.closed || this.revokeIdentity || this.sessions.size || this.locals.size)
      throw identityRefusal('inaccessible');
    this.revokeIdentity = controller.revokeController.bind(controller);
  }

  private lose(identity: object): void {
    for (const [id, original] of this.sessions)
      if (original.identity === identity) this.sessions.delete(id);
    for (const [id, original] of this.locals)
      if (original.identity === identity) this.locals.delete(id);
    this.expiry.remove(identity);
    if (!this.revokeIdentity) return;
    const operation = this.revokeIdentity(identity);
    this.losses.add(operation);
    void operation.then(
      () => this.losses.delete(operation),
      () => this.losses.delete(operation)
    );
  }

  pendingLosses(): number {
    return this.losses.size;
  }

  close(): Promise<void> {
    if (this.closing) return this.closing;
    this.closed = true;
    const retainedOperations = [...this.losses, ...this.checks];
    // Publish the original completion before entering any potentially reentrant closure.
    this.closing = Promise.resolve().then(async () => {
      let failed = false;
      let first: unknown;
      const record = (error: unknown) => {
        if (!failed) {
          failed = true;
          first = error;
        }
      };
      const originals = [...this.sessions.values(), ...this.locals.values()];
      for (const close of [
        this.unsubscribe,
        () => this.expiry.close(),
        ...originals.map((original) => () => this.lose(original.identity)),
      ]) {
        try {
          close();
        } catch (error) {
          record(error);
        }
      }
      const results = await Promise.allSettled([
        ...retainedOperations,
        ...this.losses,
        ...this.checks,
      ]);
      for (const result of results)
        if (
          result.status === 'rejected' &&
          (!result.reason ||
            typeof result.reason !== 'object' ||
            !this.closureRefusals.has(result.reason))
        )
          record(result.reason);
      if (failed) throw first;
    });
    return this.closing;
  }

  /** Login-off correlation capability; it proves possession, not cryptographic human identity. */
  issueLocal(req: Request, res: Response): string {
    if (this.closed) throw identityRefusal('unavailable');
    const authority = resolveDecisionAuthority(readCallerAuthority(req, res));
    const caller = resolveCaller(req, res);
    if (!authority.allowed || authority.posture !== 'local-trust' || caller.kind !== 'human')
      throw identityRefusal('unauthenticated');
    if (this.locals.size >= 128) throw identityRefusal('unavailable');
    const ticket = randomBytes(32).toString('base64url');
    this.locals.set(ticket, Object.freeze({ owner: caller.id, identity: Object.freeze({}) }));
    return ticket;
  }

  /** Stop future local admission and fence any retained readers of this exact original ticket. */
  revokeLocal(ticket: string): void {
    const original = this.locals.get(ticket);
    if (original) this.lose(original.identity);
  }

  /** Capture original headers once; future per-step checks query the actual server session store. */
  capture(
    req: Request,
    res: Response,
    localTicket?: string,
    onOriginalDenial?: (value: BrowserApiRefusal) => void
  ) {
    const refuseIdentity = (reason: Parameters<typeof identityRefusal>[0]) => {
      const value = identityRefusal(reason);
      onOriginalDenial?.(value);
      return value;
    };
    const headers = Object.freeze(
      Object.fromEntries(
        Object.entries(req.headers).map(([name, value]) => [
          name,
          Array.isArray(value) ? [...value] : value,
        ])
      )
    );
    let actor: BrowserControllerActor | undefined;
    let retained: Identity | undefined;
    let sessionId: string | undefined;
    let expiresAt = 0;
    let refreshing = false;
    const clear = () => {
      actor = undefined;
      if (retained) this.lose(retained.identity);
      const refusal = refuseIdentity('unauthenticated');
      // Only this bank's synchronous shutdown denial is expected during an
      // original check join. Producer-thrown errors never enter this set.
      if (this.closed) this.closureRefusals.add(refusal);
      throw refusal;
    };
    const posture = () => resolveDecisionAuthority(readCallerAuthority(req, res));
    const current = (): BrowserControllerActor | undefined => {
      const authority = posture();
      if (this.closed || !actor || !retained || !authority.allowed) return undefined;
      if (sessionId) {
        if (
          authority.posture !== 'signed-in-operator' ||
          Date.now() >= expiresAt ||
          this.sessions.get(sessionId) !== retained
        )
          return undefined;
      } else {
        const caller = resolveCaller(req, res);
        if (
          authority.posture !== 'local-trust' ||
          !localTicket ||
          this.locals.get(localTicket) !== retained ||
          caller.kind !== 'human' ||
          caller.id !== retained.owner
        )
          return undefined;
      }
      return actor;
    };
    const verify = async (): Promise<BrowserControllerActor> => {
      // Invalidate before fallible/awaited verification; no concurrent reader can borrow stale proof.
      actor = undefined;
      const authority = posture();
      if (this.closed || !authority.allowed) return clear();
      let identity: Identity;
      if (authority.posture === 'signed-in-operator') {
        const revision = this.revision;
        const user = await this.verifySession(
          { headers },
          { sessionFreshness: 'server-store', sessionFailure: 'propagate' }
        );
        if (this.closed || revision !== this.revision) return clear();
        const session = user?.credential === 'cookie' ? this.sessionMetadata(user) : undefined;
        if (!user || !session || session.userId !== user.userId || Date.now() >= session.expiresAt)
          return clear();
        const after = posture();
        if (!after.allowed || after.posture !== 'signed-in-operator') return clear();
        sessionId = session.id;
        expiresAt = session.expiresAt;
        const caller = resolveCaller(req, { locals: { ...res.locals, user } });
        if (caller.kind !== 'human') return clear();
        const existing = this.sessions.get(session.id);
        if (existing && (existing.sessionUserId !== session.userId || existing.owner !== caller.id))
          return clear();
        if (!existing && this.sessions.size >= 1024) return clear();
        identity =
          existing ??
          Object.freeze({
            owner: caller.id,
            sessionUserId: session.userId,
            identity: Object.freeze({}),
          });
        this.sessions.set(session.id, identity);
        this.expiry.set(identity.identity, identity.identity, session.expiresAt);
      } else {
        const caller = resolveCaller(req, res);
        const local = localTicket ? this.locals.get(localTicket) : undefined;
        if (!local || caller.kind !== 'human' || caller.id !== local.owner) return clear();
        identity = local;
        sessionId = undefined;
      }
      // One captured request cannot silently change controller identity after reauthentication.
      if (retained && retained !== identity) return clear();
      retained = identity;
      actor = Object.freeze({
        owner: identity.owner,
        credential: identity.identity,
        controllerIdentity: identity.identity,
      });
      if (!current()) return clear();
      return actor;
    };
    const refresh = async (): Promise<BrowserControllerActor> => {
      if (refreshing) throw identityRefusal('inaccessible');
      refreshing = true;
      const operation = verify();
      this.checks.add(operation);
      try {
        return await operation;
      } finally {
        this.checks.delete(operation);
        refreshing = false;
      }
    };
    return Object.freeze({ refresh, current });
  }
}
