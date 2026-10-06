import type { CDPSession, Page } from 'playwright-core';
import type { BrowserBinding } from '../contracts.js';
import type { BrowserRecord, TabRecord } from '../lifecycle/records.js';
import { ownOperation } from '../lifecycle/ownership.js';
import { BrowserLifecycleError } from '../lifecycle/errors.js';
import { sameBinding } from '../input/binding.js';

type Original = Readonly<{ session: CDPSession; current(): boolean }>;
const sessions = new WeakMap<Page, Original>();

/** Called only by the actual Page input transport after retaining its original CDPSession. */
export function registerOriginalPageSession(
  page: Page,
  session: CDPSession,
  current: () => boolean
): void {
  if (sessions.has(page)) throw new Error('ORIGINAL_PAGE_SESSION_REBOUND');
  sessions.set(page, Object.freeze({ session, current }));
}

/** Same-document provenance is native, never inferred from a same-origin URL/Frame event. */
export class OriginalSameDocumentObserver {
  private closed = false;
  private started = false;
  private readonly proofs: Array<Readonly<{ url: string; binding: BrowserBinding }>> = [];
  private readonly waiters = new Map<
    object,
    Readonly<{
      url: string;
      binding: BrowserBinding;
      resolve(): void;
      reject(reason: unknown): void;
    }>
  >();
  private firstFailure?: Readonly<{ reason: unknown }>;
  private off?: () => void;
  private readiness?: Promise<void>;
  private closing?: Promise<void>;
  constructor(
    private readonly record: BrowserRecord,
    private readonly tab: TabRecord,
    private readonly current: () => boolean
  ) {}

  /** Original existing input session owns detach. This observer sends only native metadata commands. */
  start(): Promise<void> {
    if (this.readiness) return this.readiness;
    if (this.closed || this.started) throw new BrowserLifecycleError('STALE_BINDING');
    this.started = true;
    let resolveReady!: () => void, rejectReady!: (reason: unknown) => void;
    // This exact original bank exists before any Page/session getter or native method can
    // reenter close. A closed observer cannot report settled while metadata remains held.
    this.readiness = new Promise<void>((resolve, reject) => {
      resolveReady = resolve;
      rejectReady = reject;
    });
    void this.readiness.catch((reason) => {
      this.firstFailure ??= Object.freeze({ reason });
    });
    const originalReadiness = ownOperation(this.record, async () => {
      if (this.closed) throw new BrowserLifecycleError('BROWSER_STOPPED');
      const page = this.tab.page,
        original = sessions.get(page),
        frame = page.mainFrame();
      if (!original) throw new BrowserLifecycleError('STALE_BINDING');
      const session = original.session,
        send = session.send.bind(session),
        on = session.on.bind(session),
        off = session.off.bind(session);
      // Native events can arrive before the initial tree read establishes the exact root.
      let rootId: string | undefined = undefined;
      const alive = () => {
        const admitted = this.current() && original.current();
        return (
          admitted &&
          !this.closed &&
          this.record.tabs.get(this.tab.binding.tabId) === this.tab &&
          this.tab.page === page &&
          !this.tab.stopped &&
          !this.record.lifetime.uncertain &&
          !this.record.lifetime.gate.stopped &&
          page.mainFrame() === frame
        );
      };
      const observe = (event: { frameId: string; url: string }) => {
        if (this.closed) return;
        try {
          if (!alive()) throw new BrowserLifecycleError('STALE_BINDING');
          if (event.frameId !== rootId) return;
          const url = event.url;
          if (typeof url !== 'string' || url.length > 2048)
            throw new BrowserLifecycleError('STALE_BINDING');
          const binding = Object.freeze({ ...this.tab.binding });
          const waiting = [...this.waiters].find(
            ([, waiter]) => waiter.url === url && sameBinding(waiter.binding, binding)
          );
          if (waiting) {
            this.waiters.delete(waiting[0]);
            waiting[1].resolve();
          } else {
            if (this.proofs.length >= 16) throw new BrowserLifecycleError('STALE_BINDING');
            this.proofs.push(Object.freeze({ url, binding }));
          }
        } catch (reason) {
          this.firstFailure ??= Object.freeze({ reason });
          for (const waiter of this.waiters.values()) waiter.reject(this.firstFailure.reason);
          this.waiters.clear();
          this.record.lifetime.uncertain = true;
          this.record.lifetime.requestRetirement('engineFault');
        }
      };
      // Retain the original remover before registration can throw/reenter.
      this.off = () => off('Page.navigatedWithinDocument', observe);
      if (!alive()) throw new BrowserLifecycleError('STALE_BINDING');
      on('Page.navigatedWithinDocument', observe);
      if (!alive()) throw new BrowserLifecycleError('STALE_BINDING');
      await ownOperation(this.record, () => send('Page.enable'));
      if (!alive()) throw new BrowserLifecycleError('STALE_BINDING');
      const tree = await ownOperation(this.record, () => send('Page.getFrameTree'));
      if (!alive()) throw new BrowserLifecycleError('STALE_BINDING');
      rootId = tree.frameTree.frame.id;
      if (!rootId) throw new BrowserLifecycleError('STALE_BINDING');
    });
    void originalReadiness.then(resolveReady, (reason) => {
      this.firstFailure ??= Object.freeze({ reason });
      rejectReady(reason);
    });
    return this.readiness;
  }

  /** Consume one genuine root event exactly once, in either SDK/native event ordering. */
  match(url: string, binding: BrowserBinding): Promise<void> {
    if (this.firstFailure) return Promise.reject(this.firstFailure.reason);
    if (this.closed) return Promise.reject(new BrowserLifecycleError('STALE_BINDING'));
    const index = this.proofs.findIndex(
      (proof) => proof.url === url && sameBinding(proof.binding, binding)
    );
    if (index >= 0) {
      this.proofs.splice(index, 1);
      return Promise.resolve();
    }
    if (this.waiters.size >= 16) return Promise.reject(new BrowserLifecycleError('STALE_BINDING'));
    const key = Object.freeze({});
    return new Promise<void>((resolve, reject) => {
      this.waiters.set(
        key,
        Object.freeze({ url, binding: Object.freeze({ ...binding }), resolve, reject })
      );
    });
  }

  /** Fence synchronously, remove the exact original listener, and join original native metadata reads. */
  close(): Promise<void> {
    if (this.closing) return this.closing;
    this.closed = true;
    this.proofs.length = 0;
    for (const waiter of this.waiters.values())
      waiter.reject(new BrowserLifecycleError('BROWSER_STOPPED'));
    this.waiters.clear();
    let resolve!: () => void, reject!: (reason: unknown) => void;
    this.closing = new Promise((yes, no) => {
      resolve = yes;
      reject = no;
    });
    void Promise.allSettled(this.readiness ? [this.readiness] : []).then(() => {
      // Registration may reenter close before installing the listener. Remove only after
      // the original readiness producer has returned, preserving its first exact failure.
      try {
        this.off?.();
      } catch (reason) {
        this.firstFailure ??= Object.freeze({ reason });
      }
      if (this.firstFailure) reject(this.firstFailure.reason);
      else resolve();
    });
    void this.closing.catch(() => undefined);
    return this.closing;
  }
}
