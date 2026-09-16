/** Test-only gate that holds an already-persisted native agent post before its receipt. */
export type DeliveryReceiptGateState =
  | { state: 'idle' }
  | { state: 'armed'; channelId: string }
  | { state: 'held'; channelId: string; entryId: string };

/** Holds one selected channel's next agent receipt until an explicit test release or request abort. */
export class DeliveryReceiptGate {
  private state: DeliveryReceiptGateState = { state: 'idle' };
  private releaseHeld: (() => void) | undefined;

  /** Arm the next agent post in one channel. */
  arm(channelId: string): DeliveryReceiptGateState {
    if (this.state.state !== 'idle') throw new Error('A delivery receipt gate is already active.');
    this.state = { state: 'armed', channelId };
    return this.observation();
  }

  /** Return a public test-only observation with no post content or credential. */
  observation(): DeliveryReceiptGateState {
    return { ...this.state };
  }

  /** Release the one held receipt. */
  release(): DeliveryReceiptGateState {
    this.releaseHeld?.();
    return this.observation();
  }

  /** Cancel an armed or held gate during test cleanup. */
  reset(): DeliveryReceiptGateState {
    this.releaseHeld?.();
    this.state = { state: 'idle' };
    return this.observation();
  }

  /** Wait after the entry transaction commits, never before it. */
  async holdAfterPersist(input: {
    channelId: string;
    entryId: string;
    signal: AbortSignal;
  }): Promise<void> {
    if (this.state.state !== 'armed' || this.state.channelId !== input.channelId) return;
    this.state = { state: 'held', channelId: input.channelId, entryId: input.entryId };
    await new Promise<void>((resolve) => {
      const finish = () => {
        input.signal.removeEventListener('abort', finish);
        this.releaseHeld = undefined;
        if (this.state.state === 'held' && this.state.entryId === input.entryId)
          this.state = { state: 'idle' };
        resolve();
      };
      this.releaseHeld = finish;
      input.signal.addEventListener('abort', finish, { once: true });
      if (input.signal.aborted) finish();
    });
  }
}
