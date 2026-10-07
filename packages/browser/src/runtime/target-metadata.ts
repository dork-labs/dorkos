import type { Page, CDPSession } from 'playwright-core';

/** Private original-session custody; a caller's target string never creates authority. */
export class TargetMetadataOwner {
  private closed = false;
  private first: { reason: unknown } | undefined;
  private closing: Promise<void> | undefined;
  private readonly pending = new Set<Promise<unknown>>();
  private readonly local = new WeakSet<object>();

  /** Refuse all future producers after an original metadata or cleanup fault. */
  assertCurrent(): void {
    if (this.first) throw this.first.reason;
    if (this.closed) throw this.refusal();
  }

  /** Observe an original metadata receiver without allowing its fault to disappear in RPC handling. */
  observe<T>(original: () => T): T {
    try {
      this.assertCurrent();
      const value = original();
      this.assertCurrent();
      return value;
    } catch (reason) {
      this.record(reason);
      throw reason;
    }
  }

  /** Bound actual native Page inventory before entering any per-page session producer. */
  pages(original: () => Page[]): readonly Page[] {
    return this.observe(() => {
      const pages = original();
      if (pages.length > 64) throw new Error('SUPERVISOR_TAB_LIMIT');
      return pages;
    });
  }

  private refusal(): Error {
    const error = new Error('SUPERVISOR_TARGET_REFUSED');
    this.local.add(error);
    return error;
  }

  private record(reason: unknown): void {
    if (typeof reason !== 'object' || reason === null || !this.local.has(reason))
      this.first ??= { reason };
  }

  /** Preregister completion before entering any original Page/context/session receiver. */
  read(page: Page, current: () => boolean): Promise<Readonly<{ targetId: string; url: string }>> {
    let resolve!: (value: Readonly<{ targetId: string; url: string }>) => void;
    let reject!: (reason: unknown) => void;
    const original = new Promise<Readonly<{ targetId: string; url: string }>>((yes, no) => {
      resolve = yes;
      reject = no;
    });
    this.pending.add(original);
    void original.then(
      () => this.pending.delete(original),
      () => this.pending.delete(original)
    );
    const guard = () => {
      this.assertCurrent();
      const admitted = current();
      this.assertCurrent();
      const closed = page.isClosed();
      this.assertCurrent();
      if (!admitted || closed) throw this.refusal();
    };
    void (async () => {
      let session: CDPSession | undefined;
      let first: { reason: unknown } | undefined;
      let value: Readonly<{ targetId: string; url: string }> | undefined;
      try {
        guard();
        const context = page.context();
        guard();
        const acquire = context.newCDPSession.bind(context);
        guard();
        session = await acquire(page);
        // A late acquired session remains ours to detach, but cannot enter an unstarted send.
        guard();
        const send = session.send.bind(session);
        guard();
        const info = await send('Target.getTargetInfo');
        guard();
        const targetId = info.targetInfo.targetId,
          url = page.url();
        guard();
        if (
          info.targetInfo.type !== 'page' ||
          typeof targetId !== 'string' ||
          !targetId ||
          targetId.length > 128 ||
          typeof url !== 'string'
        )
          throw new Error('SUPERVISOR_METADATA_INVALID');
        value = Object.freeze({ targetId, url: url.slice(0, 4096) });
      } catch (reason) {
        this.record(reason);
        first = { reason };
      }
      if (session) {
        try {
          await session.detach();
        } catch (reason) {
          this.record(reason);
          first ??= { reason };
        }
      }
      if (first) throw first.reason;
      guard();
      return value!;
    })().then(resolve, (reason) => {
      this.record(reason);
      reject(reason);
    });
    return original;
  }

  /** Fence synchronously, then join every entered acquisition/send/detach original. */
  close(): Promise<void> {
    this.closed = true;
    if (!this.closing) {
      const originals = [...this.pending];
      this.closing = Promise.allSettled(originals).then(() => {
        if (this.first) throw this.first.reason;
      });
    }
    return this.closing;
  }
}
