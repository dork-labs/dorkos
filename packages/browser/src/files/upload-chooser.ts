import type { CDPSession } from 'playwright-core';
import { parseBrowserBinding, type BrowserBinding } from '../contracts.js';
import { sameBinding } from '../input/binding.js';

/** Only a private consumed staging lease supplies this exclusive file; public commands contain no path. */
export interface OwnedUploadPayload {
  readonly path: string;
  readonly byteLength: number;
}
/** Original authenticated staging owner with separate fresh access/upload permission checks. */
export interface OwnedUploadLease {
  readonly artifactId: string;
  readonly binding: unknown;
  consume(signal: AbortSignal): Promise<OwnedUploadPayload>;
  enter(effect: () => Promise<void>): Promise<void>;
  close(): Promise<void>;
}
/** Existing original Page input session owns native interception ACK and the chooser event for one Work. */
export class OwnedUploadChooser {
  private readonly send: CDPSession['send'];
  private readonly on: CDPSession['on'];
  private readonly off: CDPSession['off'];
  private readonly consume: OwnedUploadLease['consume'];
  private readonly closeLease: OwnedUploadLease['close'];
  private readonly enterLease: OwnedUploadLease['enter'];
  private readonly binding: BrowserBinding;
  private readonly chosen: Promise<
    Readonly<{ frameId: string; backendNodeId: number; mode: string }>
  >;
  private resolveChosen!: (
    value: Readonly<{ frameId: string; backendNodeId: number; mode: string }>
  ) => void;
  private rejectChosen!: (value: unknown) => void;
  private readonly operations = new Set<Promise<unknown>>();
  private arming?: Promise<void>;
  private completion?: Promise<void>;
  private frameId?: string;
  private listening = false;
  private closed = false;
  private selected = false;
  private armed = false;
  private closing?: Promise<void>;
  private first?: Readonly<{ value: unknown }>;
  private readonly observe = (event: {
    frameId?: unknown;
    backendNodeId?: unknown;
    mode?: unknown;
  }) => {
    if (this.closed || this.selected) return;
    try {
      this.check();
      if (!this.armed) throw new Error('UPLOAD_EARLY_CHOOSER_REFUSED');
      const frameId = event.frameId,
        backendNodeId = event.backendNodeId,
        mode = event.mode;
      this.check();
      if (
        frameId !== this.frameId ||
        !Number.isSafeInteger(backendNodeId) ||
        (backendNodeId as number) <= 0 ||
        mode !== 'selectSingle'
      )
        throw new Error('UPLOAD_CHOOSER_REFUSED');
      this.selected = true;
      this.resolveChosen(
        Object.freeze({
          frameId: frameId as string,
          backendNodeId: backendNodeId as number,
          mode,
        })
      );
    } catch (value) {
      this.failure(value);
      this.rejectChosen(value);
    }
  };
  constructor(
    session: CDPSession,
    lease: OwnedUploadLease,
    private readonly current: () => boolean
  ) {
    this.chosen = new Promise((resolve, reject) => {
      this.resolveChosen = resolve;
      this.rejectChosen = reject;
    });
    void this.chosen.catch(() => undefined);
    this.binding = Object.freeze(parseBrowserBinding(lease.binding));
    this.consume = lease.consume.bind(lease);
    this.closeLease = lease.close.bind(lease);
    this.enterLease = lease.enter.bind(lease);
    this.send = session.send.bind(session);
    this.on = session.on.bind(session);
    this.off = session.off.bind(session);
  }
  private check(signal?: AbortSignal): void {
    signal?.throwIfAborted();
    if (this.first) throw this.first.value;
    if (this.closed || !this.current() || this.closed) throw new Error('UPLOAD_AUTHORITY_REFUSED');
  }
  private failure(value: unknown): void {
    this.first ??= Object.freeze({ value });
  }
  private retain<T>(original: Promise<T>): Promise<T> {
    this.operations.add(original);
    void original.then(
      () => this.operations.delete(original),
      (value) => {
        this.failure(value);
        this.operations.delete(original);
      }
    );
    return original;
  }
  /** Await the actual native interception ACK before the queue may enter its first canonical click step. */
  begin(signal: AbortSignal): Promise<void> {
    if (this.arming) return this.arming;
    const original = Promise.resolve().then(async () => {
      this.check(signal);
      const tree = await this.send('Page.getFrameTree');
      this.check(signal);
      const root = tree.frameTree.frame;
      if (typeof root.id !== 'string' || !root.id || root.parentId)
        throw new Error('UPLOAD_FRAME_REFUSED');
      this.frameId = root.id;
      this.listening = true;
      this.on('Page.fileChooserOpened', this.observe);
      this.check(signal);
      await this.send('Page.setInterceptFileChooserDialog', { enabled: true });
      this.check(signal);
      this.armed = true;
    });
    this.arming = this.retain(original);
    return original;
  }
  /** Consume once, correlate the exact main-frame node, and join the original fixed native file command. */
  complete(binding: BrowserBinding, signal: AbortSignal): Promise<void> {
    if (this.completion) throw new Error('UPLOAD_REPLAY_REFUSED');
    const original = Promise.resolve().then(async () => {
      this.check(signal);
      if (!this.arming || !sameBinding(binding, this.binding))
        throw new Error('UPLOAD_BINDING_REFUSED');
      await this.arming;
      this.check(signal);
      const chosen = await this.chosen;
      this.check(signal);
      const payload = await this.consume(signal);
      this.check(signal);
      if (
        !payload.path ||
        !Number.isSafeInteger(payload.byteLength) ||
        payload.byteLength < 1 ||
        payload.byteLength > 2 * 1024 * 1024
      )
        throw new Error('UPLOAD_BYTES_REFUSED');
      // Fixed internal native method; path comes only from the exact once-consumed private staging lease.
      await this.enterLease(async () => {
        this.check(signal);
        await this.send('DOM.setFileInputFiles', {
          files: [payload.path],
          backendNodeId: chosen.backendNodeId,
        });
      });
      this.check(signal);
    });
    this.completion = this.retain(original);
    return original;
  }
  /** Report retained original upload work only; this never authorizes an input effect. */
  custody(): Readonly<{ pending: number; failed: boolean }> {
    return Object.freeze({
      pending: this.operations.size,
      failed: this.first !== undefined,
    });
  }
  /** Fence admission immediately and join every entered native operation before disabling interception/file cleanup. */
  close(): Promise<void> {
    if (this.closing) return this.closing;
    this.closed = true;
    this.rejectChosen(new Error('UPLOAD_CLOSED'));
    let resolve!: () => void, reject!: (value: unknown) => void;
    this.closing = new Promise<void>((yes, no) => {
      resolve = yes;
      reject = no;
    });
    if (this.listening) {
      try {
        this.off('Page.fileChooserOpened', this.observe);
      } catch (value) {
        this.failure(value);
      }
    }
    void Promise.resolve().then(async () => {
      await Promise.allSettled([...this.operations]);
      if (this.listening) {
        try {
          await this.send('Page.setInterceptFileChooserDialog', {
            enabled: false,
          });
        } catch (value) {
          this.failure(value);
        }
      }
      try {
        await this.closeLease();
      } catch (value) {
        this.failure(value);
      }
      if (this.first) reject(this.first.value);
      else resolve();
    });
    void this.closing.catch(() => undefined);
    return this.closing;
  }
}
