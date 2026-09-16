import { ApiError } from './http.js';

/** The test runtime's pause or temporary-refusal mode for an agent post. */
export type DeliveryReceiptPhase = 'before-persist' | 'after-persist' | 'unavailable';

/** Public observations contain no message content or credentials. */
export type DeliveryReceiptGateState =
  | { state: 'idle' }
  | { state: 'armed'; channelId: string; phase: DeliveryReceiptPhase }
  | { state: 'held-before-persist'; channelId: string }
  | { state: 'unavailable'; channelId: string; attempts: number }
  | { state: 'held'; channelId: string; entryId: string };

/** Test-only pauses and temporary refusal for delivery and uncertain receipts. */
export class DeliveryReceiptGate {
  private state: DeliveryReceiptGateState = { state: 'idle' };
  private releaseHeld: (() => void) | undefined;

  /** Arm one channel's next pause, or refuse its agent posts until explicitly released. */
  arm(channelId: string, phase: DeliveryReceiptPhase = 'after-persist'): DeliveryReceiptGateState {
    if (this.state.state !== 'idle') throw new Error('A delivery receipt gate is already active.');
    this.state = { state: 'armed', channelId, phase };
    return this.observation();
  }

  /** Return a public observation without post content or credentials. */
  observation(): DeliveryReceiptGateState {
    return { ...this.state };
  }

  /** Release the held request, or disarm before a matching request arrives. */
  release(): DeliveryReceiptGateState {
    if (this.releaseHeld) this.releaseHeld();
    else if (this.state.state === 'armed' || this.state.state === 'unavailable')
      this.state = { state: 'idle' };
    return this.observation();
  }

  /** Cancel an armed or held gate during test cleanup. */
  reset(): DeliveryReceiptGateState {
    this.releaseHeld?.();
    this.state = { state: 'idle' };
    return this.observation();
  }

  /** Pause before opening any transaction; an aborted request must not persist afterward. */
  async holdBeforePersist(input: { channelId: string; signal: AbortSignal }): Promise<void> {
    if (this.matches(input.channelId, 'unavailable')) {
      this.state = { state: 'unavailable', channelId: input.channelId, attempts: 0 };
    }
    if (this.state.state === 'unavailable' && this.state.channelId === input.channelId) {
      this.state.attempts += 1;
      throw new ApiError(503, 'UNAVAILABLE', 'Community delivery is temporarily unavailable.');
    }
    if (!this.matches(input.channelId, 'before-persist')) return;
    this.state = { state: 'held-before-persist', channelId: input.channelId };
    await this.waitForRelease(input.signal);
    input.signal.throwIfAborted();
  }

  /** Pause after commit to exercise an uncertain HTTP receipt while SSE remains authoritative. */
  async holdAfterPersist(input: {
    channelId: string;
    entryId: string;
    signal: AbortSignal;
  }): Promise<void> {
    if (!this.matches(input.channelId, 'after-persist')) return;
    this.state = { state: 'held', channelId: input.channelId, entryId: input.entryId };
    await this.waitForRelease(input.signal);
  }

  private matches(channelId: string, phase: DeliveryReceiptPhase): boolean {
    return (
      this.state.state === 'armed' &&
      this.state.channelId === channelId &&
      this.state.phase === phase
    );
  }

  private async waitForRelease(signal: AbortSignal): Promise<void> {
    await new Promise<void>((resolve) => {
      const finish = () => {
        signal.removeEventListener('abort', finish);
        this.releaseHeld = undefined;
        this.state = { state: 'idle' };
        resolve();
      };
      this.releaseHeld = finish;
      signal.addEventListener('abort', finish, { once: true });
      if (signal.aborted) finish();
    });
  }
}
