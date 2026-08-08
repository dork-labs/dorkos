/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import { useState } from 'react';
import type { PaletteCommandEntry } from '@/layers/entities/command';
import { useInputAutocomplete } from '../use-input-autocomplete';

/**
 * Trigger detection needs a `(value, cursor)` PAIR, and a field may report both
 * halves in one tick.
 *
 * This is the regression net for a bug found in a real browser (DOR-948 task
 * 5.2): typing `/` into the rich-text composer did not open the command
 * palette, while the same keystroke on the textarea did.
 *
 * The cause was in this hook, not in the new field. `handleInputChange` knew the
 * new value and read the cursor from state; `handleCursorChange` knew the new
 * cursor and read the value from state. A field that calls BOTH in one tick —
 * which `TextareaField.handleChange` and Lexical's update listener both do —
 * left the second call detecting against a half-stale pair, which closed the
 * palette the first call had just opened.
 *
 * The textarea hid this for as long as it existed: typing also fires `select`,
 * so a third detection ran after the re-render with both halves fresh and
 * repaired the damage. A contenteditable fires no such event, so nothing
 * repaired it.
 */

const COMMANDS: PaletteCommandEntry[] = [
  {
    name: 'compact',
    description: 'Shrink the conversation to free up context',
    source: 'intent',
  } as unknown as PaletteCommandEntry,
];

/** Drive the hook the way a host does: it owns `input`, the hook reports back. */
function renderAutocomplete() {
  return renderHook(() => {
    const [input, setInput] = useState('');
    const autocomplete = useInputAutocomplete({
      input,
      setInput,
      commands: COMMANDS,
      fileEntries: [],
    });
    return { input, autocomplete };
  });
}

describe('useInputAutocomplete — a field that reports value and cursor together', () => {
  it('opens the command palette when both halves arrive in ONE tick', () => {
    const { result } = renderAutocomplete();

    // Exactly what the rich field does: text first, then cursor, synchronously,
    // with no `select` event afterwards to clean up.
    act(() => {
      result.current.autocomplete.handleInputChange('/');
      result.current.autocomplete.handleCursorChange(1);
    });

    expect(result.current.autocomplete.commands.show).toBe(true);
    expect(result.current.autocomplete.isPaletteOpen).toBe(true);
  });

  it('opens the file palette when both halves arrive in one tick', () => {
    const { result } = renderAutocomplete();

    act(() => {
      result.current.autocomplete.handleInputChange('look at @src');
      result.current.autocomplete.handleCursorChange('look at @src'.length);
    });

    expect(result.current.autocomplete.files.show).toBe(true);
  });

  it('still opens when the field reports the two halves in separate ticks', () => {
    // The textarea's shape, kept working: a `select` event lands after the
    // re-render, and detection runs again with both halves fresh.
    const { result } = renderAutocomplete();

    act(() => {
      result.current.autocomplete.handleInputChange('/');
    });
    act(() => {
      result.current.autocomplete.handleCursorChange(1);
    });

    expect(result.current.autocomplete.commands.show).toBe(true);
  });

  it('closes again when the trigger is typed away', () => {
    // The bar has to be able to say no, or "it opens" proves nothing.
    const { result } = renderAutocomplete();

    act(() => {
      result.current.autocomplete.handleInputChange('/');
      result.current.autocomplete.handleCursorChange(1);
    });
    expect(result.current.autocomplete.commands.show).toBe(true);

    act(() => {
      result.current.autocomplete.handleInputChange('hello');
      result.current.autocomplete.handleCursorChange('hello'.length);
    });
    expect(result.current.autocomplete.commands.show).toBe(false);
  });

  it('detects against a value the HOST set, not a stale one', () => {
    // The host empties the box on send and writes dropped file paths into it,
    // and neither goes through `handleInputChange`. A cursor report arriving
    // after such a write must detect against what the host set.
    const { result, rerender } = renderHook(
      ({ input }: { input: string }) => {
        const autocomplete = useInputAutocomplete({
          input,
          setInput: vi.fn(),
          commands: COMMANDS,
          fileEntries: [],
        });
        return autocomplete;
      },
      { initialProps: { input: '' } }
    );

    rerender({ input: '/' });
    act(() => {
      result.current.handleCursorChange(1);
    });

    expect(result.current.commands.show).toBe(true);
  });
});
