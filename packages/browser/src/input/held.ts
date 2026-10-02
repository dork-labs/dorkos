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

  clear(): void {
    this.keys.clear();
    this.buttons.clear();
  }

  async release(native: NativeInputTransport, end: number, signal: AbortSignal): Promise<boolean> {
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
    // All calls start before awaiting any one rejection/hang; each shares one deadline.
    const attempts = calls.map((call) => {
      try {
        return within(Promise.resolve(call()), end);
      } catch {
        return Promise.reject(new Error('INPUT_RELEASE_FAILED'));
      }
    });
    const results = await Promise.allSettled(attempts);
    return results.every((result) => result.status === 'fulfilled');
  }
}
