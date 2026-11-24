import type { StreamEvent } from '@dorkos/shared/types';
import type { RuntimeToolTurnFacts } from '../../../connectors/runtime-principal-port.js';
import type { RuntimeEventQueue } from '../../shared/session/event-queue.js';

/** One active turn's host-card delivery and independent logical tool lifetime. */
export class DoeToolTurnContext {
  private readonly lifetime = new AbortController();
  private readonly signal: AbortSignal;
  private readonly session: RuntimeToolTurnFacts['session'] = {
    eventQueue: [],
    eventQueueNotify: () => {
      const events = this.session.eventQueue.splice(0);
      if (!this.isCurrent() || this.signal.aborted) return;
      for (const event of events) this.queue.push(event);
    },
  };

  /** Bind exact ownership, the actual prepared policy and turn cancellation. */
  constructor(
    private readonly queue: RuntimeEventQueue<StreamEvent>,
    runtimeSignal: AbortSignal,
    private readonly isCurrent: () => boolean,
    private readonly policy: Pick<RuntimeToolTurnFacts, 'effectiveMode' | 'chosenMode'>
  ) {
    this.signal = AbortSignal.any([runtimeSignal, this.lifetime.signal]);
  }

  /** Read the applied turn, never settings queued for a later turn. */
  read(): RuntimeToolTurnFacts | undefined {
    if (!this.isCurrent() || this.signal.aborted) return undefined;
    return {
      ...this.policy,
      // Doe declares no separate person-only Never ask selector; Full is distinct.
      neverAsks: false,
      session: this.session,
      signal: this.signal,
    };
  }

  /** Retire holds before host cleanup can wait, without cancelling the native turn. */
  close(): void {
    this.lifetime.abort();
    this.session.eventQueue.length = 0;
  }
}
