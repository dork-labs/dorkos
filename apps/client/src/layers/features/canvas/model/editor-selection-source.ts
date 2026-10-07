import type { MarkdownSourcePort } from 'blintz';
import type { CanvasChannelSelectionRequest } from '@dorkos/shared/canvas-channel-schemas';
import { hashCheckboxSource } from './native-checkbox-source';

type ConfirmedSource = Readonly<{ content: string; hash: string }>;
type SelectionSource = Pick<
  CanvasChannelSelectionRequest,
  'expectedFileHash' | 'sourceGeneration' | 'ranges' | 'selectedText'
>;

/** Capture untrusted context from the current mapped saved source, never rendered DOM text. */
export async function captureCurrentEditorSelection(
  port: MarkdownSourcePort,
  confirmed: ConfirmedSource
): Promise<SelectionSource> {
  const snapshot = port.snapshot();
  if (snapshot.kind !== 'mapped' || snapshot.value.text !== confirmed.content)
    throw new Error('Save or reload this selection before asking about it.');
  const sourceGeneration = snapshot.generation;
  const selected = port.selection(sourceGeneration);
  if (selected.kind !== 'mapped' || selected.generation !== sourceGeneration)
    throw new Error('Select text in the current saved document.');
  const ranges = selected.value.ranges.map(({ start, end }) => ({ start, end }));
  if (ranges.length === 0 || ranges.length > 32)
    throw new Error('Choose a smaller text selection.');
  let previousEnd = 0;
  for (const range of ranges) {
    if (
      !Number.isSafeInteger(range.start) ||
      !Number.isSafeInteger(range.end) ||
      range.start < previousEnd ||
      range.end <= range.start ||
      range.end > confirmed.content.length
    )
      throw new Error('This selection is not mapped to the saved source.');
    previousEnd = range.end;
  }
  const selectedText = ranges.map(({ start, end }) => confirmed.content.slice(start, end)).join('');
  if (new TextEncoder().encode(selectedText).byteLength > 8192)
    throw new Error('Choose a smaller text selection.');
  if ((await hashCheckboxSource(confirmed.content)) !== confirmed.hash)
    throw new Error('The saved file version changed. Reload before asking about it.');
  requireCurrentEditorSelection(port, confirmed, {
    expectedFileHash: confirmed.hash,
    sourceGeneration,
    ranges,
    selectedText,
  });
  return { expectedFileHash: confirmed.hash, sourceGeneration, ranges, selectedText };
}

/** Repeat the source and selection comparison after every preparation await. DATA is not authority. */
export function requireCurrentEditorSelection(
  port: MarkdownSourcePort,
  confirmed: ConfirmedSource,
  captured: SelectionSource
): void {
  const snapshot = port.snapshot();
  const selected = port.selection(captured.sourceGeneration);
  if (
    snapshot.kind !== 'mapped' ||
    snapshot.generation !== captured.sourceGeneration ||
    snapshot.value.text !== confirmed.content ||
    confirmed.hash !== captured.expectedFileHash ||
    selected.kind !== 'mapped' ||
    selected.generation !== captured.sourceGeneration ||
    selected.value.ranges.length !== captured.ranges.length ||
    selected.value.ranges.some(
      (range, index) =>
        range.start !== captured.ranges[index].start || range.end !== captured.ranges[index].end
    )
  )
    throw new Error('This selection changed before it could be recorded.');
}
