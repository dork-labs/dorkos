import type { BrowserViewerDiagnosticStage } from '../stream/viewer-diagnostic.js';
/** Constructor-owned session selection uses stable birth identity before entering live custody.
 * Full tab/binding/grant checks remain with the selected original request handler. */
export function selectOriginalBrowserIdentity<
  T extends {
    identity(): Readonly<{ browserId: string; browserGeneration: number }> | undefined;
    current(): boolean;
  },
>(
  originals: Iterable<T>,
  binding: Readonly<{ browserId: string; browserGeneration: number }>,
  current: () => boolean,
  diagnostic?: Readonly<{
    note(stage: BrowserViewerDiagnosticStage): void;
    failure(stage: BrowserViewerDiagnosticStage, value: unknown): unknown;
  }>
): T | undefined {
  let stage: BrowserViewerDiagnosticStage = 'selection.mode-before';
  const refuse = (decision: BrowserViewerDiagnosticStage): undefined => {
    diagnostic?.note(decision);
    return undefined;
  };
  try {
    if (!current()) return refuse(stage);
    stage = 'selection.identity';
    const matches = [...originals].filter((original) => {
      const identity = original.identity();
      return (
        identity?.browserId === binding.browserId &&
        identity.browserGeneration === binding.browserGeneration
      );
    });
    if (matches.length === 0) return refuse('selection.absent');
    if (matches.length !== 1) return refuse('selection.multiple');
    stage = 'selection.mode-selected';
    if (!current()) return refuse(stage);
    const original = matches[0]!;
    stage = 'selection.current';
    if (!original.current()) return refuse(stage);
    stage = 'selection.mode-after';
    return current() ? original : refuse(stage);
  } catch (value) {
    diagnostic?.failure(stage, value);
    throw value;
  }
}
