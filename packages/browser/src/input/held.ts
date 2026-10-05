import type { NativeInputStep, CleanupInputStep } from './types.js';
import type { CleanupAttempt } from '../lifecycle/ownership.js';
import { within } from './budget.js';

type Button = Extract<NativeInputStep, { kind: 'mouseDown' }>['button'];
export interface ReleaseLedger {
  readonly identity: object;
  readonly end: number;
  readonly attempts: CleanupAttempt[];
  captured: boolean;
  readonly promise: Promise<boolean>;
  readonly complete: (acknowledged: boolean) => void;
  started: boolean;
  finished: boolean;
  uncertain: boolean;
}
export interface ReleaseDriver {
  register(ledger: ReleaseLedger): boolean;
  permits(): boolean;
  enter(attempt: CleanupAttempt): Promise<void>;
}

/** Conservative native state is charged before entry and removed only on exact acknowledgement. */
export class HeldInput {
  private readonly keys = new Set<string>();
  private readonly buttons = new Set<Button>();

  track(step: NativeInputStep): void {
    if (step.kind === 'keyDown') this.keys.add(step.key);
    if (step.kind === 'mouseDown') this.buttons.add(step.button);
  }
  settled(step: NativeInputStep): void {
    if (step.kind === 'keyUp') this.keys.delete(step.key);
    if (step.kind === 'mouseUp') this.buttons.delete(step.button);
  }
  hasHeld(): boolean {
    return this.keys.size > 0 || this.buttons.size > 0;
  }
  clear(): void {
    this.keys.clear();
    this.buttons.clear();
  }

  /** Allocate one closed attempt set before observing a transport receiver/getter. */
  prepare(end: number): ReleaseLedger {
    let complete!: (acknowledged: boolean) => void;
    const promise = new Promise<boolean>((done) => {
      complete = done;
    });
    return {
      identity: Object.freeze({}),
      end,
      promise,
      complete,
      attempts: [],
      captured: false,
      started: false,
      finished: false,
      uncertain: false,
    };
  }

  /** Adopt the actual ledger: entered attempts are never replayed or given another deadline. */
  release(ledger: ReleaseLedger, driver: ReleaseDriver): Promise<boolean> {
    if (ledger.started) return ledger.promise;
    ledger.started = true;
    // Capture AFTER exact started-native drain, BEFORE the first release getter/entry.
    // An actual earlier up ACK removes its held key; it must not be replayed from a stale snapshot.
    const steps: CleanupInputStep[] = [
      ...[...this.buttons].map((button): CleanupInputStep => ({ kind: 'mouseUp', button })),
      ...[...this.keys].map((key): CleanupInputStep => ({
        kind: 'keyUp',
        key: key as Extract<NativeInputStep, { kind: 'keyUp' }>['key'],
      })),
      { kind: 'cancelComposition' },
      { kind: 'cancelDrag' },
    ];
    ledger.attempts.push(
      ...steps.map((step) => ({
        identity: Object.freeze({}),
        kind: step.kind,
        step: Object.freeze(step),
        operation: null,
        entered: false,
        pending: false,
        acknowledged: false,
        uncertain: false,
      }))
    );
    ledger.captured = true;
    if (!driver.register(ledger)) {
      ledger.uncertain = true;
      ledger.finished = true;
      ledger.complete(false);
      return ledger.promise;
    }
    const observations = ledger.attempts.map((attempt) => {
      try {
        if (!driver.permits()) throw new Error('INPUT_RELEASE_TARGET_REFUSED');
        // The captured driver preregisters entry before touching any native method/getter.
        const operation = driver.enter(attempt);
        attempt.operation = operation;
        void operation.then(
          () => {
            attempt.pending = false;
            attempt.acknowledged = true;
            const step = attempt.step;
            if (step.kind === 'keyUp' || step.kind === 'mouseUp') this.settled(step);
          },
          () => {
            attempt.pending = false;
            attempt.uncertain = true;
          }
        );
        return within(operation, ledger.end).catch((error: unknown) => {
          ledger.uncertain = true;
          attempt.uncertain = true;
          throw error;
        });
      } catch (error) {
        attempt.uncertain = true;
        ledger.uncertain = true;
        return Promise.reject(error);
      }
    });
    // All eligible calls entered above before this first wait on any peer.
    void Promise.allSettled(observations).then((results) => {
      ledger.finished = true;
      const acknowledged =
        !ledger.uncertain &&
        results.every((value) => value.status === 'fulfilled') &&
        ledger.attempts.every(
          (attempt) =>
            attempt.entered && attempt.acknowledged && !attempt.pending && !attempt.uncertain
        );
      ledger.complete(acknowledged);
    });
    return ledger.promise;
  }
}
