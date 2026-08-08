// @vitest-environment jsdom
import { useState } from 'react';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import type { ComposerFieldHandle } from '../ComposerFieldProps';
import LexicalField from '../LexicalField';

beforeAll(() => {
  Object.defineProperty(window, 'matchMedia', {
    writable: true,
    value: vi.fn().mockImplementation((query: string) => ({
      matches: false,
      media: query,
      onchange: null,
      addListener: vi.fn(),
      removeListener: vi.fn(),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      dispatchEvent: vi.fn(),
    })),
  });
});

afterEach(() => cleanup());

/** The field inside a card that owns paste and drop, exactly as Root does. */
function CardAroundField({
  onPaste,
  onDrop,
  onValue,
  handleOut,
}: {
  onPaste?: (e: React.ClipboardEvent) => void;
  onDrop?: (e: React.DragEvent) => void;
  onValue?: (v: string) => void;
  handleOut?: (handle: ComposerFieldHandle | null) => void;
}) {
  const [value, setValue] = useState('');
  return (
    // Stands in for `Composer.Root`, which owns paste and drop on the card. The
    // real one gets these handlers from react-dropzone's `getRootProps()`, which
    // the rule cannot see through; here they are literal, so it fires. There is
    // nothing interactive to make accessible — this is a drop target in a test.
    // eslint-disable-next-line jsx-a11y/no-static-element-interactions
    <div onPaste={onPaste} onDrop={onDrop} data-testid="card">
      <LexicalField
        ref={handleOut}
        value={value}
        onChange={(next) => {
          setValue(next);
          onValue?.(next);
        }}
        onKeyDown={() => {}}
        onFocus={() => {}}
        onBlur={() => {}}
        placeholder="Send a message..."
        onSurfaceChange={() => {}}
      />
    </div>
  );
}

/** A `DataTransfer` stand-in — jsdom has no constructible one. */
function makeClipboard({
  html,
  text,
  files,
}: {
  html?: string;
  text?: string;
  files?: { kind: string }[];
}): DataTransfer {
  return {
    items: (files ?? []) as unknown as DataTransferItemList,
    files: { length: files?.length ?? 0 } as unknown as FileList,
    types: [
      ...(html ? ['text/html'] : []),
      ...(text ? ['text/plain'] : []),
      ...(files?.length ? ['Files'] : []),
    ],
    getData: (type: string) => (type === 'text/html' ? (html ?? '') : (text ?? '')),
  } as unknown as DataTransfer;
}

/** Dispatch a real paste event carrying `clipboardData`. */
function paste(field: HTMLElement, clipboardData: DataTransfer) {
  const event = new Event('paste', { bubbles: true, cancelable: true }) as Event & {
    clipboardData: DataTransfer;
  };
  Object.defineProperty(event, 'clipboardData', { value: clipboardData });
  field.dispatchEvent(event);
  return event;
}

/** Dispatch a real drop event carrying `dataTransfer`. */
function drop(field: HTMLElement, dataTransfer: DataTransfer) {
  const event = new Event('drop', { bubbles: true, cancelable: true });
  Object.defineProperty(event, 'dataTransfer', { value: dataTransfer });
  field.dispatchEvent(event);
  return event;
}

/** Render, wait for the field, and give it a caret to paste into. */
async function renderField(props: Parameters<typeof CardAroundField>[0] = {}) {
  let handle: ComposerFieldHandle | null = null;
  render(<CardAroundField {...props} handleOut={(h) => (handle = h)} />);
  const field = await screen.findByRole('combobox');
  await waitFor(() => expect(field.querySelector('p')).not.toBeNull());
  // A paste needs somewhere to land; without a caret the handler declines and
  // the test would be measuring the empty case by accident.
  await waitFor(() => (handle as unknown as ComposerFieldHandle).focusAt(0));
  return field;
}

describe('a paste carrying a file belongs to the card, not the editor', () => {
  it('leaves the document alone and reaches the card', async () => {
    const onPaste = vi.fn();
    const field = await renderField({ onPaste });
    const before = field.textContent;

    paste(field, makeClipboard({ files: [{ kind: 'file' }], html: '<b>ignored</b>' }));

    await waitFor(() => expect(onPaste).toHaveBeenCalled());
    expect(field.textContent).toBe(before);
  });
});

describe('a file-free HTML paste is converted through an inert document', () => {
  it('turns bold and a paragraph into the composer’s own nodes', async () => {
    const seen: string[] = [];
    const field = await renderField({ onValue: (v) => seen.push(v) });

    paste(field, makeClipboard({ html: '<b>bold</b><p>para</p>' }));

    await waitFor(() => expect(seen.at(-1)).toContain('**bold**'));
    expect(seen.at(-1)).toContain('para');
  });

  // Asserted on the document tree, not on a serialized string: the point is
  // that nothing executable was ever constructed, anywhere.
  it('cannot produce a script or an img from a hostile paste', async () => {
    const seen: string[] = [];
    const field = await renderField({ onValue: (v) => seen.push(v) });

    paste(field, makeClipboard({ html: '<script>alert(1)</script><img onerror="x" src="y">safe' }));

    await waitFor(() => expect(seen.at(-1)).toContain('safe'));
    expect(field.querySelector('script')).toBeNull();
    expect(field.querySelector('img')).toBeNull();
    expect(document.querySelector('script')).toBeNull();
    expect(seen.at(-1)).not.toContain('alert(1)');
  });

  it('keeps a link’s text and drops the link — links are not in the node set', async () => {
    const seen: string[] = [];
    const field = await renderField({ onValue: (v) => seen.push(v) });

    paste(field, makeClipboard({ html: '<a href="https://x.test">link</a>' }));

    await waitFor(() => expect(seen.at(-1)).toContain('link'));
    expect(field.querySelector('a')).toBeNull();
    expect(seen.at(-1)).not.toContain('https://x.test');
  });

  // ⌘⇧V and any clipboard with no text/html: our converter declines and
  // Lexical inserts the plain text itself. The requirement is that no
  // conversion ran, not that nobody consumed the event — Lexical consuming it
  // IS the plain-text path working.
  it('inserts a plain-text paste verbatim, with no conversion', async () => {
    const seen: string[] = [];
    const field = await renderField({ onValue: (v) => seen.push(v) });

    paste(field, makeClipboard({ text: 'a * b _ c' }));

    await waitFor(() => expect(seen.at(-1)).toBe('a * b _ c'));
    expect(field.querySelector('strong, b, em, i, code')).toBeNull();
  });
});

describe('a drop the card owns', () => {
  it('reaches the card when it carries a file-tree path', async () => {
    const onDrop = vi.fn();
    const field = await renderField({ onDrop });
    const before = field.textContent;

    drop(field, {
      types: ['application/x-dorkos-file-path'],
      files: { length: 0 },
      items: [],
      getData: () => 'src/index.ts',
    } as unknown as DataTransfer);

    await waitFor(() => expect(onDrop).toHaveBeenCalled());
    expect(field.textContent).toBe(before);
  });

  it('reaches the card when it carries files', async () => {
    const onDrop = vi.fn();
    const field = await renderField({ onDrop });

    drop(field, makeClipboard({ files: [{ kind: 'file' }] }));

    await waitFor(() => expect(onDrop).toHaveBeenCalled());
  });
});
