/**
 * The stack clip's fallback boundary: where the frames begin when the message
 * cannot be found in the stack.
 *
 * @vitest-environment node
 */
import { describe, expect, it } from 'vitest';
import { clipFlattenedError } from '../serialize-error.js';

/** An Error whose `stack` is exactly `stack` and whose `message` is `message`. */
function errorWith(message: string, stack: string): Error {
  const err = new Error(message);
  err.stack = stack;
  return err;
}

describe('clipFlattenedError — the frames boundary without a message', () => {
  const longHeader = `Error: ${'y'.repeat(20_000)}`;
  const frame = '    at handler (/app/src/route.ts:10:5)';

  it('keeps the frames when it has to find them by shape', () => {
    // A message that does not appear in the stack (a rewritten message) sends
    // the clip to the `\n<whitespace>at ` fallback.
    const { stack } = clipFlattenedError(errorWith('not in the stack', `${longHeader}\n${frame}`));

    expect(stack).toContain('[truncated, ');
    expect(stack).toContain(`\n${frame}`);
  });

  it('starts the frames at the first newline of a blank-line run before them', () => {
    const { stack } = clipFlattenedError(errorWith('', `${longHeader}\n\n${frame}`));

    expect(stack?.endsWith(`characters total]\n\n${frame}`)).toBe(true);
  });

  it('does not treat `at` without leading whitespace as a frame', () => {
    const { stack } = clipFlattenedError(errorWith('', `${longHeader}\nat not-a-frame`));

    // No boundary found, so the stack is cut flat at the stack cap.
    expect(stack).not.toContain('not-a-frame');
  });

  it('stays linear on a stack that is a long run of newlines', () => {
    // `/\n\s+at /` backtracked quadratically here: `\s+` matches newlines, so
    // each of them opened a match that failed only at the end of the run
    // (CodeQL js/polynomial-redos). A stack is text a subprocess chose.
    const started = performance.now();
    const { stack } = clipFlattenedError(errorWith('', `x${'\n'.repeat(100_000)}`));

    expect(performance.now() - started).toBeLessThan(1_000);
    expect(stack).toContain('[truncated, 100001 characters total]');
  });
});
