import { randomUUID } from 'node:crypto';
import type { LocalBrowserHandoff } from '@dorkos/shared/local-browser';
import { logger } from '../../../../lib/logger.js';
import type { HandoverBrowser } from './contracts.js';

/** Stopped chats keep reserved person-held pages independently of the active sign-in. */
export class FallenChatTabs {
  private readonly known = new Map<string, LocalBrowserHandoff>();
  private readonly held = new Map<string, LocalBrowserHandoff>();
  private readonly delayed = new Set<string>();
  private readonly pending = new Map<
    string,
    { token: object; promise: Promise<LocalBrowserHandoff | null> }
  >();
  constructor(private readonly browser: HandoverBrowser) {}

  remember(handoff: LocalBrowserHandoff): void {
    if (handoff.outcome === 'window-closed') this.forget(handoff.sessionId);
    else if (this.browser.usesPageLeases?.(handoff.sessionId))
      this.known.set(handoff.sessionId, handoff);
  }
  forChat(sessionId?: string | null): LocalBrowserHandoff | undefined {
    return sessionId ? this.held.get(sessionId) : undefined;
  }
  byId(id: string): LocalBrowserHandoff | undefined {
    return [...this.held.values()].find((handoff) => handoff.id === id);
  }
  knows(sessionId: string): boolean {
    return this.known.has(sessionId);
  }
  defer(sessionId: string): void {
    this.delayed.add(sessionId);
  }
  isDeferred(sessionId: string): boolean {
    return this.delayed.has(sessionId);
  }
  drain(fall: (sessionId: string) => Promise<void>): void {
    for (const sessionId of this.delayed) {
      this.delayed.delete(sessionId);
      void fall(sessionId).catch((error: unknown) =>
        logger.warn('[Browser] Couldn’t hold a stopped tab', {
          sessionId,
          error: error instanceof Error ? error.message : String(error),
        })
      );
    }
  }
  get busy(): boolean {
    return this.pending.size > 0;
  }

  fall(sessionId: string, refuseAgent: () => void): Promise<LocalBrowserHandoff | null> {
    const pending = this.pending.get(sessionId);
    if (pending) return pending.promise;
    const prior = this.known.get(sessionId);
    if (
      !prior ||
      prior.outcome === 'window-closed' ||
      this.held.has(sessionId) ||
      !this.browser.usesPageLeases?.(sessionId) ||
      !this.browser.abandon
    )
      return Promise.resolve(null);
    // Deny new tools before the first asynchronous hold operation.
    refuseAgent();
    const token = {};
    const operation: Promise<LocalBrowserHandoff | null> = (async () => {
      await this.browser.abandon!(sessionId);
      if (this.pending.get(sessionId)?.token !== token) return null;
      const handoff = {
        ...prior,
        id: prior.outcome === null ? prior.id : randomUUID(),
        outcome: 'stopped' as const,
      };
      this.held.set(sessionId, handoff);
      this.known.set(sessionId, handoff);
      return handoff;
    })();
    this.pending.set(sessionId, { token, promise: operation });
    void operation
      .finally(() => {
        if (this.pending.get(sessionId)?.token === token) this.pending.delete(sessionId);
      })
      .catch(() => undefined);
    return operation;
  }
  release(handoff: LocalBrowserHandoff): void {
    this.held.delete(handoff.sessionId);
    this.remember({ ...handoff, outcome: 'handed-back' });
  }
  clear(): void {
    this.held.clear();
    this.known.clear();
    this.pending.clear();
    this.delayed.clear();
  }
  forget(sessionId: string): void {
    this.pending.delete(sessionId);
    this.delayed.delete(sessionId);
    this.held.delete(sessionId);
    this.known.delete(sessionId);
  }
}
