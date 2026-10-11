/**
 * The parts of {@link ./fake-community-adapter.js | FakeCommunityAdapter} that are not the
 * adapter itself: its default capability profile and the push-driven stream it hands out.
 *
 * @module test-utils/fake-community-support
 */
import type { CommunityCapabilities } from '@dorkos/shared/community-adapter';

/** The established capability profile; new file and agent-acting paths opt in explicitly. */
export const DEFAULT_CAPABILITIES: Omit<CommunityCapabilities, 'type'> = {
  roomList: 'push',
  roomAddressing: 'slug',
  canPost: true,
  roomAdmin: true,
  agentActing: false,
  attachments: false,
  conduct: false,
  reports: false,
  roles: {
    supported: true,
    default: 'member',
    values: [
      { id: 'owner', label: 'Owner', administers: true, isOwner: true },
      { id: 'admin', label: 'Admin', administers: true },
      { id: 'member', label: 'Member', administers: false },
      { id: 'bot', label: 'Bot', administers: false },
    ],
  },
  admission: 'open',
  invite: 'room',
  agentAdmission: 'owner-vouched',
  readCursor: 'server',
  responseMode: true,
  threadDepth: 1,
  signals: 'both',
  credential: 'machine-managed',
  features: {},
};

/**
 * A push-driven async iterable. Events queue until a consumer pulls them, so a
 * snapshot pushed before the caller starts iterating is never lost.
 */
export class Pushable<T> implements AsyncIterable<T> {
  private readonly _queue: T[] = [];
  private readonly _waiters: ((result: IteratorResult<T>) => void)[] = [];
  private _ended = false;

  /**
   * Build a stream that unregisters itself when the consumer walks away.
   *
   * @param onClose - Called once when the consumer stops iterating, so the
   *   producer can unregister this stream.
   */
  constructor(private readonly onClose: () => void) {}

  /**
   * Queue one event, delivering it immediately if a consumer is parked.
   *
   * @param value - The event to deliver.
   */
  push(value: T): void {
    if (this._ended) return;
    const waiter = this._waiters.shift();
    if (waiter) waiter({ value, done: false });
    else this._queue.push(value);
  }

  /** Terminate the stream after everything already queued has been read. */
  end(): void {
    if (this._ended) return;
    this._ended = true;
    let waiter = this._waiters.shift();
    while (waiter) {
      waiter({ value: undefined as never, done: true });
      waiter = this._waiters.shift();
    }
  }

  [Symbol.asyncIterator](): AsyncIterator<T> {
    return {
      next: (): Promise<IteratorResult<T>> => {
        const queued = this._queue.shift();
        if (queued !== undefined) return Promise.resolve({ value: queued, done: false });
        if (this._ended) return Promise.resolve({ value: undefined as never, done: true });
        return new Promise<IteratorResult<T>>((resolve) => this._waiters.push(resolve));
      },
      return: (): Promise<IteratorResult<T>> => {
        this.end();
        this.onClose();
        return Promise.resolve({ value: undefined as never, done: true });
      },
    };
  }
}
