// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import { createTextareaSurface } from '../ui/textarea-surface';
import {
  LADDER_SCENARIOS,
  runLadderConformance,
  type LadderScenario,
  type MountedSurface,
} from './editing-surface-conformance';

/**
 * Stub `document.execCommand('insertText')` — jsdom has no editing pipeline.
 * Splices the text into the focused field the way a browser would, which is
 * what makes the adapter's edits observable at all.
 *
 * @returns Undo the stub.
 */
function stubExecCommand(): () => void {
  const previous = Object.getOwnPropertyDescriptor(document, 'execCommand');
  Object.defineProperty(document, 'execCommand', {
    writable: true,
    configurable: true,
    value: vi.fn((command: string, _showUi?: boolean, text?: string) => {
      if (command !== 'insertText') return false;
      const el = document.activeElement as HTMLTextAreaElement | null;
      if (!el) return false;
      const start = el.selectionStart ?? 0;
      const end = el.selectionEnd ?? 0;
      const inserted = text ?? '';
      el.value = el.value.slice(0, start) + inserted + el.value.slice(end);
      const caret = start + inserted.length;
      el.setSelectionRange(caret, caret);
      return true;
    }),
  });
  return () => {
    if (previous) Object.defineProperty(document, 'execCommand', previous);
    else Reflect.deleteProperty(document, 'execCommand');
  };
}

/** Bring up a real `<textarea>` in the document with its adapter around it. */
async function mountTextareaSurface(): Promise<MountedSurface> {
  const el = document.createElement('textarea');
  document.body.appendChild(el);
  const restoreExecCommand = stubExecCommand();

  return {
    surface: createTextareaSurface({ current: el }),
    setContent(text, caret, anchor) {
      el.value = text;
      el.focus();
      const start = anchor === undefined ? caret : Math.min(caret, anchor);
      const end = anchor === undefined ? caret : Math.max(caret, anchor);
      el.setSelectionRange(start, end);
    },
    getText: () => el.value,
    // Deliberately no `setComposing`: a textarea has no editor-level composition
    // state, and the adapter's constant `false` is the contract the conformance
    // runner asserts in its place.
    cleanup() {
      restoreExecCommand();
      el.remove();
    },
  };
}

runLadderConformance('textarea', mountTextareaSurface);

/**
 * Guards on the table itself, which every adapter inherits. They live here
 * rather than inside the runner so they are asserted once, not once per
 * adapter.
 */
describe('the ladder scenario table', () => {
  it('names every scenario exactly once', () => {
    const names = LADDER_SCENARIOS.map((scenario) => scenario.name);
    expect(new Set(names).size).toBe(names.length);
  });

  // `defaultPrevented` alone says only that the ladder consumed the key, never
  // what it decided — a scenario that asserts nothing else is decoration.
  it('makes every scenario assert an outcome, not just that the key was eaten', () => {
    const assertsOnlyConsumption = (scenario: LadderScenario) =>
      scenario.expect.calls === undefined &&
      scenario.expect.notCalls === undefined &&
      scenario.expect.text === undefined;

    expect(LADDER_SCENARIOS.filter(assertsOnlyConsumption).map((s) => s.name)).toEqual([]);
  });
});
