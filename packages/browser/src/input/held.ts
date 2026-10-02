import type { NativeInputStep, NativeInputTransport } from './types.js';
import { within } from './budget.js';

type Button = Extract<NativeInputStep, { kind: 'mouseDown' }>['button'];

/** Conservative native state: update before calls because rejection can follow a real side effect. */
export class HeldInput {
  private readonly keys = new Set<string>();
  private readonly buttons = new Set<Button>();

  track(step: NativeInputStep): void {
    if (step.kind === 'keyDown') this.keys.add(step.key);
    if (step.kind === 'mouseDown') this.buttons.add(step.button);
    // An attempted up keeps uncertainty until its native acknowledgement at this exact binding.
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

  async release(
    native: NativeInputTransport,
    end: number,
    signal: AbortSignal,
    permits: () => boolean
  ): Promise<boolean> {
    const calls: (() => Promise<void>)[] = [
      ...[...this.buttons].map(
        (button) => () => native.dispatch({ kind: 'mouseUp', button }, signal)
      ),
      ...[...this.keys].map(
        (key) => () =>
          native.dispatch(
            { kind: 'keyUp', key: key as Extract<NativeInputStep, { kind: 'keyUp' }>['key'] },
            signal
          )
      ),
      () => native.cancelComposition(signal),
      () => native.cancelDrag(signal),
    ];
    // Validate each unstarted call; valid-target calls start without waiting on earlier failures/hangs.
    const attempts = calls.map((call) => {
      try {
        if (!permits()) return Promise.reject(new Error('INPUT_RELEASE_TARGET_REFUSED'));
        return within(Promise.resolve(call()), end);
      } catch {
        return Promise.reject(new Error('INPUT_RELEASE_FAILED'));
      }
    });
    const results = await Promise.allSettled(attempts);
    return results.every((result) => result.status === 'fulfilled');
  }
}
