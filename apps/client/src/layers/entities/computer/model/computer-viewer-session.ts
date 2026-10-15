import type { ComputerTransport } from '@dorkos/shared/transport-computers';
import type {
  ComputerControlLease,
  ComputerFrame,
  ComputerInput,
} from '@dorkos/shared/computer-schemas';

/** Input before the viewer adds its generation-fenced lease. */
export type ViewerInput = ComputerInput extends infer I
  ? I extends ComputerInput
    ? Omit<I, 'leaseId' | 'generation'>
    : never
  : never;

/** One observable framebuffer and one input owner for a computer generation. */
export interface ViewerSnapshot {
  frame: ComputerFrame | null;
  lease: ComputerControlLease | null;
  owner: string | null;
  busy: boolean;
  error: boolean;
  controlError: boolean;
}

/** Shared capture/input lifetime; mounting a second presenter never starts a second loop. */
export class ComputerViewerSession {
  private snapshot: ViewerSnapshot = {
    frame: null,
    lease: null,
    owner: null,
    busy: false,
    error: false,
    controlError: false,
  };
  private listeners = new Map<string, () => void>();
  private timer: ReturnType<typeof setTimeout> | undefined;
  private epoch = 0;
  private acquisition = 0;
  private queue = Promise.resolve();
  private movePending = false;
  private polling = false;
  private retired = false;
  private pendingOwner: string | null = null;
  private frameRequest: Promise<ComputerFrame> | null = null;

  constructor(
    private transport: ComputerTransport,
    readonly generation: number,
    private previous?: ComputerViewerSession
  ) {}

  /** Stable snapshot for useSyncExternalStore. */
  getSnapshot = (): ViewerSnapshot => this.snapshot;

  private update(patch: Partial<ViewerSnapshot>) {
    this.snapshot = { ...this.snapshot, ...patch };
    for (const notify of this.listeners.values()) notify();
  }

  /** Subscribe a presenter; release its control immediately when that presenter disappears. */
  subscribe = (owner: string, notify: () => void): (() => void) => {
    this.listeners.set(owner, notify);
    if (!this.polling && !this.retired) this.start();
    return () => {
      this.listeners.delete(owner);
      void this.releaseFor(owner);
      if (this.listeners.size === 0) {
        this.epoch += 1;
        this.polling = false;
        clearTimeout(this.timer);
        this.update({ frame: null });
      }
    };
  };

  /** Stop the old generation before a replacement can capture or acquire input. */
  retire(): void {
    this.retired = true;
    this.epoch += 1;
    this.polling = false;
    clearTimeout(this.timer);
    void this.release();
    this.update({ frame: null, error: true });
  }

  private start() {
    this.previous?.retire();
    this.previous = undefined;
    this.polling = true;
    const epoch = ++this.epoch;
    const poll = async () => {
      const observed = this.snapshot.lease;
      try {
        const request = this.frameRequest ?? this.transport.getComputerFrame();
        this.frameRequest = request;
        const frame = await request.finally(() => {
          if (this.frameRequest === request) this.frameRequest = null;
        });
        if (epoch !== this.epoch) return;
        if (frame.generation !== this.generation) {
          this.update({ frame: null, error: true });
          void this.release();
        } else {
          if (frame.controlledByYou === false && observed && this.snapshot.lease === observed)
            this.drop();
          this.update({ frame, error: false });
        }
      } catch {
        if (epoch !== this.epoch) return;
        this.update({ frame: null, error: true });
        void this.release();
      }
      if (epoch === this.epoch) this.timer = setTimeout(() => void poll(), 500);
    };
    void poll();
  }

  private drop() {
    this.acquisition += 1;
    this.movePending = false;
    this.pendingOwner = null;
    this.update({ lease: null, owner: null, busy: false, controlError: false });
  }

  /** Revoke local input before awaiting the server, so queued work cannot outlive control. */
  release = async (): Promise<void> => {
    const lease = this.snapshot.lease;
    this.drop();
    const revision = this.acquisition;
    if (!lease) return;
    try {
      await this.transport.releaseComputerControl(lease.leaseId);
    } catch {
      if (revision === this.acquisition) this.update({ error: true, frame: null });
    }
  };

  /** An observing presenter cannot revoke another presenter's pending or acquired takeover. */
  releaseFor = (owner: string): Promise<void> => {
    return this.snapshot.owner === owner || this.pendingOwner === owner
      ? this.release()
      : Promise.resolve();
  };

  /** Only an explicit presenter action acquires control; late replies are returned immediately. */
  acquire = async (owner: string): Promise<void> => {
    if (
      this.retired ||
      !this.listeners.has(owner) ||
      this.snapshot.busy ||
      !this.snapshot.frame ||
      this.snapshot.lease
    )
      return;
    const revision = ++this.acquisition;
    this.pendingOwner = owner;
    this.update({ busy: true, controlError: false });
    try {
      const lease = await this.transport.acquireComputerControl();
      if (
        !this.listeners.has(owner) ||
        revision !== this.acquisition ||
        lease.generation !== this.generation
      ) {
        await this.transport.releaseComputerControl(lease.leaseId);
        return;
      }
      this.update({ lease, owner, controlError: false });
    } catch {
      if (revision === this.acquisition) this.update({ controlError: true });
    } finally {
      if (revision === this.acquisition) {
        this.pendingOwner = null;
        this.update({ busy: false });
      }
    }
  };

  /** Ordered input from the owning presenter only; pointer moves are coalesced. */
  send = (owner: string, event: ViewerInput): Promise<boolean> => {
    const lease = this.snapshot.lease;
    if (!lease || this.snapshot.owner !== owner || !this.listeners.has(owner))
      return Promise.resolve(false);
    const move = event.kind === 'pointer' && event.action === 'move';
    if (move && this.movePending) return Promise.resolve(false);
    if (move) this.movePending = true;
    const pending = this.queue.then(async () => {
      if (
        this.snapshot.lease !== lease ||
        this.snapshot.owner !== owner ||
        !this.listeners.has(owner)
      ) {
        if (move) this.movePending = false;
        return false;
      }
      try {
        await this.transport.sendComputerInput({ ...event, ...lease });
        return true;
      } catch {
        // A late failure belongs to its original lease, never a subsequent takeover.
        if (this.snapshot.lease === lease && this.snapshot.owner === owner) {
          this.update({ error: true, frame: null });
          await this.release();
        }
        return false;
      } finally {
        if (move) this.movePending = false;
      }
    });
    this.queue = pending.then(() => undefined);
    return pending;
  };
}

const sessions = new WeakMap<ComputerTransport, ComputerViewerSession>();

/** Release the current control owner without creating or resurrecting an obsolete generation. */
export function releaseComputerViewerControl(transport: ComputerTransport): Promise<void> {
  return sessions.get(transport)?.release() ?? Promise.resolve();
}

/** The local computer has one current generation, scoped to the authenticated transport. */
export function computerViewerSession(
  transport: ComputerTransport,
  generation: number
): ComputerViewerSession {
  let session = sessions.get(transport);
  if (!session || session.generation !== generation) {
    session = new ComputerViewerSession(transport, generation, session);
    sessions.set(transport, session);
  }
  return session;
}
