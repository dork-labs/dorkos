import type { BrowserInputStep } from '../contracts.js';
import type { NativeInputStep } from './types.js';

/** Enforce limits on expanded native effects, not merely composite request count. */
export function expandInput(steps: readonly BrowserInputStep[]): readonly NativeInputStep[] | null {
  const expanded: NativeInputStep[] = [];
  let textBytes = 0;
  for (const step of steps) {
    if (step.kind === 'text' || step.kind === 'composition' || step.kind === 'compositionCommit')
      textBytes += Buffer.byteLength(step.text);
    if (step.kind === 'click') {
      expanded.push(
        { kind: 'mouseMove', x: step.x, y: step.y },
        { kind: 'mouseDown', button: step.button },
        { kind: 'mouseUp', button: step.button }
      );
    } else expanded.push(step);
    if (expanded.length > 16 || textBytes > 2048) return null;
  }
  return Object.freeze(expanded.map((step) => Object.freeze({ ...step })));
}
