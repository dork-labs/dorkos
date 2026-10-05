import type { EnginePolicy } from '../configuration.js';
import { parseBrowserCommand, type BrowserBinding } from '../contracts.js';
import { BrowserValidationError } from '../errors.js';
import type { TabRecord } from '../lifecycle/records.js';
import type { BrowserStopGate } from '../lifecycle/stop.js';
import { sameBinding } from './binding.js';
import { INPUT_BUDGET_MS } from './budget.js';
import {
  createPageTransport,
  type OwnedPageTransport,
  type PageInputCustody,
} from './page-transport.js';
import { createTabInput } from './tab-input.js';
import type { InputResult, ResetResult, TabInput, InputCleanupRoute } from './types.js';
import type { CleanupObservation } from '../lifecycle/ownership.js';

/** Parent registry owns one composition per actual canonical TabRecord/Page lifetime. */
export interface EngineInputOptions {
  readonly cleanup: InputCleanupRoute;
  readonly tab: TabRecord;
  readonly stopGate: BrowserStopGate;
  readonly policy: EnginePolicy;
  readTab(): TabRecord | null;
}
/** Private fixture composition; no Page, protocol target or authority comes from command bodies. */
export interface EngineTabInput {
  readonly ready: Promise<void>;
  submit(command: unknown, signal?: AbortSignal): Promise<InputResult>;
  reset(): Promise<ResetResult>;
  retire(end: number): Promise<CleanupObservation>;
  close(deadline?: number): Promise<PageInputCustody>;
  /** Original input/session attribution, not a settled-cleanup or action permission. */
  isCustodyKnown(): boolean;
  custody(): PageInputCustody;
}

/** Compose the accepted queue with a canonical public Page transport without public activation. */
export function createEngineInput(options: EngineInputOptions): EngineTabInput {
  const owner = new EngineInputOwner(options);
  owner.acquire();
  return Object.freeze({
    ready: owner.ready,
    submit: (command: unknown, signal?: AbortSignal) => owner.submit(command, signal),
    reset: () => owner.reset(),
    retire: (end: number) => owner.retire(end),
    close: (deadline?: number) => owner.close(deadline),
    isCustodyKnown: () => owner.isCustodyKnown(),
    custody: () => owner.custody(),
  });
}

class EngineInputOwner {
  readonly ready: Promise<void>;
  private resolve!: () => void;
  private reject!: (error: unknown) => void;
  private readonly initial: BrowserBinding;
  private readonly page;
  private transport?: OwnedPageTransport;
  private queue?: TabInput;
  private closePromise?: Promise<PageInputCustody>;
  private closeEnd?: number;
  private resetPromise?: Promise<ResetResult>;
  private resetEnd?: number;
  private retired = false;
  private retirement?: Promise<CleanupObservation>;
  private retirementEnd?: number;
  private cleanupUncertain = false;
  private acquiring = false;
  private unregister: (() => void) | null = null;
  private readonly invalidate = () => {
    this.options.cleanup.requestRetirement('engineFault');
  };
  private readonly navigation: (frame: import('playwright-core').Frame) => void;

  constructor(private readonly options: EngineInputOptions) {
    this.initial = Object.freeze({ ...options.tab.binding });
    this.page = options.tab.page;
    this.navigation = (frame) => {
      if (frame === this.page.mainFrame()) this.invalidate();
    };
    this.ready = new Promise<void>((resolve, reject) => {
      this.resolve = resolve;
      this.reject = reject;
    });
    void this.ready.catch(() => {});
  }

  acquire(): void {
    // All local state and the terminal callback exist before session creation or Page callbacks.
    this.unregister = this.options.stopGate.register(this.initial, () => {
      // Gate.stop is admission only; parent supplies its existing deadline to close.
      this.options.tab.pointer.invalidate();
      this.retired = true;
    });
    try {
      if (!this.current()) throw new Error('INPUT_TARGET_REFUSED');
      this.page.on('close', this.invalidate);
      this.page.on('framenavigated', this.navigation);
      this.acquiring = true;
      this.transport = createPageTransport({
        cleanup: this.options.cleanup,
        pointer: this.options.tab.pointer,
        page: this.page,
        current: () => this.current(),
        readBinding: () => this.canonicalBinding(),
        retire: () => this.invalidate(),
      });
      this.acquiring = false;
      if (this.closeEnd !== undefined) void this.transport.close(this.closeEnd);
      void this.transport.ready
        .then(() => {
          if (!this.current()) throw new Error('INPUT_TARGET_REFUSED');
          const queue = createTabInput({
            cleanup: this.options.cleanup,
            readBinding: () =>
              this.current() ? Object.freeze({ ...this.options.tab.binding }) : null,
            publishResetBinding: (binding) => this.publish(binding),
            authorize: (binding, _step, signal) =>
              this.options.policy.authorizeAction(binding, signal),
            native: this.transport!.native,
            stopGate: this.options.stopGate,
          });
          if (!this.current()) throw new Error('INPUT_TARGET_REFUSED');
          this.queue = queue;
          this.resolve();
        })
        .catch((error: unknown) => {
          this.reject(error);
          this.invalidate();
        });
    } catch (error) {
      this.reject(error);
      this.invalidate();
    }
  }

  async submit(value: unknown, signal?: AbortSignal): Promise<InputResult> {
    const command = parseBrowserCommand(value);
    if (command.kind !== 'input') throw new BrowserValidationError('INVALID_COMMAND');
    // Do not make requests during acquisition wait for a later native lifetime.
    if (
      this.resetPromise ||
      !this.queue ||
      !this.current() ||
      !sameBinding(this.options.tab.binding, command.binding)
    )
      return Object.freeze({
        kind: 'action',
        requestId: command.requestId,
        binding: command.binding,
        outcome: 'rejected',
        reason: this.options.stopGate.stopped ? 'stopped' : 'staleBinding',
      });
    return this.queue.submit(command, signal);
  }

  reset(): Promise<ResetResult> {
    if (!this.options.cleanup.ordinary() || this.retired)
      return Promise.resolve(Object.freeze({ binding: this.initial, status: 'stopped' }));
    this.options.tab.pointer.invalidate();
    if (this.resetPromise) return this.resetPromise;
    let resolve!: (result: ResetResult) => void;
    const shared = new Promise<ResetResult>((done) => {
      resolve = done;
    });
    // Publish before any registry observation or native callback can reenter reset.
    this.resetPromise = shared;
    this.resetEnd = performance.now() + INPUT_BUDGET_MS;
    void shared.then(() => {
      if (this.resetPromise === shared) {
        this.resetPromise = undefined;
        this.resetEnd = undefined;
      }
    });
    const fail = () => {
      if (!this.options.cleanup.retiring()) this.invalidate();
      resolve(Object.freeze({ binding: this.initial, status: 'stopped' }));
    };
    try {
      if (!this.queue || !this.current()) fail();
      else void this.queue.reset().then(resolve, fail);
    } catch {
      fail();
    }
    return shared;
  }

  /** Exact private parent cleanup, without terminal gate-stop or successor publication. */
  retire(end: number): Promise<CleanupObservation> {
    if (this.retirement) return this.retirement;
    let complete!: (value: CleanupObservation) => void;
    this.retirement = new Promise((done) => {
      complete = done;
    });
    this.retired = true;
    this.retirementEnd = Math.min(end, this.resetEnd ?? end, this.closeEnd ?? end);
    try {
      this.options.tab.pointer.invalidate();
      if (
        !Number.isFinite(this.retirementEnd) ||
        this.retirementEnd < 0 ||
        !this.options.cleanup.retiring() ||
        !this.queue
      ) {
        this.cleanupUncertain = true;
        complete(
          Object.freeze({
            state: 'unverified',
            binding: null,
            reason: 'permitUnavailable',
            pending: this.acquiring || !this.queue,
            uncertainty: true,
          })
        );
      } else {
        const queue = this.queue;
        const retire = queue.retire;
        if (!this.options.cleanup.retiring()) throw new Error('INPUT_RETIREMENT_REFUSED');
        void Reflect.apply(retire, queue, [this.retirementEnd]).then(
          (observation: CleanupObservation) => {
            const transport = this.transport;
            const observe = transport?.custody;
            const custody = transport && observe ? Reflect.apply(observe, transport, []) : null;
            const binding = this.options.cleanup.binding();
            const known =
              observation.state === 'settled' &&
              custody &&
              !custody.acquisitionPending &&
              custody.nativePending === 0 &&
              !custody.detachPending &&
              !custody.uncertain &&
              !this.acquiring &&
              !this.cleanupUncertain &&
              !this.options.stopGate.stopped &&
              this.options.cleanup.retiring() &&
              binding &&
              sameBinding(binding, observation.binding);
            if (known) complete(observation);
            else {
              this.cleanupUncertain = true;
              const pending =
                !custody ||
                custody.acquisitionPending ||
                custody.nativePending !== 0 ||
                custody.detachPending ||
                this.acquiring;
              if (binding)
                complete(
                  Object.freeze({
                    state: 'unverified',
                    binding,
                    reason: 'custodyPending',
                    pending,
                    uncertainty: true,
                  })
                );
              else
                complete(
                  Object.freeze({
                    state: 'unverified',
                    binding: null,
                    reason: 'observationUnavailable',
                    pending,
                    uncertainty: true,
                  })
                );
            }
          },
          () => {
            this.cleanupUncertain = true;
            complete(
              Object.freeze({
                state: 'unverified',
                binding: null,
                reason: 'observationUnavailable',
                pending: true,
                uncertainty: true,
              })
            );
          }
        );
      }
    } catch {
      this.cleanupUncertain = true;
      complete(
        Object.freeze({
          state: 'unverified',
          binding: null,
          reason: 'observationUnavailable',
          pending: true,
          uncertainty: true,
        })
      );
    }
    return this.retirement;
  }

  close(deadline?: number): Promise<PageInputCustody> {
    if (!this.options.cleanup.terminal()) {
      this.options.cleanup.requestRetirement('explicitStop');
      // This private terminal method cannot bypass sibling drain or report an ordinary close as complete.
      throw new Error('INPUT_TERMINAL_ONLY_CLOSE');
    }
    if (this.closePromise) return this.closePromise;
    this.closeEnd = Math.min(
      performance.now() + INPUT_BUDGET_MS,
      deadline ?? Infinity,
      this.resetEnd ?? Infinity,
      this.retirementEnd ?? Infinity
    );
    let resolve!: (custody: PageInputCustody) => void;
    this.closePromise = new Promise((done) => {
      resolve = done;
    });
    this.options.tab.pointer.invalidate();
    this.retired = true;
    // stop first; reset on a stopped gate must never manufacture a native release.
    this.options.stopGate.stop();
    this.unregister?.();
    this.unregister = null;
    for (const remove of [
      () => this.page.off('close', this.invalidate),
      () => this.page.off('framenavigated', this.navigation),
    ]) {
      try {
        remove();
      } catch {
        this.cleanupUncertain = true;
      }
    }
    if (this.transport)
      void this.transport.close(this.closeEnd).then(() => resolve(this.custody()));
    else resolve(this.custody());
    return this.closePromise;
  }

  isCustodyKnown(): boolean {
    return (
      this.queue !== undefined &&
      this.transport !== undefined &&
      !this.acquiring &&
      !this.retired &&
      !this.cleanupUncertain &&
      this.closePromise === undefined &&
      this.retirement === undefined &&
      this.transport.isCustodyKnown()
    );
  }

  custody(): PageInputCustody {
    const custody =
      this.transport?.custody() ??
      Object.freeze({
        acquisitionPending: this.acquiring,
        nativePending: 0,
        detachPending: false,
        detached: false,
        uncertain: true,
      });
    return Object.freeze({ ...custody, uncertain: custody.uncertain || this.cleanupUncertain });
  }

  /** Observe genuine canonical membership without treating retirement as a replacement. */
  private canonicalBinding(): BrowserBinding | null {
    try {
      const closed = this.page.isClosed();
      const tab = this.options.readTab();
      if (closed || tab !== this.options.tab || tab.page !== this.page || tab.stopped) return null;
      const binding = Object.freeze({ ...tab.binding });
      if (tab.page !== this.page || tab.stopped || !sameBinding(tab.binding, binding)) return null;
      return binding;
    } catch {
      this.invalidate();
      return null;
    }
  }

  private current(): boolean {
    if (
      this.retired ||
      !this.options.cleanup.ordinary() ||
      !this.options.stopGate.accepts(this.initial)
    )
      return false;
    try {
      const tab = this.options.readTab();
      return (
        !this.retired &&
        this.options.cleanup.ordinary() &&
        this.options.stopGate.accepts(this.initial) &&
        tab === this.options.tab &&
        tab.page === this.page &&
        !tab.stopped &&
        tab.binding.browserId === this.initial.browserId &&
        tab.binding.browserGeneration === this.initial.browserGeneration &&
        tab.binding.tabId === this.initial.tabId &&
        tab.binding.navigationGeneration === this.initial.navigationGeneration &&
        tab.binding.viewportVersion === this.initial.viewportVersion &&
        !this.page.isClosed() &&
        !this.retired &&
        this.options.cleanup.ordinary() &&
        this.options.stopGate.accepts(this.initial)
      );
    } catch {
      this.invalidate();
      return false;
    }
  }

  private publish(binding: BrowserBinding): void {
    if (!this.current()) throw new Error('INPUT_TARGET_REFUSED');
    const before = this.options.tab.binding;
    if (
      binding.epoch !== before.epoch + 1 ||
      binding.inputGeneration !== before.inputGeneration + 1 ||
      !sameBinding(
        { ...binding, epoch: before.epoch, inputGeneration: before.inputGeneration },
        before
      )
    )
      throw new Error('INPUT_RESET_BINDING_REFUSED');
    this.options.tab.pointer.invalidate();
    const published = Object.freeze({ ...binding });
    this.options.tab.binding = published;
    const diagnostics = this.options.tab.diagnostics;
    const refresh = diagnostics.replaceEpoch;
    if (!this.current() || !sameBinding(this.options.tab.binding, published))
      throw new Error('INPUT_RESET_BINDING_REFUSED');
    Reflect.apply(refresh, diagnostics, []);
    // Observer clock/current callbacks may synchronously retire or replace the canonical target.
    if (!this.current() || !sameBinding(this.options.tab.binding, published))
      throw new Error('INPUT_RESET_BINDING_REFUSED');
  }
}
