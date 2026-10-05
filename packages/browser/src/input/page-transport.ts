import type { PointerLedger } from '../tabs/pointer.js';
import type { CDPSession, Page } from 'playwright-core';
import type { BrowserBinding } from '../contracts.js';
import { sameBinding } from './binding.js';
import { INPUT_BUDGET_MS, within } from './budget.js';
import type { NativeInputStep, NativeInputTransport, InputCleanupRoute } from './types.js';
import type { CleanupPermit, CleanupAttempt } from '../lifecycle/ownership.js';

/** Session custody only; neither detach nor these counts certify browser process closure. */
export interface PageInputCustody {
  readonly acquisitionPending: boolean;
  readonly nativePending: number;
  readonly detachPending: boolean;
  readonly detached: boolean;
  readonly uncertain: boolean;
}
/** Private canonical Page port, never accepted from an input command. */
export interface PageTransportOptions {
  readonly cleanup: InputCleanupRoute;
  readonly pointer: PointerLedger;
  readonly page: Page;
  current(): boolean;
  readBinding(): BrowserBinding | null;
  retire(): void;
}
/** A preregistered acquisition with irreversible admission retirement and shared teardown. */
export interface OwnedPageTransport {
  readonly native: NativeInputTransport;
  readonly ready: Promise<void>;
  /** Original session attribution; pending calls may be known, without authorizing effects. */
  isCustodyKnown(): boolean;
  custody(): PageInputCustody;
  close(deadline?: number): Promise<PageInputCustody>;
}

/** Own exactly one public Page CDPSession; expose only fixed composition/drag cancellation. */
export function createPageTransport(options: PageTransportOptions): OwnedPageTransport {
  if (!options.pointer) throw new Error('POINTER_OBSERVER_UNAVAILABLE');
  const owner = new PageTransportOwner(options);
  owner.acquire();
  return Object.freeze({
    native: owner.native,
    ready: owner.ready,
    isCustodyKnown: () => owner.isCustodyKnown(),
    custody: () => owner.custody(),
    close: (deadline?: number) => owner.close(deadline),
  });
}

class PageTransportOwner {
  readonly ready: Promise<void>;
  readonly native: NativeInputTransport;
  private resolve!: () => void;
  private reject!: (error: unknown) => void;
  private readonly page: Page;
  private session?: CDPSession;
  private acquisition?: Promise<void>;
  private acquisitionPending = true;
  private nativePending = 0;
  private readonly heldKeys = new Set<string>();
  private readonly heldButtons = new Set<string>();
  private retired = false;
  private uncertain = false;
  private detached = false;
  private detachPromise?: Promise<void>;
  private detachPending = false;
  private closePromise?: Promise<PageInputCustody>;
  private end?: number;

  constructor(private readonly options: PageTransportOptions) {
    this.page = options.page;
    this.ready = new Promise<void>((resolve, reject) => {
      this.resolve = resolve;
      this.reject = reject;
    });
    // Readiness failures are observable even if acquisition synchronously reenters close.
    void this.ready.catch(() => {});
    this.native = Object.freeze({
      dispatch: (step: NativeInputStep, signal: AbortSignal) =>
        this.call((guard, settle) => this.dispatch(step, guard, settle), signal, step),
      cancelComposition: (signal: AbortSignal) =>
        this.call((guard) => this.sendCancel('Input.imeSetComposition', guard), signal),
      cancelDrag: (signal: AbortSignal) =>
        this.call((guard) => this.sendCancel('Input.cancelDragging', guard), signal),
      cleanup: (permit: CleanupPermit, attempt: CleanupAttempt, signal: AbortSignal) => {
        const step = attempt.step;
        return this.call(
          (guard, settle) => {
            if (step.kind === 'cancelComposition')
              return this.sendCancel('Input.imeSetComposition', guard);
            if (step.kind === 'cancelDrag') return this.sendCancel('Input.cancelDragging', guard);
            return this.dispatch(step, guard, settle);
          },
          signal,
          undefined,
          permit,
          attempt
        );
      },
    });
  }

  acquire(): void {
    const end = performance.now() + INPUT_BUDGET_MS;
    let complete!: () => void;
    // Install custody before invoking the external, possibly reentrant acquisition port.
    this.acquisition = new Promise<void>((resolve) => {
      complete = resolve;
    });
    const accept = (session: CDPSession) => {
      // Possession is retained even when producer registration refuses or reenters retirement.
      this.session = session;
      try {
        this.options.cleanup.registerTarget(this.page, this, session);
      } catch (error) {
        this.uncertain = true;
        this.reject(error);
        this.retire();
      } finally {
        this.acquisitionPending = false;
        complete();
        if (this.retired) void this.detach().catch(() => {});
      }
    };
    const fail = (error: unknown) => {
      this.acquisitionPending = false;
      complete();
      this.reject(error);
      this.retire();
    };
    try {
      if (!this.current()) throw new Error('INPUT_TARGET_REFUSED');
      const context = this.page.context();
      const create = context.newCDPSession;
      if (!this.current()) throw new Error('INPUT_TARGET_REFUSED');
      void Promise.resolve(create.call(context, this.page)).then(accept, fail);
    } catch (error) {
      fail(error);
    }
    void within(this.acquisition, end)
      .then(() => {
        if (!this.session || !this.current()) throw new Error('INPUT_SESSION_REFUSED');
        this.resolve();
      })
      .catch((error: unknown) => {
        this.uncertain ||= this.acquisitionPending;
        this.reject(error);
        this.retire();
        // The parent driver enters terminal detach after eligible sibling cleanup.
        // Possession/session uncertainty remains retained meanwhile.
      });
  }

  isCustodyKnown(): boolean {
    return (
      this.session !== undefined &&
      !this.acquisitionPending &&
      !this.retired &&
      !this.uncertain &&
      !this.detachPending &&
      !this.detached &&
      this.detachPromise === undefined &&
      this.closePromise === undefined
    );
  }

  custody(): PageInputCustody {
    return Object.freeze({
      acquisitionPending: this.acquisitionPending,
      nativePending: this.nativePending,
      detachPending: this.detachPending,
      detached: this.detached,
      uncertain:
        this.uncertain || this.acquisitionPending || this.nativePending > 0 || this.detachPending,
    });
  }

  close(deadline?: number): Promise<PageInputCustody> {
    if (!this.options.cleanup.terminal()) {
      this.options.cleanup.requestRetirement('explicitStop');
      throw new Error('INPUT_TERMINAL_ONLY_CLOSE');
    }
    if (this.closePromise) return this.closePromise;
    this.end = Math.min(performance.now() + INPUT_BUDGET_MS, deadline ?? Infinity);
    let resolve!: (custody: PageInputCustody) => void;
    this.closePromise = new Promise((done) => {
      resolve = done;
    });
    this.uncertain ||= this.heldKeys.size > 0 || this.heldButtons.size > 0;
    // Genuine terminal owner already fenced ordinary admission; this is deliberate local teardown.
    this.retire(false);
    void this.finishClose().then(resolve);
    return this.closePromise;
  }

  private async finishClose(): Promise<PageInputCustody> {
    // An expired wait budget cannot suppress an exact-owned cleanup attempt.
    const detach = this.session ? this.detach() : undefined;
    try {
      if (this.acquisition) await within(this.acquisition, this.end!);
      if (this.session) await within(detach ?? this.detach(), this.end!);
      if (this.nativePending > 0) this.uncertain = true;
    } catch {
      this.uncertain = true;
    }
    return this.custody();
  }

  private retire(notifyFault = true): void {
    if (this.retired) return;
    this.retired = true;
    // Admission/first cause is fenced before externally observable pointer invalidation.
    try {
      if (notifyFault) this.options.retire();
    } catch {
      this.uncertain = true;
    }
    try {
      this.pointerInvalidate();
    } catch {
      this.uncertain = true;
    }
  }

  private current(): boolean {
    if (this.retired) return false;
    try {
      const current = this.options.current() && this.options.cleanup.ordinary();
      const page = this.page;
      const isClosed = page.isClosed;
      if (!current || this.retired || !this.options.cleanup.ordinary()) return false;
      const closed = Reflect.apply(isClosed, page, []);
      return !closed && !this.retired && this.options.current() && this.options.cleanup.ordinary();
    } catch {
      return false;
    }
  }

  private requireSession(): CDPSession {
    if (!this.session) throw new Error('INPUT_SESSION_UNAVAILABLE');
    return this.session;
  }

  private detach(): Promise<void> {
    if (this.detachPromise) return this.detachPromise;
    this.detachPending = true;
    let resolve!: () => void;
    let reject!: (error: unknown) => void;
    this.detachPromise = new Promise<void>((done, fail) => {
      resolve = done;
      reject = fail;
    });
    void this.detachPromise.catch(() => {});
    try {
      void Promise.resolve(this.requireSession().detach()).then(
        () => {
          this.detachPending = false;
          this.detached = true;
          resolve();
        },
        (error: unknown) => {
          this.detachPending = false;
          this.uncertain = true;
          reject(error);
        }
      );
    } catch (error) {
      this.detachPending = false;
      this.uncertain = true;
      reject(error);
    }
    return this.detachPromise;
  }

  private sendCancel(
    method: 'Input.imeSetComposition' | 'Input.cancelDragging',
    guard: () => void
  ): Promise<void> {
    const session = this.requireSession();
    const send = session.send;
    guard();
    if (method === 'Input.imeSetComposition')
      return send
        .call(session, method, { text: '', selectionStart: 0, selectionEnd: 0 })
        .then(() => {});
    return send.call(session, method).then(() => {});
  }

  private pointerInvalidate(): void {
    try {
      if (this.options.pointer?.invalidate() !== undefined) this.options.pointer?.unavailable();
    } catch {
      this.options.pointer?.unavailable();
    }
  }

  private call(
    start: (guard: () => void, settle: () => void) => Promise<void>,
    signal: AbortSignal,
    step?: NativeInputStep,
    permit?: CleanupPermit,
    attempt?: CleanupAttempt
  ): Promise<void> {
    this.nativePending++;
    let resolve!: () => void;
    let reject!: (error: unknown) => void;
    const operation = new Promise<void>((done, fail) => {
      resolve = done;
      reject = fail;
    });
    let binding: BrowserBinding | null = null;
    let ticket: object | null = null;
    const fail = (error: unknown) => {
      this.pointerInvalidate();
      this.nativePending--;
      this.uncertain = true;
      reject(error);
    };
    const exactSettlement = () => {
      const session = this.session;
      if (!session || !binding || this.retired) return false;
      const observed = this.options.cleanup.binding();
      const page = this.page;
      const isClosed = page.isClosed;
      if (
        !sameBinding(observed, binding) ||
        this.retired ||
        !this.options.cleanup.settlement(binding, this, session, this.page)
      )
        return false;
      const closed = Reflect.apply(isClosed, page, []);
      return (
        !closed &&
        !this.retired &&
        sameBinding(this.options.cleanup.binding(), binding) &&
        this.options.cleanup.settlement(binding, this, session, this.page) &&
        !this.retired
      );
    };
    const settle = () => {
      if (!exactSettlement()) throw new Error('INPUT_ACK_TARGET_REFUSED');
    };
    const guard = () => {
      const session = this.session;
      if (!session || !binding || this.retired || signal.aborted)
        throw new Error('INPUT_TARGET_REFUSED');
      if (permit) {
        if (
          !attempt ||
          !this.options.cleanup.allows(permit, binding, this, session, this.page) ||
          !exactSettlement() ||
          !sameBinding(this.options.readBinding(), binding) ||
          !exactSettlement() ||
          !this.options.cleanup.retiring() ||
          this.retired ||
          signal.aborted ||
          // Fallible canonical/Page observations precede the producer's final clock/private fence.
          !this.options.cleanup.allows(permit, binding, this, session, this.page)
        )
          throw new Error('INPUT_CLEANUP_TARGET_REFUSED');
      } else if (
        !this.current() ||
        !sameBinding(this.options.readBinding(), binding) ||
        !this.current() ||
        this.retired ||
        signal.aborted
      )
        throw new Error('INPUT_TARGET_REFUSED');
    };
    try {
      if (permit && (!attempt || !this.options.cleanup.enter(permit, attempt)))
        throw new Error('INPUT_CLEANUP_PERMIT_REFUSED');
      binding = permit ? this.options.cleanup.binding() : this.options.readBinding();
      guard();
      if (step?.kind === 'mouseMove' && this.options.pointer) {
        try {
          ticket = this.options.pointer.beginMove(step.x, step.y);
          if (ticket !== null && this.options.pointer.accepts(ticket) !== true) {
            this.options.pointer.unavailable();
            ticket = null;
          }
        } catch {
          this.options.pointer.unavailable();
        }
      }
      guard();
      void Promise.resolve(start(guard, settle)).then(() => {
        try {
          settle();
          if (step?.kind === 'mouseMove' && this.options.pointer && this.current()) {
            try {
              if (this.options.pointer.success(ticket) !== undefined)
                this.options.pointer.unavailable();
            } catch {
              this.options.pointer.unavailable();
            }
            guard();
          } else if (!this.current()) this.pointerInvalidate();
          this.nativePending--;
          resolve();
        } catch (error) {
          fail(error);
        }
      }, fail);
    } catch (error) {
      fail(error);
    }
    return operation;
  }

  private dispatch(step: NativeInputStep, guard: () => void, settle: () => void): Promise<void> {
    const page = this.page;
    const mouse = page.mouse;
    const keyboard = page.keyboard;
    let run: () => Promise<void>;
    switch (step.kind) {
      case 'mouseMove': {
        const size = page.viewportSize();
        if (!size || step.x >= size.width || step.y >= size.height)
          throw new Error('INPUT_VIEWPORT_REFUSED');
        const move = mouse.move;
        run = () => move.call(mouse, step.x, step.y);
        break;
      }
      case 'mouseDown': {
        const down = mouse.down;
        run = () => down.call(mouse, { button: step.button });
        break;
      }
      case 'mouseUp': {
        const up = mouse.up;
        run = () => up.call(mouse, { button: step.button });
        break;
      }
      case 'wheel': {
        const wheel = mouse.wheel;
        run = () => wheel.call(mouse, step.deltaX, step.deltaY);
        break;
      }
      case 'keyDown': {
        const down = keyboard.down;
        run = () => down.call(keyboard, step.key);
        break;
      }
      case 'keyUp': {
        const up = keyboard.up;
        run = () => up.call(keyboard, step.key);
        break;
      }
      case 'text': {
        const insert = keyboard.insertText;
        run = () => insert.call(keyboard, step.text);
        break;
      }
    }
    guard();
    if (step.kind === 'keyDown') this.heldKeys.add(step.key);
    if (step.kind === 'mouseDown') this.heldButtons.add(step.button);
    return run().then(() => {
      settle();
      if (step.kind === 'keyUp') this.heldKeys.delete(step.key);
      if (step.kind === 'mouseUp') this.heldButtons.delete(step.button);
    });
  }
}
