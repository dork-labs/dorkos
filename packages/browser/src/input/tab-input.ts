import { observeOriginalQueueAdmission } from './acceptance-observer.js';
import {
  consumeSemanticInputWork,
  semanticInputCurrent,
  executeSemanticInputWork,
  settleSemanticInputWork,
  type OwnedSemanticInputWork,
} from './semantic-work.js';
import {
  consumeOwnedInputWork,
  ownedInputWorkCurrent,
  authorizeOwnedInputWork,
  settleOwnedInputWork,
  type OwnedInputWork,
} from './owned-work.js';
import { parseBrowserCommand, type BrowserBinding, type BrowserCommand } from '../contracts.js';
import { advanceCounter } from '../counters.js';
import { BrowserValidationError } from '../errors.js';
import { sameBinding } from './binding.js';
import { INPUT_BUDGET_MS, InputDeadline, within } from './budget.js';
import { expandInput } from './expand.js';
import { HeldInput, type ReleaseLedger } from './held.js';
import type { CleanupAttempt, CleanupObservation, CleanupPermit } from '../lifecycle/ownership.js';
import type {
  InputPorts,
  InputReason,
  InputResult,
  NativeInputStep,
  NativeInputTransport,
  ResetResult,
  TabInput,
} from './types.js';

type InputCommand = Extract<BrowserCommand, { kind: 'input' }>;
type Work = {
  ownedWork?: OwnedInputWork;
  semanticWork?: OwnedSemanticInputWork;
  semanticReject?(value: unknown): void;
  command: InputCommand;
  steps: readonly NativeInputStep[];
  end: number;
  cancel: AbortController;
  settle(result: InputResult): void;
  dispose(): void;
};

const semanticOwners = new WeakMap<Work, object>();

/** One native queue per canonical tab; failed barriers stop its whole browser admission gate. */
export function createTabInput(ports: InputPorts): TabInput {
  const queue = new InputQueue(ports);
  return Object.freeze({
    submit: (command: unknown, signal?: AbortSignal, ownedWork?: OwnedInputWork) =>
      queue.submit(command, signal, ownedWork),
    submitSemantic: (work: OwnedSemanticInputWork, signal?: AbortSignal) =>
      queue.submitSemantic(work, signal),
    reset: () => queue.reset(),
    retire: (end: number) => queue.retire(end),
    stop: () => ports.cleanup.requestRetirement('explicitStop'),
  });
}

class InputQueue implements TabInput {
  private readonly held = new HeldInput();
  private readonly pending: Work[] = [];
  private readonly initial: BrowserBinding;
  private active: Work | null = null;
  private nativePending: Promise<void> | null = null;
  private stopped = false;
  private barrier = false;
  private resetPromise: Promise<ResetResult> | null = null;
  private resetLedger: ReleaseLedger | null = null;
  private resetBinding: BrowserBinding | null = null;
  private resetEnd: number | undefined;
  private retired = false;
  private retirement: Promise<CleanupObservation> | null = null;
  private permit: CleanupPermit | null = null;
  private drainUncertain = false;
  private unregister: (() => void) | null;

  constructor(private readonly ports: InputPorts) {
    const initial = ports.readBinding();
    if (!initial || !ports.cleanup.ordinary()) throw new BrowserValidationError('INVALID_COMMAND');
    this.initial = Object.freeze({ ...initial });
    this.unregister = ports.stopGate.register(this.initial, () => this.stop());
    if (!this.unregister) this.stopped = true;
  }

  submit(value: unknown, signal?: AbortSignal, ownedWork?: OwnedInputWork): Promise<InputResult> {
    const command = parseBrowserCommand(value);
    if (command.kind !== 'input') throw new BrowserValidationError('INVALID_COMMAND');
    command.binding = Object.freeze({ ...command.binding });
    const steps = expandInput(command.steps);
    const reason = this.refusal(command.binding);
    if (reason) return Promise.resolve(this.result(command, 'rejected', reason));
    if (!steps || this.pending.length + (this.active ? 1 : 0) >= 64)
      return Promise.resolve(this.result(command, 'rejected', 'policyRefused'));
    const cancel = new AbortController();
    const abort = () => cancel.abort();
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) abort();
    return new Promise((settle) => {
      const work: Work = {
        ownedWork,
        command,
        steps,
        end: performance.now() + INPUT_BUDGET_MS,
        cancel,
        settle,
        dispose: () => {
          signal?.removeEventListener('abort', abort);
          if (ownedWork) settleOwnedInputWork(ownedWork, work);
        },
      };
      if (ownedWork !== undefined && !consumeOwnedInputWork(ownedWork, command, work)) {
        signal?.removeEventListener('abort', abort);
        settle(this.result(command, 'rejected', 'policyRefused'));
        return;
      }
      this.pending.push(work);
      observeOriginalQueueAdmission(command);
      this.pump();
    });
  }

  submitSemantic(token: OwnedSemanticInputWork, signal?: AbortSignal): Promise<InputResult> {
    const identity = {};
    const retained = consumeSemanticInputWork(token, identity);
    const command: InputCommand = {
      kind: 'input',
      requestId: retained.requestId,
      binding: retained.binding,
      steps: [],
    };
    const refused = this.refusal(command.binding);
    if (refused || this.pending.length + (this.active ? 1 : 0) >= 64) {
      settleSemanticInputWork(token, identity);
      return Promise.resolve(this.result(command, 'rejected', refused ?? 'policyRefused'));
    }
    const cancel = new AbortController();
    const abort = () => cancel.abort();
    let remove: ((type: string, callback: () => void) => void) | undefined;
    // Reserve whole Work before original signal getters or listener acquisition can reenter retirement.
    return new Promise((settle, reject) => {
      const work: Work = {
        semanticWork: token,
        semanticReject: reject,
        command,
        steps: [],
        end: performance.now() + INPUT_BUDGET_MS,
        cancel,
        settle,
        dispose: () => {
          try {
            remove?.('abort', abort);
          } finally {
            settleSemanticInputWork(token, identity);
          }
        },
      };
      semanticOwners.set(work, identity);
      this.pending.push(work);
      try {
        remove = signal?.removeEventListener.bind(signal);
        const add = signal?.addEventListener.bind(signal);
        if (this.pending.includes(work)) {
          add?.('abort', abort, { once: true });
          if (signal?.aborted) abort();
        }
      } catch (value) {
        const index = this.pending.indexOf(work);
        if (index >= 0) this.pending.splice(index, 1);
        this.ports.cleanup.requestRetirement('engineFault');
        try {
          work.dispose();
        } catch {
          /* The entered acquisition remains the first cause. */
        }
        reject(value);
      }
      this.pump();
    });
  }

  stop(): void {
    if (this.stopped) return;
    this.stopped = true;
    this.barrier = true;
    this.active?.cancel.abort();
    this.rejectPending('stopped');
    this.unregister?.();
    this.unregister = null;
  }

  reset(): Promise<ResetResult> {
    if (this.retired || !this.ports.cleanup.ordinary())
      return Promise.resolve(Object.freeze({ binding: this.initial, status: 'stopped' }));
    if (this.resetPromise) return this.resetPromise;
    let complete!: (result: ResetResult) => void;
    const operation = new Promise<ResetResult>((resolve) => {
      complete = resolve;
    });
    // External registry/native callbacks can reenter; publish the shared barrier first.
    this.resetPromise = operation;
    this.barrier = true;
    this.rejectPending('staleBinding');
    void operation.then(() => {
      if (this.resetPromise === operation) {
        this.resetPromise = null;
        if (!this.retired && this.ports.cleanup.ordinary()) {
          if (this.resetLedger) this.ports.cleanup.releaseLedger(this.resetLedger);
          this.resetLedger = null;
          this.resetEnd = undefined;
          this.resetBinding = null;
        }
      }
    });
    const failed = () => {
      if (!this.retired) this.ports.cleanup.requestRetirement('cleanupFailure');
      complete(Object.freeze({ binding: this.initial, status: 'stopped' }));
    };
    try {
      void this.beginReset().then(complete, failed);
    } catch {
      failed();
    }
    return operation;
  }

  private beginReset(): Promise<ResetResult> {
    const observed = this.readBinding();
    const current = observed ?? this.initial;
    if (!observed || this.stopped || !this.identityMatches(current)) {
      if (!this.retired) this.ports.cleanup.requestRetirement('cleanupFailure');
      return Promise.resolve(
        Object.freeze({
          binding: Object.freeze({ ...current }),
          status: 'stopped',
        })
      );
    }
    let next: BrowserBinding;
    try {
      const entry = performance.now();
      if (!Number.isFinite(entry) || entry < 0 || !this.ports.cleanup.ordinary())
        throw new Error('INPUT_RESET_CLOCK_UNAVAILABLE');
      this.resetEnd = entry + INPUT_BUDGET_MS;
      this.resetLedger = this.held.prepare(this.resetEnd);
      if (!this.ports.cleanup.registerLedger(this.resetLedger))
        throw new Error('INPUT_RESET_LEDGER_UNAVAILABLE');
      next = Object.freeze({
        ...current,
        epoch: advanceCounter(current.epoch),
        inputGeneration: advanceCounter(current.inputGeneration),
      });
      this.resetBinding = next;
      const publish = this.ports.publishResetBinding;
      if (
        !this.ports.cleanup.ordinary() ||
        this.retired ||
        !sameBinding(this.readBinding(), current) ||
        !this.ports.cleanup.ordinary()
      )
        throw new Error('INPUT_RESET_TARGET_REFUSED');
      Reflect.apply(publish, this.ports, [next]);
    } catch {
      if (!this.retired) this.ports.cleanup.requestRetirement('cleanupFailure');
      return Promise.resolve(
        Object.freeze({
          binding: Object.freeze({ ...current }),
          status: 'stopped',
        })
      );
    }
    this.active?.cancel.abort();
    return this.resetHeld(next, this.resetEnd!, this.resetLedger!);
  }

  private readBinding(): BrowserBinding | null {
    try {
      return this.ports.readBinding();
    } catch {
      this.ports.cleanup.requestRetirement('cleanupFailure');
      return null;
    }
  }

  private identityMatches(binding: BrowserBinding): boolean {
    return (
      binding.browserId === this.initial.browserId &&
      binding.browserGeneration === this.initial.browserGeneration &&
      binding.tabId === this.initial.tabId
    );
  }

  private refusal(binding: BrowserBinding): InputReason | null {
    if (
      this.stopped ||
      this.retired ||
      !this.ports.cleanup.ordinary() ||
      !this.ports.stopGate.accepts(binding)
    )
      return 'stopped';
    if (this.barrier || !this.identityMatches(binding)) return 'staleBinding';
    const observed = this.readBinding();
    // Registry observation can synchronously stop or reset admission before returning.
    if (
      this.stopped ||
      this.retired ||
      !this.ports.cleanup.ordinary() ||
      !this.ports.stopGate.accepts(binding)
    )
      return 'stopped';
    if (this.barrier || !sameBinding(observed, binding)) return 'staleBinding';
    return null;
  }

  private result(
    command: InputCommand,
    outcome: InputResult['outcome'],
    reason?: InputReason
  ): InputResult {
    return Object.freeze({
      kind: 'action',
      requestId: command.requestId,
      binding: command.binding,
      outcome,
      ...(reason ? { reason } : {}),
    }) as InputResult;
  }

  private rejectPending(reason: InputReason): void {
    for (const work of this.pending.splice(0)) {
      work.dispose();
      work.settle(this.result(work.command, 'rejected', reason));
    }
  }

  private pump(): void {
    if (this.active || this.barrier || this.stopped) return;
    const work = this.pending.shift();
    if (!work) return;
    this.active = work;
    void this.execute(work).then(
      (result) => {
        try {
          work.dispose();
        } catch (value) {
          this.active = null;
          this.ports.cleanup.requestRetirement('engineFault');
          if (work.semanticReject) work.semanticReject(value);
          else work.settle(this.result(work.command, 'uncertain', 'dispatchFailed'));
          this.pump();
          return;
        }
        this.active = null;
        // A rejected queued release can strand state from an earlier successful operation.
        if (this.needsReset(work, result) && !this.barrier && !this.stopped) void this.reset();
        work.settle(result);
        this.pump();
      },
      (value) => {
        try {
          work.dispose();
        } catch {
          /* The original operation remains the first cause. */
        }
        this.active = null;
        this.ports.cleanup.requestRetirement('engineFault');
        if (work.semanticReject) work.semanticReject(value);
        else work.settle(this.result(work.command, 'uncertain', 'dispatchFailed'));
        this.pump();
      }
    );
  }

  private needsReset(work: Work, result: InputResult): boolean {
    if (result.outcome === 'aborted') return true;
    return (
      result.outcome === 'rejected' &&
      this.held.hasHeld() &&
      work.steps.some(
        (step) =>
          step.kind === 'keyUp' ||
          step.kind === 'mouseUp' ||
          step.kind === 'compositionCommit' ||
          (step.kind === 'composition' && step.text.length === 0)
      )
    );
  }

  private async authorize(
    work: Work,
    step: NativeInputStep
  ): Promise<'allowed' | 'refused' | 'unknown'> {
    const allowed = await this.ports.authorize(work.command.binding, step, work.cancel.signal);
    if (allowed !== 'allowed' || !work.ownedWork) return allowed;
    return authorizeOwnedInputWork(
      work.ownedWork,
      work,
      work.command.binding,
      step,
      work.cancel.signal
    );
  }

  private async execute(work: Work): Promise<InputResult> {
    if (work.semanticWork) return this.executeSemantic(work);
    let completed = 0;
    for (const step of work.steps) {
      const reason = this.refusal(work.command.binding);
      if (reason || work.cancel.signal.aborted || performance.now() >= work.end)
        return this.result(work.command, completed ? 'aborted' : 'rejected', reason ?? 'deadline');
      let allowed: 'allowed' | 'refused' | 'unknown';
      try {
        allowed = await within(this.authorize(work, step), work.end, work.cancel.signal);
      } catch {
        return this.result(work.command, completed ? 'aborted' : 'rejected', 'policyRefused');
      }
      const afterAuthorization = this.refusal(work.command.binding);
      if (afterAuthorization || allowed !== 'allowed' || work.cancel.signal.aborted)
        return this.result(
          work.command,
          completed ? 'aborted' : 'rejected',
          afterAuthorization ?? 'policyRefused'
        );
      // Capture fallible port properties before attributing any native effect to this work.
      let transport: NativeInputTransport;
      let dispatch: NativeInputTransport['dispatch'];
      try {
        transport = this.ports.native;
        dispatch = transport.dispatch;
      } catch {
        return this.result(work.command, completed ? 'aborted' : 'rejected', 'dispatchFailed');
      }
      const beforeDispatch = this.refusal(work.command.binding);
      if (beforeDispatch || work.cancel.signal.aborted || performance.now() >= work.end)
        return this.result(
          work.command,
          completed ? 'aborted' : 'rejected',
          beforeDispatch ?? 'deadline'
        );
      if (work.ownedWork && !ownedInputWorkCurrent(work.ownedWork, work))
        return this.result(work.command, completed ? 'aborted' : 'rejected', 'policyRefused');
      this.held.track(step);
      try {
        const originalWork = work.ownedWork;
        const native = this.dispatchNative(
          step,
          work.cancel.signal,
          transport,
          dispatch,
          originalWork
            ? () => !work.cancel.signal.aborted && ownedInputWorkCurrent(originalWork, work)
            : undefined
        );
        await within(native, work.end, work.cancel.signal);
      } catch (error) {
        // A cancelled/failed started call may already have changed native state.
        if (!this.barrier) this.ports.cleanup.requestRetirement('engineFault');
        return this.result(
          work.command,
          'uncertain',
          error instanceof InputDeadline ? 'deadline' : 'dispatchFailed'
        );
      }
      completed++;
      // Exact transport ACK may settle existing custody during retirement, never successor IO.
      this.held.settled(step);
      const afterDispatch = this.refusal(work.command.binding);
      if (afterDispatch || work.cancel.signal.aborted)
        return this.result(work.command, 'aborted', afterDispatch ?? 'deadline');
      try {
        const approved = await within(this.authorize(work, step), work.end, work.cancel.signal);
        const stale = this.refusal(work.command.binding);
        if (stale || approved !== 'allowed')
          return this.result(work.command, 'aborted', stale ?? 'policyRefused');
      } catch {
        return this.result(work.command, 'aborted', 'policyRefused');
      }
    }
    return this.result(work.command, 'completed');
  }

  private async executeSemantic(work: Work): Promise<InputResult> {
    const token = work.semanticWork;
    const owner = semanticOwners.get(work);
    if (!token || !owner) return this.result(work.command, 'rejected', 'policyRefused');
    const check = () => {
      if (
        work.cancel.signal.aborted ||
        performance.now() >= work.end ||
        !semanticInputCurrent(token, owner)
      )
        throw new Error('SEMANTIC_WORK_REVOKED');
      // Fallible authority producer ran above; only the current original queue/binding fence follows.
      if (this.refusal(work.command.binding)) throw new Error('SEMANTIC_BINDING_REFUSED');
    };
    try {
      check();
    } catch {
      return this.result(work.command, 'rejected', 'policyRefused');
    }
    let done!: () => void, rejected!: (value: unknown) => void;
    const original = new Promise<void>((resolve, reject) => {
      done = resolve;
      rejected = reject;
    });
    this.nativePending = original;
    void original.then(
      () => this.clearNative(original),
      () => this.clearNative(original)
    );
    try {
      Promise.resolve(
        executeSemanticInputWork(token, owner, work.cancel.signal, check, async (step) => {
          check();
          const allowed = await this.ports.authorize(
            work.command.binding,
            step,
            work.cancel.signal
          );
          check();
          if (allowed !== 'allowed') throw new Error('SEMANTIC_POLICY_REFUSED');
          const transport = this.ports.native;
          const dispatch = transport.dispatch;
          check();
          this.held.track(step);
          // The whole semantic original remains nativePending through all CDP/read/key steps.
          await Reflect.apply(dispatch, transport, [
            step,
            work.cancel.signal,
            () => {
              check();
              return true;
            },
          ]);
          this.held.settled(step);
          check();
        })
      ).then(done, rejected);
    } catch (value) {
      rejected(value);
    }
    try {
      await within(original, work.end, work.cancel.signal);
      check();
      return this.result(work.command, 'completed');
    } catch (value) {
      if (!this.barrier) this.ports.cleanup.requestRetirement('engineFault');
      return this.result(
        work.command,
        'uncertain',
        value instanceof InputDeadline ? 'deadline' : 'dispatchFailed'
      );
    }
  }

  private dispatchNative(
    step: NativeInputStep,
    signal: AbortSignal,
    transport: NativeInputTransport,
    dispatch: NativeInputTransport['dispatch'],
    current?: () => boolean
  ): Promise<void> {
    let acknowledge!: () => void;
    let refuse!: (error: unknown) => void;
    const native = new Promise<void>((resolve, reject) => {
      acknowledge = resolve;
      refuse = reject;
    });
    // A started operation must already be attributable when the native port reenters reset.
    this.nativePending = native;
    void native.then(
      () => this.clearNative(native),
      () => this.clearNative(native)
    );
    try {
      void Promise.resolve(
        Reflect.apply(dispatch, transport, current ? [step, signal, current] : [step, signal])
      ).then(acknowledge, refuse);
    } catch (error) {
      refuse(error);
    }
    return native;
  }

  private clearNative(native: Promise<void>): void {
    if (this.nativePending === native) this.nativePending = null;
  }

  private cleanupCurrent(binding: BrowserBinding): boolean {
    try {
      const current = this.retired ? this.ports.cleanup.binding() : this.readBinding();
      const phase = this.retired ? this.ports.cleanup.retiring() : this.ports.cleanup.ordinary();
      return (
        !this.stopped &&
        phase &&
        this.ports.stopGate.accepts(binding) &&
        sameBinding(current, binding) &&
        (this.retired ? this.ports.cleanup.retiring() : this.ports.cleanup.ordinary())
      );
    } catch {
      return false;
    }
  }

  /** Install the permanent ordinary barrier/shared observation before any route or clock getter. */
  retire(parentEnd: number): Promise<CleanupObservation> {
    if (this.retirement) return this.retirement;
    let complete!: (value: CleanupObservation) => void;
    this.retirement = new Promise((done) => {
      complete = done;
    });
    this.retired = true;
    this.barrier = true;
    this.rejectPending('staleBinding');
    this.active?.cancel.abort();
    try {
      const binding = this.ports.cleanup.binding();
      const end = Math.min(parentEnd, this.resetEnd ?? parentEnd);
      if (
        !binding ||
        !Number.isFinite(end) ||
        end < 0 ||
        !this.ports.cleanup.retiring() ||
        !this.cleanupCurrent(binding)
      ) {
        complete(
          Object.freeze({
            state: 'unverified',
            binding: null,
            reason: 'permitUnavailable',
            pending: true,
            uncertainty: true,
          })
        );
      } else {
        const ledger = this.resetLedger ?? this.held.prepare(end);
        this.resetLedger = ledger;
        this.resetBinding = Object.freeze({ ...binding });
        this.permit = this.ports.cleanup.permit(this.resetBinding, end);
        if (!this.permit || !this.ports.cleanup.registerLedger(ledger)) {
          complete(
            Object.freeze({
              state: 'unverified',
              binding: this.resetBinding,
              reason: 'permitUnavailable',
              pending: true,
              uncertainty: true,
            })
          );
        } else {
          void this.drainRelease(this.resetBinding, end, ledger).then(
            (known) => {
              const pending =
                this.nativePending !== null || ledger.attempts.some((attempt) => attempt.pending);
              const exact = this.cleanupCurrent(this.resetBinding!);
              if (known && exact && !pending && !this.drainUncertain && !ledger.uncertain)
                complete(
                  Object.freeze({
                    state: 'settled',
                    binding: this.resetBinding!,
                    drain: 'acknowledged',
                    release: 'acknowledged',
                    pending: false,
                    uncertainty: false,
                  })
                );
              else
                complete(
                  Object.freeze({
                    state: 'unverified',
                    binding: this.resetBinding!,
                    reason: exact
                      ? pending
                        ? 'custodyPending'
                        : 'releaseTimeout'
                      : 'targetChanged',
                    pending,
                    uncertainty: true,
                  })
                );
            },
            () =>
              complete(
                Object.freeze({
                  state: 'unverified',
                  binding: this.resetBinding!,
                  reason: 'observationUnavailable',
                  pending: true,
                  uncertainty: true,
                })
              )
          );
        }
      }
    } catch {
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

  /** The operation slot exists before method capture; an entered attempt is never replayed. */
  private dispatchRelease(attempt: CleanupAttempt, signal: AbortSignal): Promise<void> {
    if (attempt.operation) return attempt.operation;
    let acknowledge!: () => void, refuse!: (error: unknown) => void;
    const shared = new Promise<void>((done, failed) => {
      acknowledge = done;
      refuse = failed;
    });
    attempt.operation = shared;
    attempt.pending = true;
    try {
      const native = this.ports.native;
      const cleanup = this.retired;
      let enter: () => Promise<void>;
      if (cleanup) {
        const call = native.cleanup;
        enter = () => Reflect.apply(call, native, [this.permit!, attempt, signal]);
      } else if (attempt.step.kind === 'cancelComposition') {
        const call = native.cancelComposition;
        enter = () => Reflect.apply(call, native, [signal]);
      } else if (attempt.step.kind === 'cancelDrag') {
        const call = native.cancelDrag;
        enter = () => Reflect.apply(call, native, [signal]);
      } else {
        const call = native.dispatch;
        enter = () => Reflect.apply(call, native, [attempt.step, signal]);
      }
      if (
        !this.resetBinding ||
        !this.cleanupCurrent(this.resetBinding) ||
        signal.aborted ||
        cleanup !== this.retired ||
        (cleanup && !this.permit)
      )
        throw new Error('INPUT_RELEASE_TARGET_REFUSED');
      if (!cleanup) attempt.entered = true;
      void enter().then(acknowledge, refuse);
    } catch (error) {
      refuse(error);
    }
    return shared;
  }

  private async drainRelease(
    binding: BrowserBinding,
    end: number,
    ledger: ReleaseLedger
  ): Promise<boolean> {
    const native = this.nativePending;
    if (native) {
      try {
        await within(native, end - INPUT_BUDGET_MS / 2);
      } catch {
        this.drainUncertain = true;
      }
    }
    const cancel = new AbortController();
    try {
      const release = this.held.release(ledger, {
        register: (value) => this.ports.cleanup.registerLedger(value),
        permits: () => this.cleanupCurrent(binding),
        enter: (attempt) => this.dispatchRelease(attempt, cancel.signal),
      });
      const acknowledged = await within(release, end);
      return acknowledged && !this.drainUncertain && this.cleanupCurrent(binding);
    } catch {
      ledger.uncertain = true;
      return false;
    } finally {
      cancel.abort();
    }
  }

  private async resetHeld(
    binding: BrowserBinding,
    end: number,
    ledger: ReleaseLedger
  ): Promise<ResetResult> {
    const acknowledged = await this.drainRelease(binding, end, ledger);
    const ready =
      acknowledged &&
      !this.retired &&
      this.ports.cleanup.ordinary() &&
      this.cleanupCurrent(binding);
    if (ready) {
      this.held.clear();
      this.barrier = false;
      this.pump();
    } else if (!this.retired) this.ports.cleanup.requestRetirement('cleanupFailure');
    return Object.freeze({ binding, status: ready ? 'ready' : 'stopped' });
  }
}
