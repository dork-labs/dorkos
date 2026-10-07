import { readOriginalSelection, type SelectionCopy } from './selection-copy.js';
import { semanticNativeEffect, type NativeSemanticState } from '../semantic/native-effect.js';
import type { NativeSemanticTarget } from '../semantic/native-target.js';
import { OwnedResponseDownload, type OwnedDownloadSink } from '../files/response-download.js';
import { OwnedUploadChooser, type OwnedUploadLease } from '../files/upload-chooser.js';
import type { PointerLedger } from '../tabs/pointer.js';
import type { CDPSession, Page } from 'playwright-core';
import { registerOriginalPageSession } from '../navigation/native-same-document.js';
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
  /** Preserve the fixed SDK focus default on the lifetime-retained input session after noDefaults. */
  readonly preserveFocus?: boolean;
  readonly cleanup: InputCleanupRoute;
  readonly pointer: PointerLedger;
  readonly page: Page;
  current(): boolean;
  /** Constructor-private ordinary admission over engine-owned cells; no SDK or grant callbacks. */
  ordinary(): boolean;
  readBinding(): BrowserBinding | null;
  retire(): void;
}
/** A preregistered acquisition with irreversible admission retirement and shared teardown. */
export interface OwnedPageTransport {
  copySelection(signal: AbortSignal, current: () => boolean): Promise<SelectionCopy>;
  /** Fixed private native Page target metadata from this lifetime-retained original session. */
  semanticTarget(signal: AbortSignal): Promise<string>;
  semanticEffect(
    target: NativeSemanticTarget,
    focus: boolean,
    signal: AbortSignal,
    current: () => boolean
  ): Promise<NativeSemanticState>;
  /** Private fixed upload operations use this existing owned Page session only. */
  upload(lease: OwnedUploadLease, current: () => boolean): OwnedUploadChooser;
  /** One response-stage transfer uses the existing private input session. */
  download(sink: OwnedDownloadSink, current: () => boolean): OwnedResponseDownload;
  readonly native: NativeInputTransport;
  readonly ready: Promise<void>;
  /** Original session attribution; pending calls may be known, without authorizing effects. */
  isCustodyKnown(): boolean;
  /** Private original acquisition attribution; never authorizes native effects. */
  isAcquisitionCustodyKnown(): boolean;
  custody(): PageInputCustody;
  close(deadline?: number): Promise<PageInputCustody>;
}

/** Own exactly one public Page CDPSession; expose fixed input/composition operations and drag cancellation. */
export function createPageTransport(options: PageTransportOptions): OwnedPageTransport {
  if (!options.pointer) throw new Error('POINTER_OBSERVER_UNAVAILABLE');
  const owner = new PageTransportOwner(options);
  owner.acquire();
  return Object.freeze({
    native: owner.native,
    copySelection: (signal: AbortSignal, current: () => boolean) =>
      owner.copySelection(signal, current),
    download: (sink: OwnedDownloadSink, current: () => boolean) => owner.download(sink, current),
    upload: (lease: OwnedUploadLease, current: () => boolean) => owner.upload(lease, current),
    semanticTarget: (signal: AbortSignal) => owner.semanticTarget(signal),
    semanticEffect: (
      target: NativeSemanticTarget,
      focus: boolean,
      signal: AbortSignal,
      current: () => boolean
    ) => owner.semanticEffect(target, focus, signal, current),
    ready: owner.ready,
    isCustodyKnown: () => owner.isCustodyKnown(),
    isAcquisitionCustodyKnown: () => owner.isAcquisitionCustodyKnown(),
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
  private originalAcquisition?: Promise<CDPSession>;
  private acquisitionContext?: ReturnType<Page['context']>;
  private acquisitionEnd?: number;
  private acquisitionPending = true;
  private nativePending = 0;
  private readonly uploads = new Set<OwnedUploadChooser>();
  private readonly downloads = new Set<OwnedResponseDownload>();
  private semanticTargetId?: string;
  private readonly semanticSessions = new Map<CDPSession, { closing?: Promise<void> }>();
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
      dispatch: (step: NativeInputStep, signal: AbortSignal, current?: () => boolean) =>
        this.call(
          (guard, settle) => this.dispatch(step, guard, settle),
          signal,
          step,
          undefined,
          undefined,
          current
        ),
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

  async copySelection(signal: AbortSignal, current: () => boolean): Promise<SelectionCopy> {
    let result: SelectionCopy | undefined;
    const end = performance.now() + INPUT_BUDGET_MS;
    const original = this.call(
      async (guard) => {
        const session = this.session;
        if (!session) throw new Error('COPY_SESSION_REFUSED');
        const bounded = () => {
          guard();
          if (performance.now() >= end) throw new Error('COPY_READ_DEADLINE');
        };
        result = await readOriginalSelection(session, bounded);
      },
      signal,
      undefined,
      undefined,
      undefined,
      current
    );
    // The deadline bounds delivery; the original call stays retained by nativePending until return.
    await within(original, end, signal);
    if (!result) throw new Error('COPY_RESULT_REFUSED');
    return result;
  }
  /** Observe fixed native metadata using the already owned session; no new Page/session or action. */
  async semanticEffect(
    target: NativeSemanticTarget,
    focus: boolean,
    signal: AbortSignal,
    current: () => boolean
  ): Promise<NativeSemanticState> {
    let result: NativeSemanticState | undefined;
    await this.call(
      async (guard) => {
        const root = this.session;
        if (!root) throw new Error('SEMANTIC_SESSION_REFUSED');
        guard();
        if (target.nativeFrameSlot === undefined) {
          result = await semanticNativeEffect(root, target, guard, focus);
          return;
        }
        // Slot selects only a candidate from this original Page. Exact native target/frame
        // metadata and the fresh actor lease still authorize the effect, never array order.
        const frames = this.page.frames.bind(this.page);
        guard();
        const subjects = frames();
        guard();
        if (subjects.length > 32) throw new Error('SEMANTIC_FRAME_CAPACITY');
        const frame = subjects[target.nativeFrameSlot];
        if (!frame) throw new Error('SEMANTIC_FRAME_REFUSED');
        const framePage = frame.page.bind(frame),
          detached = frame.isDetached.bind(frame);
        const context = this.acquisitionContext;
        if (!context) throw new Error('SEMANTIC_SESSION_REFUSED');
        const create = context.newCDPSession.bind(context);
        const frameGuard = () => {
          const page = framePage(),
            stopped = detached(),
            members = frames();
          guard();
          if (
            page !== this.page ||
            stopped ||
            members.length > 32 ||
            members[target.nativeFrameSlot!] !== frame
          )
            throw new Error('SEMANTIC_FRAME_REFUSED');
        };
        frameGuard();
        const session = await create(frame);
        if (session === root || this.semanticSessions.has(session))
          throw new Error('SEMANTIC_SESSION_REFUSED');
        const owned: { closing?: Promise<void> } = {};
        this.semanticSessions.set(session, owned); // Original acquisition retained before any late guard.
        let first: Readonly<{ value: unknown }> | undefined;
        try {
          frameGuard();
          result = await semanticNativeEffect(session, target, frameGuard, focus);
        } catch (value) {
          first = { value };
        }
        try {
          await this.closeSemanticSession(session, owned);
        } catch (value) {
          first ??= { value };
        }
        if (first) throw first.value;
      },
      signal,
      undefined,
      undefined,
      undefined,
      current
    );
    if (!result) throw new Error('SEMANTIC_TARGET_REFUSED');
    return result;
  }
  async semanticTarget(signal: AbortSignal): Promise<string> {
    let targetId: string | undefined;
    await this.call(async (guard) => {
      const session = this.requireSession(),
        send = session.send.bind(session);
      guard();
      const observed = await send('Target.getTargetInfo');
      guard();
      const info = observed.targetInfo;
      if (
        info.type !== 'page' ||
        typeof info.targetId !== 'string' ||
        !/^[A-Za-z0-9_-]{1,128}$/.test(info.targetId) ||
        (this.semanticTargetId !== undefined && this.semanticTargetId !== info.targetId)
      )
        throw new Error('SEMANTIC_NATIVE_TARGET_REFUSED');
      guard();
      this.semanticTargetId = info.targetId;
      targetId = info.targetId;
    }, signal);
    if (!targetId) throw new Error('SEMANTIC_NATIVE_TARGET_REFUSED');
    return targetId;
  }

  /** Create only a private fixed chooser owner on the exact retained input session. */
  upload(lease: OwnedUploadLease, current: () => boolean): OwnedUploadChooser {
    const session = this.session;
    if (!session || !this.current() || this.uploads.size >= 16 || this.downloads.size)
      throw new Error('UPLOAD_SESSION_REFUSED');
    const owner = new OwnedUploadChooser(
      session,
      lease,
      () => this.current() && current() && this.current()
    );
    this.uploads.add(owner);
    const close = owner.close.bind(owner);
    owner.close = () => {
      const original = close();
      void original.then(
        () => this.uploads.delete(owner),
        () => {
          this.uncertain = true;
          this.uploads.delete(owner);
        }
      );
      return original;
    };
    return owner;
  }

  /** Exclusively arm one response owner so Fetch handler state cannot be overwritten by a sibling. */
  download(sink: OwnedDownloadSink, current: () => boolean): OwnedResponseDownload {
    const session = this.session;
    if (!session || !this.current() || this.downloads.size || this.uploads.size)
      throw new Error('DOWNLOAD_SESSION_REFUSED');
    const owner = new OwnedResponseDownload(
      session,
      sink,
      () => this.current() && current() && this.current()
    );
    this.downloads.add(owner);
    const close = owner.close.bind(owner);
    owner.close = () => {
      const original = close();
      void original.then(
        () => this.downloads.delete(owner),
        () => {
          this.uncertain = true;
          this.downloads.delete(owner);
        }
      );
      return original;
    };
    return owner;
  }

  acquire(): void {
    const end = performance.now() + INPUT_BUDGET_MS;
    this.acquisitionEnd = end;
    let complete!: () => void;
    // Install custody before invoking the external, possibly reentrant acquisition port.
    this.acquisition = new Promise<void>((resolve) => {
      complete = resolve;
    });
    const accept = (session: CDPSession) => {
      // Possession is retained even when producer registration refuses or reenters retirement.
      this.session = session;
      void Promise.resolve()
        .then(async () => {
          // Original registration owns terminal refusal and retains late session cleanup.
          this.options.cleanup.registerTarget(this.page, this, session);
          registerOriginalPageSession(this.page, session, this.isCustodyKnown.bind(this));
          if (this.options.preserveFocus && this.current()) {
            const send = session.send.bind(session);
            // Retirement fences an unstarted focus command without inventing an operational failure.
            if (!this.current()) return;
            // Preserve Playwright's fixed focus setting on this lifetime-retained original Page session.
            await Reflect.apply(send, session, [
              'Emulation.setFocusEmulationEnabled',
              { enabled: true },
            ]);
          }
        })
        .then(
          () => {
            this.acquisitionPending = false;
            complete();
            if (this.retired) void this.detach().catch(() => {});
          },
          (error: unknown) => {
            this.uncertain = true;
            fail(error);
            if (this.retired) void this.detach().catch(() => {});
          }
        );
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
      this.acquisitionContext = context;
      const create = context.newCDPSession;
      if (!this.current()) throw new Error('INPUT_TARGET_REFUSED');
      this.originalAcquisition = Promise.resolve(create.call(context, this.page));
      void this.originalAcquisition.then(accept, fail);
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
      [...this.uploads, ...this.downloads].every((owner) => !owner.custody().failed) &&
      !this.detachPending &&
      !this.detached &&
      this.detachPromise === undefined &&
      this.closePromise === undefined
    );
  }

  isAcquisitionCustodyKnown(): boolean {
    const eligible = () =>
      this.acquisition !== undefined &&
      this.originalAcquisition !== undefined &&
      this.acquisitionPending &&
      this.acquisitionEnd !== undefined &&
      !this.retired &&
      !this.uncertain &&
      !this.detachPending &&
      !this.detached &&
      this.detachPromise === undefined &&
      this.closePromise === undefined &&
      this.nativePending === 0;
    if (!eligible()) return false;
    try {
      const context = this.page.context();
      const current = this.current();
      const inTime = performance.now() < this.acquisitionEnd!;
      if (context !== this.acquisitionContext || !inTime) {
        this.uncertain = true;
        this.retire();
        return false;
      }
      return context === this.acquisitionContext && current && inTime && eligible();
    } catch {
      this.uncertain = true;
      this.retire();
      return false;
    }
  }

  custody(): PageInputCustody {
    const uploads = [...this.uploads, ...this.downloads].map((owner) => owner.custody());
    const nativePending =
      this.nativePending + uploads.reduce((count, upload) => count + upload.pending, 0);
    return Object.freeze({
      acquisitionPending: this.acquisitionPending,
      nativePending,
      detachPending: this.detachPending,
      detached: this.detached,
      uncertain:
        this.uncertain ||
        this.acquisitionPending ||
        nativePending > 0 ||
        uploads.some((owner) => owner.failed) ||
        this.detachPending,
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

  private closeSemanticSession(
    session: CDPSession,
    owned: { closing?: Promise<void> }
  ): Promise<void> {
    return (owned.closing ??= Promise.resolve().then(async () => {
      const detach = session.detach.bind(session);
      await detach();
      if (this.semanticSessions.get(session) === owned) this.semanticSessions.delete(session);
    }));
  }

  private async finishClose(): Promise<PageInputCustody> {
    // An expired wait budget cannot suppress an exact-owned cleanup attempt.
    const originals = [
      ...[...this.uploads, ...this.downloads].map((owner) =>
        Promise.resolve().then(() => owner.close())
      ),
      ...[...this.semanticSessions].map(([session, owned]) =>
        this.closeSemanticSession(session, owned)
      ),
    ];
    if (originals.length) {
      try {
        const outcomes = await within(Promise.allSettled(originals), this.end!);
        if (outcomes.some((outcome) => outcome.status === 'rejected')) this.uncertain = true;
      } catch {
        this.uncertain = true;
      }
    }
    const detach = this.session ? this.detach() : undefined;
    try {
      if (this.acquisition) await within(this.acquisition, this.end!);
      if (this.session) await within(detach ?? this.detach(), this.end!);
      if (this.nativePending > 0 || this.semanticSessions.size > 0) this.uncertain = true;
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
    attempt?: CleanupAttempt,
    operationCurrent?: () => boolean
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
        (operationCurrent !== undefined && !operationCurrent()) ||
        // The Work callback may synchronously retire the owning admission cell.
        !this.options.ordinary() ||
        // The Work callback may synchronously replace the canonical Page or binding.
        // The private data-only observation must be last, after every fallible SDK/grant read.
        !sameBinding(this.options.readBinding(), binding) ||
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
      case 'composition': {
        const session = this.requireSession(),
          send = session.send;
        run = () =>
          send
            .call(session, 'Input.imeSetComposition', {
              text: step.text,
              selectionStart: step.selectionStart,
              selectionEnd: step.selectionEnd,
            })
            .then(() => {});
        break;
      }
      case 'compositionCommit': {
        const session = this.requireSession(),
          send = session.send;
        run = () => send.call(session, 'Input.insertText', { text: step.text }).then(() => {});
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
