import { parseBrowserCommand, type BrowserBinding, type BrowserCommand } from '../contracts.js';
import { advanceCounter } from '../counters.js';
import { BrowserValidationError } from '../errors.js';
import { sameBinding } from './binding.js';
import { INPUT_BUDGET_MS, InputDeadline, within } from './budget.js';
import { expandInput } from './expand.js';
import { HeldInput } from './held.js';
import type {
  InputPorts,
  InputReason,
  InputResult,
  NativeInputStep,
  ResetResult,
  TabInput,
} from './types.js';

type InputCommand = Extract<BrowserCommand, { kind: 'input' }>;
type Work = {
  command: InputCommand;
  steps: readonly NativeInputStep[];
  end: number;
  cancel: AbortController;
  settle(result: InputResult): void;
  dispose(): void;
};

/** One native queue per canonical tab; failed barriers stop its whole browser admission gate. */
export function createTabInput(ports: InputPorts): TabInput {
  const queue = new InputQueue(ports);
  return Object.freeze({
    submit: (command: unknown, signal?: AbortSignal) => queue.submit(command, signal),
    reset: () => queue.reset(),
    stop: () => ports.stopGate.stop(),
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
  private unregister: (() => void) | null;

  constructor(private readonly ports: InputPorts) {
    const initial = ports.readBinding();
    if (!initial) throw new BrowserValidationError('INVALID_COMMAND');
    this.initial = Object.freeze({ ...initial });
    this.unregister = ports.stopGate.register(this.initial, () => this.stop());
    if (!this.unregister) this.stopped = true;
  }

  submit(value: unknown, signal?: AbortSignal): Promise<InputResult> {
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
      this.pending.push({
        command,
        steps,
        end: performance.now() + INPUT_BUDGET_MS,
        cancel,
        settle,
        dispose: () => signal?.removeEventListener('abort', abort),
      });
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
    if (this.resetPromise) return this.resetPromise;
    const observed = this.readBinding();
    const current = observed ?? this.initial;
    if (!observed || this.stopped || !this.identityMatches(current)) {
      this.ports.stopGate.stop();
      return Promise.resolve(
        Object.freeze({ binding: Object.freeze({ ...current }), status: 'stopped' })
      );
    }
    this.barrier = true;
    this.rejectPending('staleBinding');
    let next: BrowserBinding;
    try {
      next = Object.freeze({
        ...current,
        epoch: advanceCounter(current.epoch),
        inputGeneration: advanceCounter(current.inputGeneration),
      });
      this.ports.publishResetBinding(next);
    } catch {
      this.ports.stopGate.stop();
      return Promise.resolve(
        Object.freeze({ binding: Object.freeze({ ...current }), status: 'stopped' })
      );
    }
    this.active?.cancel.abort();
    const end = performance.now() + INPUT_BUDGET_MS;
    const operation = this.resetHeld(next, end);
    this.resetPromise = operation;
    void operation.then(() => {
      this.resetPromise = null;
    });
    return operation;
  }

  private readBinding(): BrowserBinding | null {
    try {
      return this.ports.readBinding();
    } catch {
      this.ports.stopGate.stop();
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
    if (this.stopped || !this.ports.stopGate.accepts(binding)) return 'stopped';
    if (this.barrier || !this.identityMatches(binding) || !sameBinding(this.readBinding(), binding))
      return 'staleBinding';
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
    void this.execute(work).then((result) => {
      work.dispose();
      this.active = null;
      // A rejected queued release can strand state from an earlier successful operation.
      if (this.needsReset(work, result) && !this.barrier && !this.stopped) void this.reset();
      work.settle(result);
      this.pump();
    });
  }

  private needsReset(work: Work, result: InputResult): boolean {
    if (result.outcome === 'aborted') return true;
    return (
      result.outcome === 'rejected' &&
      this.held.hasHeld() &&
      work.steps.some((step) => step.kind === 'keyUp' || step.kind === 'mouseUp')
    );
  }

  private async execute(work: Work): Promise<InputResult> {
    let completed = 0;
    for (const step of work.steps) {
      const reason = this.refusal(work.command.binding);
      if (reason || work.cancel.signal.aborted || performance.now() >= work.end)
        return this.result(work.command, completed ? 'aborted' : 'rejected', reason ?? 'deadline');
      let allowed: 'allowed' | 'refused' | 'unknown';
      try {
        allowed = await within(
          Promise.resolve(this.ports.authorize(work.command.binding, step, work.cancel.signal)),
          work.end,
          work.cancel.signal
        );
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
      this.held.track(step);
      try {
        const native = Promise.resolve(this.ports.native.dispatch(step, work.cancel.signal));
        this.nativePending = native;
        void native.then(
          () => this.clearNative(native),
          () => this.clearNative(native)
        );
        await within(native, work.end, work.cancel.signal);
      } catch (error) {
        // A cancelled/failed started call may already have changed native state.
        if (!this.barrier) this.ports.stopGate.stop();
        return this.result(
          work.command,
          'uncertain',
          error instanceof InputDeadline ? 'deadline' : 'dispatchFailed'
        );
      }
      completed++;
      const afterDispatch = this.refusal(work.command.binding);
      if (afterDispatch || work.cancel.signal.aborted)
        return this.result(work.command, 'aborted', afterDispatch ?? 'deadline');
      this.held.settled(step);
      try {
        const approved = await within(
          Promise.resolve(this.ports.authorize(work.command.binding, step, work.cancel.signal)),
          work.end,
          work.cancel.signal
        );
        const stale = this.refusal(work.command.binding);
        if (stale || approved !== 'allowed')
          return this.result(work.command, 'aborted', stale ?? 'policyRefused');
      } catch {
        return this.result(work.command, 'aborted', 'policyRefused');
      }
    }
    return this.result(work.command, 'completed');
  }

  private clearNative(native: Promise<void>): void {
    if (this.nativePending === native) this.nativePending = null;
  }

  private cleanupCurrent(binding: BrowserBinding): boolean {
    try {
      const current = this.readBinding();
      if (!this.stopped && this.ports.stopGate.accepts(binding) && sameBinding(current, binding))
        return true;
    } catch {
      // An uncertain current target cannot authorize a release onto another lifetime.
    }
    this.ports.stopGate.stop();
    return false;
  }

  private async resetHeld(binding: BrowserBinding, end: number): Promise<ResetResult> {
    let drained = true;
    const native = this.nativePending;
    if (native) {
      try {
        // Reserve half the single budget so a hung call cannot prevent all release attempts.
        await within(native, end - INPUT_BUDGET_MS / 2);
      } catch {
        drained = false;
      }
    }
    // Draining can outlive this target; never release held state onto a replacement lifetime.
    if (!this.cleanupCurrent(binding)) return Object.freeze({ binding, status: 'stopped' });
    const cancel = new AbortController();
    const released = await this.held.release(this.ports.native, end, cancel.signal, () =>
      this.cleanupCurrent(binding)
    );
    cancel.abort();
    const ready = drained && released && this.cleanupCurrent(binding);
    if (!ready) this.ports.stopGate.stop();
    else {
      this.held.clear();
      this.barrier = false;
      this.pump();
    }
    return Object.freeze({ binding, status: ready ? 'ready' : 'stopped' });
  }
}
