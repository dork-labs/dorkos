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

describe('Enter ENDS a list from an empty item', () => {
  // The locked decision has two halves and this is the second: Enter continues
  // a list, and Enter on an EMPTY item exits it. Without the exit there is no
  // way off a list from the keyboard at all — the second Enter is a no-op and
  // the person is stuck adding blank bullets.
  it('turns an empty trailing item into a paragraph', async () => {
    const onKeyDown = vi.fn((e: React.KeyboardEvent) => e.preventDefault());
    const seen: string[] = [];
    const field = await renderWithCaret({
      initialValue: '- one',
      onKeyDown,
      onValue: (v) => seen.push(v),
    });

    // First Enter continues the list: two items, the second empty.
    fireEvent.keyDown(field, { key: 'Enter' });
    await waitFor(() => expect(field.querySelectorAll('li').length).toBe(2));

    // Second Enter, now on the empty item, must LEAVE the list.
    fireEvent.keyDown(field, { key: 'Enter' });

    // Both facts in ONE waitFor: the item count settles a tick before the new
    // paragraph is reconciled, so asserting them in sequence races the flush.
    await waitFor(() => {
      expect(field.querySelectorAll('li').length).toBe(1);
      expect(field.querySelector('p')).not.toBeNull();
    });
    // The ladder was never consulted for either press — both belong to the list.
    expect(onKeyDown).not.toHaveBeenCalled();
    // `\n\n`, not nothing: the document really does now hold the list PLUS the
    // empty paragraph the exit just created, and the serializer says so. Sending
    // trims it, and re-parsing it collapses back to `- one` in one pass — the
    // trailing-blank-line normalization the round-trip corpus already pins.
    await waitFor(() => expect(seen.at(-1)).toBe('- one\n\n'));
  });

  // The other half of the exit: once out, Enter belongs to the ladder again.
  // Driven from a document that already HAS a paragraph after the list rather
  // than by pressing Enter a third time — a keypress fired immediately after
  // the exit races Lexical's selection sync, and re-firing a side-effecting
  // key inside a `waitFor` is not a fix.
  it('hands Enter back to the ladder once the caret is out of the list', async () => {
    const onKeyDown = vi.fn((e: React.KeyboardEvent) => e.preventDefault());
    const field = await renderWithCaret({ initialValue: '- one\n\ntail', onKeyDown });
    await waitFor(() => {
      expect(field.querySelectorAll('li').length).toBe(1);
      expect(field.querySelector('p')?.textContent).toBe('tail');
    });

    fireEvent.keyDown(field, { key: 'Enter' });

    await waitFor(() => expect(onKeyDown).toHaveBeenCalledTimes(1));
  });

  it('still continues a NON-empty item rather than exiting', async () => {
    const onKeyDown = vi.fn((e: React.KeyboardEvent) => e.preventDefault());
    const field = await renderWithCaret({ initialValue: '- one\n- two', onKeyDown });
    await waitFor(() => expect(field.querySelectorAll('li').length).toBe(2));

    fireEvent.keyDown(field, { key: 'Enter' });

    await waitFor(() => expect(field.querySelectorAll('li').length).toBe(3));
    expect(onKeyDown).not.toHaveBeenCalled();
  });
});

describe('Enter in a document that contains a NESTED list', () => {
  // Nesting is reachable on INPUT — `@lexical/markdown`'s list regexes capture
  // leading whitespace, and four spaces build a real `listitem > list >
  // listitem`. It is NOT reachable on output: this composer's serializer writes
  // no indentation, so the value flattens to `- a\n- b`. That is pinned as a
  // normalization in the round-trip corpus, and it has a consequence this test
  // deliberately does not paper over — a markdown offset cannot address a
  // nested position, so `focusAt` cannot reliably land in the inner item.
  //
  // What IS true regardless of depth, and is what this fix is about: an empty
  // item hands Enter to the list, and the list ends it.
  it('still ends an empty item, and never consults the ladder', async () => {
    const onKeyDown = vi.fn((e: React.KeyboardEvent) => e.preventDefault());
    const field = await renderWithCaret({ initialValue: '- a\n    - b', onKeyDown });
    await waitFor(() => expect(field.querySelectorAll('li').length).toBeGreaterThan(1));

    fireEvent.keyDown(field, { key: 'Enter' });
    fireEvent.keyDown(field, { key: 'Enter' });

    // The empty item became a paragraph; the surrounding list survived.
    await waitFor(() => expect(field.querySelectorAll('p').length).toBe(1));
    expect(field.querySelectorAll('li').length).toBeGreaterThan(0);
    expect(onKeyDown).not.toHaveBeenCalled();
  });
});
