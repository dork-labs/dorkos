/** One Codex controller's live tool facts and its existing stream delivery edge. */
import type { StreamEvent } from '@dorkos/shared/types';
import type { CapabilityHoldSession } from '../../../core/capabilities/capability-approval-hold.js';
import type { RuntimeToolTurnFacts } from '../../../core/connections-lease/index.js';

/** Batch delivery into the transport's existing single-consumer event queue. */
export type CodexToolEventDelivery = (events: StreamEvent[]) => void;

/** Transient adapter facts, owned by one controller rather than the session registry. */
export class CodexToolTurnContext {
  private delivery: CodexToolEventDelivery | undefined;
  private closed = false;
  private readonly toolLifetime = new AbortController();
  private readonly signal: AbortSignal;
  private readonly session: CapabilityHoldSession = {
    eventQueue: [],
    eventQueueNotify: () => {
      const events = this.session.eventQueue.splice(0);
      if (!this.closed && this.isCurrent() && !this.signal.aborted) this.delivery?.(events);
    },
  };

  /** Bind facts to this exact prepared turn and its cancellation lifetime. */
  constructor(
    private readonly isCurrent: () => boolean,
    private readonly modes: () => Pick<RuntimeToolTurnFacts, 'effectiveMode' | 'chosenMode'>,
    signal: AbortSignal
  ) {
    this.signal = AbortSignal.any([signal, this.toolLifetime.signal]);
  }

  /** Attach/detach the existing transport queue, never an additional drain consumer. */
  setDelivery(delivery: CodexToolEventDelivery | undefined): void {
    this.delivery = this.closed || this.signal.aborted ? undefined : delivery;
    if (!this.delivery) {
      this.toolLifetime.abort();
      this.session.eventQueue.splice(0);
    }
  }

  /** Read applied facts; a prepared or retired turn without a live sink cannot hold a card. */
  read(): RuntimeToolTurnFacts | undefined {
    if (this.closed || !this.delivery || !this.isCurrent() || this.signal.aborted) return undefined;
    return {
      ...this.modes(),
      // Codex has no person-only Never ask selector. Its native inability to ask is distinct.
      neverAsks: false,
      session: this.session,
      signal: this.signal,
    };
  }

  /** Retire facts and discard buffered cards before any asynchronous teardown. */
  close(): void {
    this.closed = true;
    this.setDelivery(undefined);
  }
}
