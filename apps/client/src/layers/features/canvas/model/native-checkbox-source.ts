import type { MarkdownSourcePort, SourceTaskToggleRequest } from 'blintz';

/** Hash exact UTF-8 source evidence, including BOM and excluding line terminators only for the line hash. */
export async function hashCheckboxSource(text: string): Promise<string> {
  if (!globalThis.crypto?.subtle)
    throw new Error('Native checkbox writes require a secure browser context.');
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return Array.from(new Uint8Array(digest), (value) => value.toString(16).padStart(2, '0')).join(
    ''
  );
}
/** Read an exact current mapped task without manufacturing source locations from serialized markdown. */
export function currentCheckboxSource(port: MarkdownSourcePort, request: SourceTaskToggleRequest) {
  const snapshot = port.snapshot();
  if (snapshot.kind !== 'mapped' || snapshot.generation !== request.generation)
    throw new Error('Reload this changed task before saving.');
  const text = snapshot.value.text,
    marker = request.task.marker;
  if (marker.end - marker.start !== 3 || !/^\[[ xX]\]$/.test(text.slice(marker.start, marker.end)))
    throw new Error('This task marker is not mapped.');
  let start = marker.start,
    end = marker.end;
  while (start > 0 && text[start - 1] !== '\n' && text[start - 1] !== '\r') start--;
  while (end < text.length && text[end] !== '\n' && text[end] !== '\r') end++;
  const confirmed =
    request.done === request.task.checked
      ? text
      : text.slice(0, marker.start + 1) + (request.done ? 'x' : ' ') + text.slice(marker.start + 2);
  return { text, lineText: text.slice(start, end), confirmed };
}
