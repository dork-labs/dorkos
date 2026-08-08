// @vitest-environment jsdom
import { useRef, useState } from 'react';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
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

/** The field with a spy ladder, wired the way `ComposerInput` wires it. */
function Harness({
  initialValue = '',
  onKeyDown,
  isPaletteOpen,
  paletteHasResults,
  onValue,
  handleOut,
}: {
  initialValue?: string;
  handleOut?: (handle: ComposerFieldHandle | null) => void;
  onKeyDown: (e: React.KeyboardEvent) => void;
  isPaletteOpen?: boolean;
  paletteHasResults?: boolean;
  onValue?: (v: string) => void;
}) {
  const [value, setValue] = useState(initialValue);
  const ref = useRef<ComposerFieldHandle>(null);
  return (
    <LexicalField
      ref={(handle) => {
        ref.current = handle;
        handleOut?.(handle);
      }}
      value={value}
      onChange={(next) => {
        setValue(next);
        onValue?.(next);
      }}
      onKeyDown={onKeyDown}
      onFocus={() => {}}
      onBlur={() => {}}
      placeholder="Send a message..."
      isPaletteOpen={isPaletteOpen}
      paletteHasResults={paletteHasResults}
      onSurfaceChange={() => {}}
    />
  );
}

/**
 * Render the field, wait for it, and put a caret at the end of the document.
 *
 * Every rung below the palette reads the SELECTION, so a test that presses a key
 * without one is testing the empty case by accident.
 */
async function renderWithCaret(props: Parameters<typeof Harness>[0]) {
  let handle: ComposerFieldHandle | null = null;
  render(<Harness {...props} handleOut={(h) => (handle = h)} />);
  const field = await screen.findByRole('combobox');
  await waitFor(() => expect(handle).not.toBeNull());
  const caret = (props.initialValue ?? '').length;
  await waitFor(() => {
    (handle as unknown as ComposerFieldHandle).focusAt(caret);
  });
  return field;
}

/** Press a key on the editable and report whether the default was prevented. */
function press(field: HTMLElement, init: KeyboardEventInit & { key: string }) {
  const event = new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init });
  field.dispatchEvent(event);
  return event;
}

describe('the ladder, registered at critical priority', () => {
  // Without COMMAND_PRIORITY_CRITICAL, Lexical's own rich-text handler inserts
  // a paragraph on Enter before the ladder is ever consulted, and the message
  // never sends.
  it('is consulted on Enter before Lexical inserts anything', async () => {
    const onKeyDown = vi.fn((e: React.KeyboardEvent) => e.preventDefault());
    render(<Harness initialValue="hello" onKeyDown={onKeyDown} />);
    const field = await screen.findByRole('combobox');
    await waitFor(() => expect(field.textContent).toBe('hello'));

    press(field, { key: 'Enter' });

    expect(onKeyDown).toHaveBeenCalled();
    expect(field.textContent).toBe('hello');
  });

  it.each([['Escape'], ['ArrowUp'], ['ArrowDown'], ['Tab']])(
    'routes %s through the ladder too',
    async (key) => {
      const onKeyDown = vi.fn();
      render(<Harness initialValue="hello" onKeyDown={onKeyDown} />);
      const field = await screen.findByRole('combobox');

      press(field, { key });

      await waitFor(() => expect(onKeyDown).toHaveBeenCalled());
      expect(onKeyDown.mock.calls[0][0]).toMatchObject({ key });
    }
  );

  // The existing ladder marks a consumed Escape with preventDefault and
  // deliberately does NOT stopPropagation — an enclosing thread panel reads
  // defaultPrevented to decide whether the key was already spoken for.
  it('marks a consumed key on the ORIGINAL event and still lets it bubble', async () => {
    const onKeyDown = vi.fn((e: React.KeyboardEvent) => e.preventDefault());
    const ancestorSaw: boolean[] = [];
    render(
      <div onKeyDownCapture={() => {}}>
        <Harness initialValue="hello" onKeyDown={onKeyDown} />
      </div>
    );
    const field = await screen.findByRole('combobox');
    document.addEventListener('keydown', (e) => ancestorSaw.push(e.defaultPrevented));

    const event = press(field, { key: 'Escape' });

    expect(event.defaultPrevented).toBe(true);
    expect(ancestorSaw).toEqual([true]);
  });

  it('leaves a key the ladder declined for Lexical to handle', async () => {
    // A ladder that never calls preventDefault has consumed nothing, so Shift+
    // Enter must reach Lexical and insert a line break.
    const onKeyDown = vi.fn();
    const seen: string[] = [];
    const field = await renderWithCaret({
      initialValue: 'a',
      onKeyDown,
      onValue: (v) => seen.push(v),
    });

    fireEvent.keyDown(field, { key: 'Enter', shiftKey: true });

    await waitFor(() => expect(seen.at(-1)).toBe('a\n'));
  });
});

describe('Enter inside a list — rows six and seven', () => {
  it('continues the list instead of sending, from a non-empty item', async () => {
    const onKeyDown = vi.fn((e: React.KeyboardEvent) => e.preventDefault());
    const seen: string[] = [];
    const field = await renderWithCaret({
      initialValue: '- one',
      onKeyDown,
      onValue: (v) => seen.push(v),
    });
    expect(field.querySelector('li')).not.toBeNull();

    fireEvent.keyDown(field, { key: 'Enter' });

    // The ladder was NOT consulted — the list rung declined the key first.
    expect(onKeyDown).not.toHaveBeenCalled();
    await waitFor(() => expect(field.querySelectorAll('li').length).toBe(2));
  });

  it('still lets an open palette pick a row from inside a list item', async () => {
    // Row five sits ABOVE the list rows: a `/` palette open in a list item is
    // still a palette.
    const onKeyDown = vi.fn((e: React.KeyboardEvent) => e.preventDefault());
    const field = await renderWithCaret({
      initialValue: '- /dai',
      onKeyDown,
      isPaletteOpen: true,
      paletteHasResults: true,
    });
    expect(field.querySelector('li')).not.toBeNull();

    fireEvent.keyDown(field, { key: 'Enter' });

    expect(onKeyDown).toHaveBeenCalled();
  });

  it('still continues a backslash line from inside a list item', async () => {
    // Row four also sits above the list rows.
    const onKeyDown = vi.fn((e: React.KeyboardEvent) => e.preventDefault());
    const field = await renderWithCaret({ initialValue: '- one\\', onKeyDown });
    expect(field.querySelector('li')).not.toBeNull();

    fireEvent.keyDown(field, { key: 'Enter' });

    expect(onKeyDown).toHaveBeenCalled();
  });

  it('leaves Alt+Enter and Shift+Enter to their own rows inside a list', async () => {
    const onKeyDown = vi.fn((e: React.KeyboardEvent) => e.preventDefault());
    const field = await renderWithCaret({ initialValue: '- one', onKeyDown });
    expect(field.querySelector('li')).not.toBeNull();

    fireEvent.keyDown(field, { key: 'Enter', altKey: true });
    expect(onKeyDown).toHaveBeenCalledTimes(1);
  });
});
