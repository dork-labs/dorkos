import type { Browser, CDPSession } from 'playwright-core';
import { BrowserLifecycleError } from '../lifecycle/errors.js';

/** Fixed deny override retained until the original browser shutdown, never a granted file API. */
export class DefaultDownloadOwner {
  readonly ready: Promise<void>;
  private session?: CDPSession;
  private detach?: CDPSession['detach'];
  private remove?: () => void;
  private closing = false;
  private sessionClosed = false;
  private joined?: Promise<void>;
  private failure?: Readonly<{ value: unknown }>;
  constructor(
    private readonly browser: Browser,
    private readonly current: () => boolean,
    private readonly lost: () => void
  ) {
    // Preregister the whole operation before any original getter/receiver can reenter close.
    this.ready = Promise.resolve().then(() => this.acquire());
    void this.ready.catch((value: unknown) => {
      this.failure ??= Object.freeze({ value });
    });
  }
  private admitted(): void {
    if (this.closing || !this.current()) throw new BrowserLifecycleError('ENGINE_STOPPED');
  }
  private async acquire(): Promise<void> {
    this.admitted();
    const contexts = this.browser.contexts;
    const create = this.browser.newBrowserCDPSession;
    this.admitted();
    const original = Reflect.apply(contexts, this.browser, []) as ReturnType<Browser['contexts']>;
    this.admitted();
    if (original.length !== 1) throw new BrowserLifecycleError('PAGE_UNAVAILABLE');
    const sameContext = () => {
      this.admitted();
      const now = Reflect.apply(contexts, this.browser, []) as ReturnType<Browser['contexts']>;
      if (now.length !== 1 || now[0] !== original[0])
        throw new BrowserLifecycleError('PAGE_UNAVAILABLE');
      this.admitted(); // Original list reads can synchronously revoke admission.
    };
    sameContext();
    const session = (await Reflect.apply(create, this.browser, [])) as CDPSession;
    this.session = session;
    this.detach = session.detach;
    const on = session.on;
    const off = session.off;
    const closed = () => {
      this.sessionClosed = true;
      if (!this.closing) {
        this.failure ??= Object.freeze({ value: new BrowserLifecycleError('OPERATION_FAILED') });
        try {
          this.lost();
        } catch (value) {
          this.failure ??= Object.freeze({ value });
        }
      }
    };
    this.remove = () => {
      Reflect.apply(off, session, ['close', closed]);
    };
    this.admitted();
    Reflect.apply(on, session, ['close', closed]);
    const send = session.send;
    sameContext();
    await Reflect.apply(send, session, [
      'Browser.setDownloadBehavior',
      { behavior: 'deny', eventsEnabled: false },
    ]);
    sameContext();
    if (this.failure) throw this.failure.value;
    if (this.sessionClosed) throw new BrowserLifecycleError('OPERATION_FAILED');
  }
  /** Fence initialization and mark expected SDK closure without releasing the deny override. */
  retire(): void {
    this.closing = true;
  }
  /** Join original initialization and session cleanup after actual browser shutdown entry. */
  close(): Promise<void> {
    this.retire();
    if (this.joined) return this.joined;
    this.joined = Promise.resolve().then(async () => {
      try {
        await this.ready;
      } catch (value) {
        this.failure ??= Object.freeze({ value });
      }
      // An exact original SDK close event already settled this session; a code/name is not proof.
      try {
        if (this.session && !this.sessionClosed) {
          if (!this.detach) throw new BrowserLifecycleError('OPERATION_FAILED');
          await Reflect.apply(this.detach, this.session, []);
        }
      } catch (value) {
        this.failure ??= Object.freeze({ value });
      }
      try {
        this.remove?.();
      } catch (value) {
        this.failure ??= Object.freeze({ value });
      }
      if (this.failure) throw this.failure.value;
    });
    void this.joined.catch(() => {});
    return this.joined;
  }
}

/** Join both original owners independently and preserve the first exact shutdown rejection. */
export async function closeBrowserAndDownloads(
  browser: Pick<Browser, 'close'> | undefined,
  downloads: Pick<DefaultDownloadOwner, 'close'> | undefined
): Promise<void> {
  let first: Readonly<{ value: unknown }> | undefined;
  try {
    await browser?.close();
  } catch (value) {
    first = { value };
  }
  try {
    await downloads?.close();
  } catch (value) {
    first ??= { value };
  }
  if (first) throw first.value;
}
