import {
  InspectionFailure,
  LIMITS,
  requireIdentity,
  trustedPath,
  type Identity,
} from './records.js';

export type Root = 'cache' | 'library';
export interface Lease {
  readonly sequence: number;
  readonly root: Root;
  readonly path: string;
  readonly deadline: number;
  readonly canonicalRoot: string;
}
export interface Handle {
  readonly token: object;
  readonly kind: 'file' | 'directory';
}
export type Named =
  | { readonly state: 'present'; readonly identity: Identity }
  | { readonly state: 'absent' }
  | { readonly state: 'unknown' };
type Reply<T> = Readonly<{ lease: Lease; value: T }>;
type HeldReply<T> = Reply<T> & Readonly<{ handle: Handle }>;
/** Accepted private mock capability; real implementations need a separate capability review. */
export interface InspectionPort {
  readonly capabilities: Readonly<{
    boundedIntake: true;
    noFollow: true;
    heldIdentity: true;
    exactClose: true;
    oneEntryPrefetch: true;
  }>;
  observeNamed(lease: Lease): Promise<Reply<Named>>;
  openRegular(lease: Lease, identity: Identity): Promise<Reply<Handle>>;
  openDirectory(lease: Lease, identity: Identity): Promise<Reply<Handle>>;
  observeHeld(lease: Lease, handle: Handle): Promise<HeldReply<Identity>>;
  readInto(
    lease: Lease,
    handle: Handle,
    buffer: Uint8Array,
    offset: number,
    length: number
  ): Promise<HeldReply<number>>;
  nextEntry(
    lease: Lease,
    handle: Handle
  ): Promise<HeldReply<{ name: string; type: 'file' | 'directory' | 'other' } | null>>;
  close(lease: Lease, handle: Handle): Promise<HeldReply<'closed' | 'unknown'>>;
}
/** One registered owner, one operation, one handle. A timeout retains the unsettled charge. */
export class InspectionOwner {
  private sequence = 0;
  private pending: Lease | null = null;
  private held: { handle: Handle; root: Root; path: string } | null = null;
  private closeStarted = false;
  private retired = false;
  private unknownHandle = false;
  private readonly seenHandles = new WeakSet<object>();
  private last = -Infinity;
  private end = 0;
  private timer?: ReturnType<typeof setTimeout>;
  private reject!: () => void;
  private interruption?: Promise<never>;
  private remove?: () => void;
  readonly buffer = new Uint8Array(LIMITS.buffer);
  retained = LIMITS.buffer;
  constructor(
    readonly port: InspectionPort,
    private readonly now: () => number,
    readonly signal: AbortSignal,
    private readonly roots: Readonly<Record<Root, string>>
  ) {}
  begin(): void {
    if (this.retired || this.pending || this.held || this.unknownHandle || this.signal.aborted)
      throw new InspectionFailure('unverified');
    const capabilities = this.port.capabilities;
    if (
      !capabilities ||
      Object.keys(capabilities).length !== 5 ||
      !['boundedIntake', 'noFollow', 'heldIdentity', 'exactClose', 'oneEntryPrefetch'].every(
        (k) => capabilities[k as keyof typeof capabilities] === true
      )
    )
      throw new InspectionFailure('unverified');
    this.end = this.time() + LIMITS.deadlineMs;
    if (!Number.isFinite(this.end) || this.end <= this.last) {
      this.retire();
      throw new InspectionFailure('unverified');
    }
    this.interruption = new Promise<never>((_, reject) => {
      this.reject = () => {
        this.retire();
        reject(new InspectionFailure('unverified'));
      };
    });
    void this.interruption.catch(() => {});
    const abort = () => this.reject();
    this.signal.addEventListener('abort', abort, { once: true });
    this.remove = () => this.signal.removeEventListener('abort', abort);
    this.timer = setTimeout(() => this.reject(), LIMITS.deadlineMs);
    if (this.signal.aborted) this.reject();
  }
  finish(): void {
    clearTimeout(this.timer);
    this.remove?.();
  }
  private time(): number {
    let n: number;
    try {
      n = this.now();
    } catch {
      this.retire();
      throw new InspectionFailure('unverified');
    }
    if (!Number.isFinite(n) || n < this.last) {
      this.retire();
      throw new InspectionFailure('unverified');
    }
    this.last = n;
    return n;
  }
  check(): void {
    const now = this.time();
    if (this.retired || this.signal.aborted || now >= this.end) {
      this.retire();
      throw new InspectionFailure('unverified');
    }
  }
  retire(): void {
    this.retired = true;
    this.cleanup();
  }
  custody(): Readonly<{
    operation: boolean;
    handle: boolean;
    retired: boolean;
    retainedBytes: number;
  }> {
    return Object.freeze({
      operation: this.pending !== null,
      handle: this.held !== null || this.unknownHandle,
      retired: this.retired,
      retainedBytes: this.retained,
    });
  }
  allocate(size: number): Uint8Array {
    this.check();
    if (this.retained + size > LIMITS.retained) throw new InspectionFailure('unverified');
    this.retained += size;
    return new Uint8Array(size);
  }
  release(bytes: Uint8Array): void {
    this.retained -= bytes.buffer.byteLength;
  }
  private async operation<T>(
    root: Root,
    path: string,
    capture: (lease: Lease) => () => Promise<Reply<T>>,
    handle?: Handle,
    opening = false,
    closing = false
  ): Promise<T> {
    if (!closing) this.check();
    if (!trustedPath.safeParse(path ? this.roots[root] + '/' + path : this.roots[root]).success)
      throw new InspectionFailure('unverified');
    if (this.pending || (!closing && opening && this.held))
      throw new InspectionFailure('unverified');
    if (this.sequence === Number.MAX_SAFE_INTEGER) throw new InspectionFailure('unverified');
    const lease = Object.freeze({
      sequence: ++this.sequence,
      root,
      path,
      deadline: this.end,
      canonicalRoot: this.roots[root],
    });
    this.pending = lease;
    let raw: Promise<Reply<T>>;
    try {
      // Property getters are external callbacks too; capture under custody, then revalidate.
      const invoke = capture(lease);
      if (!closing) this.check();
      if (
        this.pending !== lease ||
        (handle && this.held?.handle !== handle) ||
        (opening && this.held)
      )
        throw new InspectionFailure('unverified');
      raw = Promise.resolve(invoke());
    } catch {
      raw = Promise.reject(new InspectionFailure('unverified'));
    }
    const settlement = raw.then(
      (reply) => {
        if (this.pending !== lease) throw new InspectionFailure('unverified');
        this.pending = null;
        // Settlement does not identify the returned handle: reply accessors can still throw.
        if (opening) this.unknownHandle = true;
        if (
          !reply ||
          reply.lease !== lease ||
          (handle && (reply as HeldReply<T>).handle !== handle)
        ) {
          if (opening) this.unknownHandle = true;
          throw new InspectionFailure('unverified');
        }
        const value = reply.value;
        if (opening) {
          const h = value as Handle;
          const token = h?.token;
          const kind = h?.kind;
          if (!h || typeof token !== 'object' || !token || !['file', 'directory'].includes(kind)) {
            this.unknownHandle = true;
            throw new InspectionFailure('unverified');
          }
          if (this.seenHandles.has(h) || this.seenHandles.has(token)) {
            this.unknownHandle = true;
            throw new InspectionFailure('unverified');
          }
          this.seenHandles.add(h);
          this.seenHandles.add(token);
          this.held = { handle: h, root, path };
          this.unknownHandle = false;
          this.closeStarted = false;
        }
        if (closing && value === 'closed') this.held = null;
        if (this.retired) this.cleanup();
        return value;
      },
      () => {
        if (this.pending === lease) this.pending = null;
        if (opening) this.unknownHandle = true;
        this.retire();
        throw new InspectionFailure('unverified');
      }
    );
    void settlement.catch(() => {
      this.retire();
    });
    if (closing) return settlement;
    const value = await Promise.race([settlement, this.interruption!]);
    this.check();
    return value;
  }
  observe(root: Root, path: string): Promise<Named> {
    return this.operation(root, path, (l) => {
      const port = this.port;
      const method = port.observeNamed;
      return () => Reflect.apply(method, port, [l]);
    });
  }
  async open(root: Root, path: string, identity: Identity): Promise<void> {
    const h = await this.operation(
      root,
      path,
      (l) => {
        const port = this.port;
        const method = identity.type === 'file' ? port.openRegular : port.openDirectory;
        return () => Reflect.apply(method, port, [l, identity]);
      },
      undefined,
      true
    );
    if (h.kind !== identity.type) {
      this.retire();
      throw new InspectionFailure('unverified');
    }
  }
  async observeHeld(): Promise<Identity> {
    const h = this.exact();
    return requireIdentity(
      await this.operation(
        h.root,
        h.path,
        (l) => {
          const port = this.port;
          const method = port.observeHeld;
          return () => Reflect.apply(method, port, [l, h.handle]);
        },
        h.handle
      )
    );
  }
  async read(offset: number, length: number): Promise<number> {
    const h = this.exact();
    const n = await this.operation(
      h.root,
      h.path,
      (l) => {
        const port = this.port;
        const method = port.readInto;
        return () => Reflect.apply(method, port, [l, h.handle, this.buffer, offset, length]);
      },
      h.handle
    );
    if (!Number.isSafeInteger(n) || n < 0 || n > length) throw new InspectionFailure('unverified');
    return n;
  }
  next(): Promise<{ name: string; type: 'file' | 'directory' | 'other' } | null> {
    const h = this.exact();
    return this.operation(
      h.root,
      h.path,
      (l) => {
        const port = this.port;
        const method = port.nextEntry;
        return () => Reflect.apply(method, port, [l, h.handle]);
      },
      h.handle
    );
  }
  async close(): Promise<void> {
    const h = this.exact();
    if (this.closeStarted) throw new InspectionFailure('unverified');
    this.closeStarted = true;
    const settled = this.operation(
      h.root,
      h.path,
      (l) => {
        const port = this.port;
        const method = port.close;
        return () => Reflect.apply(method, port, [l, h.handle]);
      },
      h.handle,
      false,
      true
    );
    const value = await Promise.race([settled, this.interruption!]);
    if (value !== 'closed') throw new InspectionFailure('unverified');
    this.check();
  }
  private exact() {
    if (!this.held) throw new InspectionFailure('unverified');
    return this.held;
  }
  private cleanup(): void {
    if (this.pending || !this.held || this.closeStarted) return;
    const h = this.held;
    this.closeStarted = true;
    void this.operation(
      h.root,
      h.path,
      (l) => {
        const port = this.port;
        const method = port.close;
        return () => Reflect.apply(method, port, [l, h.handle]);
      },
      h.handle,
      false,
      true
    ).catch(() => {});
  }
}
