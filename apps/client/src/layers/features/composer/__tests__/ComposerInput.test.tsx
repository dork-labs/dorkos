// @vitest-environment jsdom
import { createRef, useState } from 'react';
import { describe, it, expect, vi, afterEach, beforeEach, beforeAll } from 'vitest';
import { render, screen, fireEvent, cleanup, act } from '@testing-library/react';
import { PageHeading } from '@/layers/shared/ui';
import { ComposerInput, type ComposerInputHandle } from '../ui/ComposerInput';

/**
 * Whether the field's editing surface claims a composition is in progress.
 *
 * A `<textarea>` has no editor-level composition state — its adapter answers a
 * constant `false`, and the keydown's own flags are the whole IME story there.
 * A rich-text editor does, and can report one on a keydown whose flags are
 * clear. Stubbing the real adapter's one method is how the textarea path proves
 * the ladder consults the surface at all.
 */
const surfaceComposing = vi.hoisted(() => ({ current: false }));

vi.mock('../ui/textarea-surface', async () => {
  const actual =
    await vi.importActual<typeof import('../ui/textarea-surface')>('../ui/textarea-surface');
  return {
    createTextareaSurface: (ref: Parameters<typeof actual.createTextareaSurface>[0]) => ({
      ...actual.createTextareaSurface(ref),
      isComposing: () => surfaceComposing.current,
    }),
  };
});

/**
 * The emulated device, read per query by the `matchMedia` mock below.
 *
 * Deliberately three independent facts rather than one "is mobile" boolean.
 * Width and pointer are different questions — that separation is the whole
 * point of `useIsTouchOnly` — and a stub returning one blanket answer for every
 * query cannot fail on the case this exists for: a narrow desktop window, which
 * is coarse-pointer FALSE and max-width-767 TRUE at the same time.
 */
interface EmulatedDevice {
  width: number;
  /** `(pointer: coarse)` — the PRIMARY pointer is a finger. */
  primaryPointerCoarse: boolean;
  /** `(any-pointer: fine)` — some mouse, trackpad, or stylus is attached. */
  hasFinePointer: boolean;
}

const DESKTOP: EmulatedDevice = { width: 1280, primaryPointerCoarse: false, hasFinePointer: true };
/** A desktop window dragged beside an editor: narrow, but still a real mouse. */
const NARROW_DESKTOP: EmulatedDevice = {
  width: 700,
  primaryPointerCoarse: false,
  hasFinePointer: true,
};
const PHONE: EmulatedDevice = { width: 390, primaryPointerCoarse: true, hasFinePointer: false };

let device: EmulatedDevice = DESKTOP;

/** Answer one media query against {@link device}. */
function evaluateMediaQuery(query: string): boolean {
  if (query.includes('(pointer: coarse)')) return device.primaryPointerCoarse;
  if (query.includes('(any-pointer: fine)')) return device.hasFinePointer;
  const maxWidth = /max-width:\s*(\d+)px/.exec(query);
  if (maxWidth) return device.width <= Number(maxWidth[1]);
  return false;
}

beforeAll(() => {
  Object.defineProperty(window, 'matchMedia', {
    writable: true,
    value: vi.fn().mockImplementation((query: string) => ({
      matches: evaluateMediaQuery(query),
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

/**
 * Stub `document.execCommand('insertText')` — jsdom has no editing pipeline.
 * Splices the text into the focused field the way a browser would, so tests can
 * assert both the resulting text and that the edit went through `execCommand`
 * (the only path that keeps the field's native undo stack intact).
 */
function stubExecCommand() {
  const exec = vi.fn((command: string, _showUi?: boolean, text?: string) => {
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
  });
  Object.defineProperty(document, 'execCommand', {
    writable: true,
    configurable: true,
    value: exec,
  });
  return exec;
}

/**
 * `stubExecCommand`, plus the native `input` event a real browser fires — so a
 * controlled host's `onChange` runs and the value round-trip is exercised, not
 * only the call. The write goes through the PROTOTYPE setter on purpose: React
 * patches the instance's own `value` property to track changes, and writing
 * through that patch makes React believe nothing changed.
 *
 * Every test that asserts the TEXT an edit leaves behind uses this one, paired
 * with {@link ControlledComposer}. With a frozen `value` prop and no input
 * event, an implementation that skipped `execCommand` entirely — writing
 * `textarea.value` directly, destroying the field's undo stack — still left the
 * right characters in the DOM, and only the three tests that spy on the call
 * itself noticed. {@link stubExecCommand} remains for the cases that assert
 * `execCommand` was NOT reached at all, where no round-trip exists to model.
 */
function stubExecCommandWithInputEvent() {
  const exec = vi.fn((command: string, _showUi?: boolean, text?: string) => {
    if (command !== 'insertText') return false;
    const el = document.activeElement as HTMLTextAreaElement | null;
    if (!el) return false;
    const start = el.selectionStart ?? 0;
    const end = el.selectionEnd ?? 0;
    const inserted = text ?? '';
    const next = el.value.slice(0, start) + inserted + el.value.slice(end);
    const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!;
    setter.call(el, next);
    const caret = start + inserted.length;
    el.setSelectionRange(caret, caret);
    el.dispatchEvent(new Event('input', { bubbles: true }));
    return true;
  });
  Object.defineProperty(document, 'execCommand', {
    writable: true,
    configurable: true,
    value: exec,
  });
  return exec;
}

/** ComposerInput wired the way every host wires it: the value prop follows onChange. */
function ControlledComposer({
  initialValue,
  onChange,
  ...props
}: Omit<Parameters<typeof ComposerInput>[0], 'value' | 'onChange'> & {
  initialValue: string;
  onChange?: (value: string) => void;
}) {
  const [value, setValue] = useState(initialValue);
  return (
    <ComposerInput
      {...props}
      value={value}
      onChange={(next) => {
        setValue(next);
        onChange?.(next);
      }}
    />
  );
}

/**
 * Render a controlled composer and place a collapsed caret at `caret`
 * (default: end of text).
 */
function renderControlled(props: Parameters<typeof ControlledComposer>[0], caret?: number) {
  const seen: string[] = [];
  const view = render(
    <ControlledComposer
      {...props}
      onChange={(next) => {
        seen.push(next);
        props.onChange?.(next);
      }}
    />
  );
  const textarea = screen.getByRole('combobox') as HTMLTextAreaElement;
  textarea.focus();
  const pos = caret ?? textarea.value.length;
  textarea.setSelectionRange(pos, pos);
  return {
    ...view,
    textarea,
    /**
     * The text the HOST ended up with — what would actually be sent.
     *
     * This, not `textarea.value`, is what proves an edit went through the
     * browser's editing pipeline. A write straight to `textarea.value` leaves
     * the right characters in the DOM and fires no `input` event, so the host
     * never hears about them, and nothing re-renders to expose the mismatch.
     */
    hostValue: () => seen.at(-1) ?? props.initialValue,
  };
}

/** Render the composer and place a collapsed caret at `caret` (default: end of value). */
function renderWithCaret(props: Parameters<typeof ComposerInput>[0], caret?: number) {
  const view = render(<ComposerInput {...props} />);
  const textarea = screen.getByRole('combobox') as HTMLTextAreaElement;
  textarea.focus();
  const pos = caret ?? textarea.value.length;
  textarea.setSelectionRange(pos, pos);
  return { ...view, textarea };
}

beforeEach(() => {
  device = DESKTOP;
  surfaceComposing.current = false;
});

afterEach(() => {
  cleanup();
});

describe('ComposerInput', () => {
  const defaultProps = {
    value: '',
    onChange: vi.fn(),
    onSubmit: vi.fn(),
    isStreaming: false,
  };

  /** {@link defaultProps} minus the two props {@link ControlledComposer} owns. */
  const controlledDefaults = { onSubmit: vi.fn(), isStreaming: false };

  it('calls onSubmit on Enter key when value is non-empty', () => {
    const onSubmit = vi.fn();
    render(<ComposerInput {...defaultProps} value="hello" onSubmit={onSubmit} />);
    fireEvent.keyDown(screen.getByRole('combobox'), { key: 'Enter' });
    expect(onSubmit).toHaveBeenCalled();
  });

  it('does not submit on Shift+Enter', () => {
    const onSubmit = vi.fn();
    render(<ComposerInput {...defaultProps} value="hello" onSubmit={onSubmit} />);
    fireEvent.keyDown(screen.getByRole('combobox'), { key: 'Enter', shiftKey: true });
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it('does not submit when value is empty', () => {
    const onSubmit = vi.fn();
    render(<ComposerInput {...defaultProps} value="" onSubmit={onSubmit} />);
    fireEvent.keyDown(screen.getByRole('combobox'), { key: 'Enter' });
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it('does not submit when streaming', () => {
    const onSubmit = vi.fn();
    render(
      <ComposerInput {...defaultProps} value="hello" isStreaming={true} onSubmit={onSubmit} />
    );
    fireEvent.keyDown(screen.getByRole('combobox'), { key: 'Enter' });
    expect(onSubmit).not.toHaveBeenCalled();
  });

  // One test, two states. There used to be three of these — two byte-identical
  // — and each only checked that `disabled` was still its own default, which the
  // component never sets either way. Locking the field is the regression that
  // matters (it drops the caret with no restore), and it has more than one
  // spelling, so the check is: not disabled, not read-only, and the keystrokes
  // still arrive.
  it.each([
    ['while the agent is streaming', { isStreaming: true }],
    ['while an upload is in flight', { isUploading: true }],
  ])('stays typeable %s', (_label, state) => {
    const onChange = vi.fn();
    render(<ComposerInput {...defaultProps} {...state} onChange={onChange} />);
    const textarea = screen.getByRole('combobox');

    expect(textarea).toBeEnabled();
    expect(textarea).not.toHaveAttribute('readonly');
    fireEvent.change(textarea, { target: { value: 'typed anyway' } });
    expect(onChange).toHaveBeenCalledWith('typed anyway');
  });

  it('hides send button when value is empty', () => {
    render(<ComposerInput {...defaultProps} value="" />);
    // No visible button when hidden state — check button is not displayed or is disabled
    // The button is rendered with opacity 0 and pointer-events-none
    const btn = screen.queryByLabelText('Send message');
    // In hidden state, no aria-label matches any active button
    expect(btn).toBeNull();
  });

  it('calls onStop when stop button is clicked', () => {
    const onStop = vi.fn();
    render(<ComposerInput {...defaultProps} isStreaming={true} onStop={onStop} />);
    fireEvent.click(screen.getByLabelText('Stop generating'));
    expect(onStop).toHaveBeenCalled();
  });

  describe('palette-open keyboard handling', () => {
    /** An open palette that actually has rows to pick from. */
    const openPalette = { isPaletteOpen: true, paletteHasResults: true };

    it('calls onArrowDown when ArrowDown pressed and palette open', () => {
      const onArrowDown = vi.fn();
      render(<ComposerInput {...defaultProps} {...openPalette} onArrowDown={onArrowDown} />);
      fireEvent.keyDown(screen.getByRole('combobox'), { key: 'ArrowDown' });
      expect(onArrowDown).toHaveBeenCalledOnce();
    });

    it('calls onCommandSelect on Enter when palette open', () => {
      const onCommandSelect = vi.fn();
      const onSubmit = vi.fn();
      render(
        <ComposerInput
          {...defaultProps}
          value="/daily"
          {...openPalette}
          onCommandSelect={onCommandSelect}
          onSubmit={onSubmit}
        />
      );
      fireEvent.keyDown(screen.getByRole('combobox'), { key: 'Enter' });
      expect(onCommandSelect).toHaveBeenCalledOnce();
      expect(onSubmit).not.toHaveBeenCalled();
    });

    it('calls onCommandSelect on Tab when palette open', () => {
      const onCommandSelect = vi.fn();
      render(
        <ComposerInput {...defaultProps} {...openPalette} onCommandSelect={onCommandSelect} />
      );
      fireEvent.keyDown(screen.getByRole('combobox'), { key: 'Tab' });
      expect(onCommandSelect).toHaveBeenCalledOnce();
    });

    // A palette the person did NOT ask for — the home composer's "Jump back in"
    // panel floats up merely because the caret landed in an empty box. Tab there
    // means "move to the next control", and swallowing it opened whatever row
    // happened to be lit instead: a keyboard trap on the primary surface.
    it('leaves Tab alone when the host says it is not a pick key', () => {
      const onCommandSelect = vi.fn();
      render(
        <ComposerInput
          {...defaultProps}
          {...openPalette}
          tabPicks={false}
          onCommandSelect={onCommandSelect}
        />
      );
      const field = screen.getByRole('combobox');

      fireEvent.keyDown(field, { key: 'Tab' });
      expect(onCommandSelect).not.toHaveBeenCalled();

      // Enter is still the pick key — only Tab was handed back.
      fireEvent.keyDown(field, { key: 'Enter' });
      expect(onCommandSelect).toHaveBeenCalledOnce();
    });

    it('does not call onCommandSelect on Shift+Enter when palette open', () => {
      const onCommandSelect = vi.fn();
      render(
        <ComposerInput {...defaultProps} {...openPalette} onCommandSelect={onCommandSelect} />
      );
      fireEvent.keyDown(screen.getByRole('combobox'), { key: 'Enter', shiftKey: true });
      expect(onCommandSelect).not.toHaveBeenCalled();
    });
  });

  describe('palette open with no matches', () => {
    // Typing `/zzz` (or `@zzz`) leaves the panel on screen reading "No commands
    // found." — an open palette with nothing to select. Enter used to be
    // intercepted anyway, find no row, close the palette and send nothing.
    it('sends on Enter instead of swallowing it', () => {
      const onSubmit = vi.fn();
      const onCommandSelect = vi.fn();
      render(
        <ComposerInput
          {...defaultProps}
          value="/zzz"
          isPaletteOpen={true}
          paletteHasResults={false}
          onSubmit={onSubmit}
          onCommandSelect={onCommandSelect}
        />
      );
      fireEvent.keyDown(screen.getByRole('combobox'), { key: 'Enter' });
      expect(onSubmit).toHaveBeenCalledOnce();
      expect(onCommandSelect).not.toHaveBeenCalled();
    });

    it('queues on Enter mid-stream instead of swallowing it', () => {
      const onQueue = vi.fn();
      render(
        <ComposerInput
          {...defaultProps}
          value="@zzz"
          isStreaming={true}
          isPaletteOpen={true}
          paletteHasResults={false}
          onQueue={onQueue}
        />
      );
      fireEvent.keyDown(screen.getByRole('combobox'), { key: 'Enter' });
      expect(onQueue).toHaveBeenCalledOnce();
    });

    it('still lets Escape dismiss the empty panel without arming the draft wipe', () => {
      const onEscape = vi.fn();
      const onClear = vi.fn();
      render(
        <ComposerInput
          {...defaultProps}
          value="/zzz"
          isPaletteOpen={true}
          paletteHasResults={false}
          onEscape={onEscape}
          onClear={onClear}
        />
      );
      const combobox = screen.getByRole('combobox');
      fireEvent.keyDown(combobox, { key: 'Escape' });
      fireEvent.keyDown(combobox, { key: 'Escape' });
      expect(onEscape).toHaveBeenCalledTimes(2);
      expect(onClear).not.toHaveBeenCalled();
    });
  });

  describe('palette-closed keyboard regression', () => {
    it('calls onSubmit on Enter when palette closed (not onCommandSelect)', () => {
      const onSubmit = vi.fn();
      const onCommandSelect = vi.fn();
      render(
        <ComposerInput
          {...defaultProps}
          value="hello"
          isPaletteOpen={false}
          onSubmit={onSubmit}
          onCommandSelect={onCommandSelect}
        />
      );
      fireEvent.keyDown(screen.getByRole('combobox'), { key: 'Enter' });
      expect(onSubmit).toHaveBeenCalledOnce();
      expect(onCommandSelect).not.toHaveBeenCalled();
    });
  });

  describe('ARIA attributes', () => {
    it('textarea has combobox role', () => {
      render(<ComposerInput {...defaultProps} />);
      expect(screen.getByRole('combobox')).toBeDefined();
    });

    it('has aria-expanded true when palette open', () => {
      render(<ComposerInput {...defaultProps} isPaletteOpen={true} />);
      expect(screen.getByRole('combobox').getAttribute('aria-expanded')).toBe('true');
    });

    it('has aria-activedescendant when palette open with activeDescendantId', () => {
      render(
        <ComposerInput {...defaultProps} isPaletteOpen={true} activeDescendantId="command-item-2" />
      );
      expect(screen.getByRole('combobox').getAttribute('aria-activedescendant')).toBe(
        'command-item-2'
      );
    });

    it('points aria-controls at the file listbox that rendered, even with no matches', () => {
      // `@zzz` opens the file palette with zero results, so there is no active
      // option to infer the listbox from. Guessing off `activeDescendantId`
      // named `command-palette-listbox` — an element that was never rendered.
      render(
        <ComposerInput
          {...defaultProps}
          value="@zzz"
          isPaletteOpen={true}
          paletteListboxId="file-palette-listbox"
          activeDescendantId={undefined}
        />
      );
      expect(screen.getByRole('combobox').getAttribute('aria-controls')).toBe(
        'file-palette-listbox'
      );
    });
  });

  describe('clear button', () => {
    it('calls onClear when clicked', () => {
      const onClear = vi.fn();
      render(<ComposerInput {...defaultProps} value="hello" onClear={onClear} />);
      fireEvent.click(screen.getByLabelText('Clear message'));
      expect(onClear).toHaveBeenCalledOnce();
    });

    // Losing the button must not mean losing the ability to clear. The wipe
    // edits this component's own textarea, so the host's onChange carries the
    // empty value out whether or not it wired a handler — which is what makes
    // dropping the dead X safe rather than a removal of function.
    it('still clears on Escape-Escape with no onClear wired', () => {
      stubExecCommandWithInputEvent();
      const { textarea } = renderControlled({
        initialValue: 'hello',
        onSubmit: vi.fn(),
        isStreaming: false,
      });
      fireEvent.keyDown(textarea, { key: 'Escape' });
      fireEvent.keyDown(textarea, { key: 'Escape' });
      expect(textarea.value).toBe('');
      expect(screen.queryByLabelText('Clear message')).toBeNull();
    });
  });

  describe('escape clears text (double-escape)', () => {
    it('second Escape within 500ms calls onClear when text exists', () => {
      stubExecCommand();
      const onClear = vi.fn();
      const onEscape = vi.fn();
      render(
        <ComposerInput
          {...defaultProps}
          value="hello"
          isPaletteOpen={false}
          onClear={onClear}
          onEscape={onEscape}
        />
      );
      const combobox = screen.getByRole('combobox');
      fireEvent.keyDown(combobox, { key: 'Escape' });
      fireEvent.keyDown(combobox, { key: 'Escape' });
      expect(onClear).toHaveBeenCalledOnce();
    });

    // The wipe is two taps behind a key someone hammers to stop a runaway turn,
    // so it has to be recoverable. A `setState` rewrite of the controlled value
    // is invisible to Cmd+Z; only an execCommand edit pushes an undo entry.
    it('empties the field through execCommand so Cmd+Z can bring the draft back', () => {
      const exec = stubExecCommandWithInputEvent();
      const { textarea } = renderControlled({
        initialValue: 'hello',
        onSubmit: vi.fn(),
        isStreaming: false,
        onClear: vi.fn(),
      });
      fireEvent.keyDown(textarea, { key: 'Escape' });
      fireEvent.keyDown(textarea, { key: 'Escape' });
      expect(exec).toHaveBeenCalledWith('insertText', false, '');
      expect(textarea.value).toBe('');
    });

    it('second Escape after 500ms does not call onClear', () => {
      vi.useFakeTimers();
      const onClear = vi.fn();
      const onEscape = vi.fn();
      render(
        <ComposerInput
          {...defaultProps}
          value="hello"
          isPaletteOpen={false}
          onClear={onClear}
          onEscape={onEscape}
        />
      );
      const combobox = screen.getByRole('combobox');
      fireEvent.keyDown(combobox, { key: 'Escape' });
      act(() => {
        vi.advanceTimersByTime(600);
      });
      fireEvent.keyDown(combobox, { key: 'Escape' });
      expect(onClear).not.toHaveBeenCalled();
      expect(onEscape).toHaveBeenCalledTimes(2);
      vi.useRealTimers();
    });
  });

  describe('blur handling', () => {
    it('calls onEscape on blur when palette is open', () => {
      const onEscape = vi.fn();
      render(<ComposerInput {...defaultProps} isPaletteOpen={true} onEscape={onEscape} />);
      fireEvent.blur(screen.getByRole('combobox'));
      expect(onEscape).toHaveBeenCalledOnce();
    });
  });

  describe('canSubmit state', () => {
    it('does not call onSubmit when the disabled send button is clicked', () => {
      const onSubmit = vi.fn();
      render(
        <ComposerInput {...defaultProps} value="hello" canSubmit={false} onSubmit={onSubmit} />
      );
      fireEvent.click(screen.getByLabelText('Send message'));
      expect(onSubmit).not.toHaveBeenCalled();
    });

    it('does not submit on Enter when canSubmit is false', () => {
      const onSubmit = vi.fn();
      render(
        <ComposerInput {...defaultProps} value="hello" canSubmit={false} onSubmit={onSubmit} />
      );
      fireEvent.keyDown(screen.getByRole('combobox'), { key: 'Enter' });
      expect(onSubmit).not.toHaveBeenCalled();
    });
  });

  describe('queue button states', () => {
    it('send button shows Update icon when editing queue item', () => {
      render(
        <ComposerInput
          {...defaultProps}
          editingQueueItem={true}
          value="text"
          onSaveEdit={vi.fn()}
        />
      );
      expect(screen.getByLabelText('Save edit')).toBeDefined();
    });

    it('queue badge renders with correct count', () => {
      render(<ComposerInput {...defaultProps} isStreaming={true} value="text" queueDepth={3} />);
      expect(screen.getByText('3')).toBeDefined();
    });
  });

  describe('Enter key queue-aware behavior', () => {
    it('Enter key queues message during streaming when onQueue provided', () => {
      const onQueue = vi.fn();
      render(<ComposerInput {...defaultProps} isStreaming={true} value="test" onQueue={onQueue} />);
      fireEvent.keyDown(screen.getByRole('combobox'), { key: 'Enter' });
      expect(onQueue).toHaveBeenCalled();
    });

    it('Enter key saves edit when editingQueueItem is true', () => {
      const onSaveEdit = vi.fn();
      render(
        <ComposerInput
          {...defaultProps}
          editingQueueItem={true}
          value="edited"
          onSaveEdit={onSaveEdit}
        />
      );
      fireEvent.keyDown(screen.getByRole('combobox'), { key: 'Enter' });
      expect(onSaveEdit).toHaveBeenCalled();
    });

    it('Enter key prioritizes edit save over queue', () => {
      const onSaveEdit = vi.fn();
      const onQueue = vi.fn();
      render(
        <ComposerInput
          {...defaultProps}
          editingQueueItem={true}
          isStreaming={true}
          value="text"
          onSaveEdit={onSaveEdit}
          onQueue={onQueue}
        />
      );
      fireEvent.keyDown(screen.getByRole('combobox'), { key: 'Enter' });
      expect(onSaveEdit).toHaveBeenCalled();
      expect(onQueue).not.toHaveBeenCalled();
    });
  });

  describe('arrow key queue navigation', () => {
    it('Up arrow navigates to queue when queue has items and textarea is empty', () => {
      const onQueueNavigateUp = vi.fn();
      render(
        <ComposerInput
          {...defaultProps}
          queueHasItems={true}
          value=""
          isPaletteOpen={false}
          onQueueNavigateUp={onQueueNavigateUp}
        />
      );
      fireEvent.keyDown(screen.getByRole('combobox'), { key: 'ArrowUp' });
      expect(onQueueNavigateUp).toHaveBeenCalled();
    });

    it('Up arrow does NOT navigate when palette is open', () => {
      const onQueueNavigateUp = vi.fn();
      const onArrowUp = vi.fn();
      render(
        <ComposerInput
          {...defaultProps}
          queueHasItems={true}
          isPaletteOpen={true}
          onQueueNavigateUp={onQueueNavigateUp}
          onArrowUp={onArrowUp}
        />
      );
      fireEvent.keyDown(screen.getByRole('combobox'), { key: 'ArrowUp' });
      expect(onArrowUp).toHaveBeenCalled();
      expect(onQueueNavigateUp).not.toHaveBeenCalled();
    });

    it('Escape cancels edit when editingQueueItem is true', () => {
      const onCancelEdit = vi.fn();
      const onEscape = vi.fn();
      render(
        <ComposerInput
          {...defaultProps}
          editingQueueItem={true}
          onCancelEdit={onCancelEdit}
          onEscape={onEscape}
        />
      );
      fireEvent.keyDown(screen.getByRole('combobox'), { key: 'Escape' });
      expect(onCancelEdit).toHaveBeenCalled();
      expect(onEscape).not.toHaveBeenCalled();
    });
  });

  describe('IME composition guard', () => {
    it('does not submit on the Enter that commits an IME candidate', () => {
      const onSubmit = vi.fn();
      render(<ComposerInput {...defaultProps} value="こん" onSubmit={onSubmit} />);
      fireEvent.keyDown(screen.getByRole('combobox'), { key: 'Enter', isComposing: true });
      expect(onSubmit).not.toHaveBeenCalled();
    });

    it('does not stop generation on Escape while composing', () => {
      const onStop = vi.fn();
      const onEscape = vi.fn();
      render(
        <ComposerInput {...defaultProps} isStreaming={true} onStop={onStop} onEscape={onEscape} />
      );
      fireEvent.keyDown(screen.getByRole('combobox'), { key: 'Escape', isComposing: true });
      expect(onStop).not.toHaveBeenCalled();
      expect(onEscape).not.toHaveBeenCalled();
    });
  });

  describe('backslash line continuation', () => {
    it('turns a trailing backslash into a newline instead of submitting', () => {
      stubExecCommandWithInputEvent();
      const onSubmit = vi.fn();
      const { textarea, hostValue } = renderControlled({
        ...controlledDefaults,
        initialValue: 'foo\\',
        onSubmit,
      });
      fireEvent.keyDown(textarea, { key: 'Enter' });
      expect(onSubmit).not.toHaveBeenCalled();
      expect(textarea.value).toBe('foo\n');
      expect(hostValue()).toBe('foo\n');
    });

    it('submits on an escaped literal backslash (even run)', () => {
      stubExecCommandWithInputEvent();
      const onSubmit = vi.fn();
      const { textarea } = renderControlled({
        ...controlledDefaults,
        initialValue: 'foo\\\\',
        onSubmit,
      });
      fireEvent.keyDown(textarea, { key: 'Enter' });
      expect(onSubmit).toHaveBeenCalledOnce();
      expect(textarea.value).toBe('foo\\\\');
    });

    it('continues on a three-backslash run (odd)', () => {
      stubExecCommandWithInputEvent();
      const onSubmit = vi.fn();
      const { textarea, hostValue } = renderControlled({
        ...controlledDefaults,
        initialValue: 'foo\\\\\\',
        onSubmit,
      });
      fireEvent.keyDown(textarea, { key: 'Enter' });
      expect(onSubmit).not.toHaveBeenCalled();
      expect(textarea.value).toBe('foo\\\\\n');
      expect(hostValue()).toBe('foo\\\\\n');
    });

    it('never queues while streaming', () => {
      stubExecCommandWithInputEvent();
      const onQueue = vi.fn();
      const { textarea, hostValue } = renderControlled({
        ...controlledDefaults,
        initialValue: 'foo\\',
        isStreaming: true,
        onQueue,
      });
      fireEvent.keyDown(textarea, { key: 'Enter' });
      expect(onQueue).not.toHaveBeenCalled();
      expect(textarea.value).toBe('foo\n');
      expect(hostValue()).toBe('foo\n');
    });
  });

  describe('Option+Enter newline', () => {
    it('inserts a newline instead of submitting', () => {
      const exec = stubExecCommandWithInputEvent();
      const onSubmit = vi.fn();
      const { textarea, hostValue } = renderControlled({
        ...controlledDefaults,
        initialValue: 'hello',
        onSubmit,
      });
      fireEvent.keyDown(textarea, { key: 'Enter', altKey: true });
      expect(onSubmit).not.toHaveBeenCalled();
      expect(exec).toHaveBeenCalledWith('insertText', false, '\n');
      expect(textarea.value).toBe('hello\n');
      expect(hostValue()).toBe('hello\n');
    });
  });

  describe('Escape priority ladder', () => {
    it('dismisses the palette instead of stopping the turn', () => {
      const onEscape = vi.fn();
      const onStop = vi.fn();
      render(
        <ComposerInput
          {...defaultProps}
          value="hello"
          isStreaming={true}
          isPaletteOpen={true}
          paletteHasResults={true}
          onEscape={onEscape}
          onStop={onStop}
        />
      );
      fireEvent.keyDown(screen.getByRole('combobox'), { key: 'Escape' });
      expect(onEscape).toHaveBeenCalledOnce();
      expect(onStop).not.toHaveBeenCalled();
    });

    it('cancels a queue-item edit instead of stopping the turn', () => {
      const onCancelEdit = vi.fn();
      const onStop = vi.fn();
      render(
        <ComposerInput
          {...defaultProps}
          value="hello"
          isStreaming={true}
          editingQueueItem={true}
          onCancelEdit={onCancelEdit}
          onStop={onStop}
        />
      );
      fireEvent.keyDown(screen.getByRole('combobox'), { key: 'Escape' });
      expect(onCancelEdit).toHaveBeenCalledOnce();
      expect(onStop).not.toHaveBeenCalled();
    });

    it('stops the turn once no palette or edit is open', () => {
      const onStop = vi.fn();
      const onClear = vi.fn();
      render(
        <ComposerInput
          {...defaultProps}
          value="hello"
          isStreaming={true}
          onStop={onStop}
          onClear={onClear}
        />
      );
      fireEvent.keyDown(screen.getByRole('combobox'), { key: 'Escape' });
      expect(onStop).toHaveBeenCalledOnce();
      expect(onClear).not.toHaveBeenCalled();
    });
  });

  describe('the armed-to-clear signal', () => {
    /**
     * ComposerInput owns WHEN the double-Escape is armed; the composer host owns
     * where that reads out (the overlay lane, clear of the queue rows). So the
     * state machine is pinned here and the pill itself in the container's test.
     */
    let armed: boolean[];
    const armable = () => ({
      ...defaultProps,
      value: 'hello',
      isPaletteOpen: false,
      onClear: vi.fn(),
      onClearArmedChange: (next: boolean) => armed.push(next),
    });
    const isArmed = () => armed.at(-1) ?? false;

    beforeEach(() => {
      armed = [];
    });

    it('goes up on the first bare Escape, which otherwise shows nothing at all', () => {
      render(<ComposerInput {...armable()} />);
      fireEvent.keyDown(screen.getByRole('combobox'), { key: 'Escape' });
      expect(isArmed()).toBe(true);
    });

    it('comes down the moment the window it advertises closes', () => {
      vi.useFakeTimers();
      render(<ComposerInput {...armable()} />);
      fireEvent.keyDown(screen.getByRole('combobox'), { key: 'Escape' });
      expect(isArmed()).toBe(true);

      act(() => {
        vi.advanceTimersByTime(499);
      });
      expect(isArmed()).toBe(true);

      act(() => {
        vi.advanceTimersByTime(2);
      });
      expect(isArmed()).toBe(false);
      vi.useRealTimers();
    });

    it('drops a raised arm when the composer changes session', () => {
      // ChatPanel re-renders rather than remounts on a session switch, so an arm
      // raised against session A would otherwise still be live against B's
      // draft — one tap, and text nobody armed is gone.
      const props = armable();
      const { rerender } = render(<ComposerInput {...props} contextKey="session-a " />);
      const combobox = screen.getByRole('combobox');
      fireEvent.keyDown(combobox, { key: 'Escape' });
      expect(isArmed()).toBe(true);

      rerender(<ComposerInput {...props} value="B draft" contextKey="session-b " />);
      expect(isArmed()).toBe(false);

      fireEvent.keyDown(combobox, { key: 'Escape' });
      expect(props.onClear).not.toHaveBeenCalled();
    });
  });

  describe('keyboard focus rings', () => {
    // A text field matches :focus-visible on a click and on mount too, so the
    // card's orange ring is earned by a Tab key and by nothing else.
    it('paints the card ring only after Tab, and drops it on blur', () => {
      render(<ComposerInput {...defaultProps} />);
      const field = screen.getByRole('combobox');
      const card = field.closest('.items-end') as HTMLElement;

      fireEvent.focus(field);
      expect(card).toHaveClass('border-foreground/20');
      expect(card).not.toHaveClass('border-ring');

      fireEvent.keyUp(field, { key: 'Tab' });
      expect(card).toHaveClass('border-ring', 'ring-ring');
      expect(card).not.toHaveClass('border-foreground/20');

      fireEvent.blur(field);
      fireEvent.focus(field);
      expect(card).not.toHaveClass('border-ring');
    });
  });

  describe('autofocus on mount', () => {
    it('focuses the composer on desktop', () => {
      render(<ComposerInput {...defaultProps} />);
      expect(document.activeElement).toBe(screen.getByRole('combobox'));
    });

    it('does not focus on a touch viewport (no surprise keyboard)', () => {
      device = PHONE;
      render(<ComposerInput {...defaultProps} />);
      expect(document.activeElement).not.toBe(screen.getByRole('combobox'));
    });

    // A phone context switch moves focus to the new page's heading so a screen
    // reader says where the person arrived. On Home the room's composer mounts
    // after that, sometimes twice, and used to take focus straight back
    // (DOR-2613).
    it('leaves focus on a page heading that already holds it', () => {
      device = NARROW_DESKTOP;
      render(<PageHeading>Home</PageHeading>);
      const heading = screen.getByRole('heading', { level: 1, name: 'Home' });
      act(() => heading.focus());
      render(<ComposerInput {...defaultProps} />);
      expect(document.activeElement).toBe(heading);
    });
  });

  describe('clicking Stop rescues focus before the button vanishes (DOR-1300 S5)', () => {
    // The dedicated red-square Stop button is REMOVED (not merely disabled)
    // the instant the host flips `stopPending` in response to `onStop` — see
    // InputActionButton. An element that unmounts outright drops focus to
    // `<body>` with nothing to rescue it, and by the time any effect could
    // react to the state change the removal (and the focus loss) has already
    // happened — a `useEffect` keyed on `stopPending` was tried and reliably
    // observed `document.activeElement === document.body`, never the
    // just-removed button, because React's DOM mutation (and the browser's
    // own focus-drop) both happen before any effect runs. The fix moves
    // focus to the field INSIDE the click itself, before the host's `onStop`
    // has any chance to trigger the removal.
    it('moves focus to the field the moment the dedicated Stop button is clicked', () => {
      const onStop = vi.fn();
      render(
        <ComposerInput
          {...defaultProps}
          value="stop the build"
          isStreaming
          stopPending={false}
          onStop={onStop}
        />
      );
      const stopButton = screen.getByLabelText('Stop generating');
      // Move focus onto the button first — mirroring what a real click does
      // in a browser (jsdom's `fireEvent.click` does not itself move focus,
      // so without this the assertion below would pass whether or not the
      // fix exists: the field is already focused from mount and never stops
      // being so).
      act(() => stopButton.focus());
      expect(document.activeElement).toBe(stopButton);

      act(() => fireEvent.click(stopButton));

      expect(document.activeElement).toBe(screen.getByRole('combobox'));
      expect(onStop).toHaveBeenCalledTimes(1);
    });
  });

  describe('focusUnlessTouch handle', () => {
    // The mount guard only ever protected the composer's own autofocus. Every
    // host that focused THROUGH the handle — ChatPanel on session switch, on
    // `?prompt=` seeding — re-opened the same hole, so the rule lives here now.
    it('focuses on desktop', () => {
      const ref = createRef<ComposerInputHandle>();
      render(<ComposerInput {...defaultProps} ref={ref} />);
      screen.getByRole('combobox').blur();
      act(() => ref.current!.focusUnlessTouch());
      expect(document.activeElement).toBe(screen.getByRole('combobox'));
    });

    it('is a no-op on a phone', () => {
      device = PHONE;
      const ref = createRef<ComposerInputHandle>();
      render(<ComposerInput {...defaultProps} ref={ref} />);
      act(() => ref.current!.focusUnlessTouch());
      expect(document.activeElement).not.toBe(screen.getByRole('combobox'));
    });
  });

  describe('what Enter means on each device', () => {
    /** Press Enter with text in the box and report whether it submitted. */
    function pressEnter() {
      const onSubmit = vi.fn();
      const { textarea } = renderWithCaret({ ...defaultProps, value: 'send me', onSubmit });
      fireEvent.keyDown(textarea, { key: 'Enter' });
      return { submitted: onSubmit.mock.calls.length > 0, textarea };
    }

    it('sends on a desktop', () => {
      expect(pressEnter().submitted).toBe(true);
    });

    it('inserts a newline on a phone rather than sending', () => {
      device = PHONE;
      const { submitted } = pressEnter();
      expect(submitted).toBe(false);
    });
  });

  describe('editing a queued item with an emptied field', () => {
    it('calls onCancelEdit when the cancel button is clicked', () => {
      const onCancelEdit = vi.fn();
      render(
        <ComposerInput
          {...defaultProps}
          editingQueueItem={true}
          value=""
          onCancelEdit={onCancelEdit}
        />
      );
      fireEvent.click(screen.getByLabelText('Cancel edit'));
      expect(onCancelEdit).toHaveBeenCalledOnce();
    });

    it('is reachable on a touch device, where there is no Escape key', () => {
      device = PHONE;
      const onCancelEdit = vi.fn();
      render(
        <ComposerInput
          {...defaultProps}
          editingQueueItem={true}
          value="   "
          onCancelEdit={onCancelEdit}
        />
      );
      fireEvent.click(screen.getByLabelText('Cancel edit'));
      expect(onCancelEdit).toHaveBeenCalledOnce();
    });
  });

  describe('attachment upload in flight', () => {
    it('does not submit on Enter — the send is already happening', () => {
      const onSubmit = vi.fn();
      render(
        <ComposerInput
          {...defaultProps}
          value="here you go"
          isUploading={true}
          onSubmit={onSubmit}
        />
      );
      fireEvent.keyDown(screen.getByRole('combobox'), { key: 'Enter' });
      expect(onSubmit).not.toHaveBeenCalled();
    });

    it('still lets a real streaming turn be stopped', () => {
      render(
        <ComposerInput
          {...defaultProps}
          value=""
          isStreaming={true}
          isUploading={true}
          onStop={vi.fn()}
        />
      );
      expect(screen.getByLabelText('Stop generating')).toBeDefined();
    });

    describe('when the host can stop it', () => {
      // Escape stops a streaming turn; the upload IS the send, so it stops that
      // too rather than falling through to arming the draft wipe.
      it('cancels the upload on Escape', () => {
        const onCancelUpload = vi.fn();
        const onClear = vi.fn();
        render(
          <ComposerInput
            {...defaultProps}
            value="here you go"
            isUploading={true}
            onCancelUpload={onCancelUpload}
            onClear={onClear}
          />
        );
        const combobox = screen.getByRole('combobox');
        fireEvent.keyDown(combobox, { key: 'Escape' });
        fireEvent.keyDown(combobox, { key: 'Escape' });
        expect(onCancelUpload).toHaveBeenCalledTimes(2);
        expect(onClear).not.toHaveBeenCalled();
      });
    });
  });

  describe('a dispatched command still settling', () => {
    // The composer keeps `/compact focus on the API changes` until the trigger
    // confirms, so a refusal cannot eat the instructions. That window left both
    // submit paths live: one intent, two compact triggers.
    it('does not submit again on Enter', () => {
      const onSubmit = vi.fn();
      render(
        <ComposerInput
          {...defaultProps}
          value="/compact the api bits"
          commandPending
          onSubmit={onSubmit}
        />
      );
      fireEvent.keyDown(screen.getByRole('combobox'), { key: 'Enter' });
      expect(onSubmit).not.toHaveBeenCalled();
    });

    it('leaves the dedicated Stop reachable — a running turn is still stoppable', () => {
      render(
        <ComposerInput
          {...defaultProps}
          value="/compact the api bits"
          isStreaming
          commandPending
          onStop={vi.fn()}
        />
      );
      expect(screen.getByLabelText('Stop generating')).toBeDefined();
    });
  });

  describe('canSubmitReason', () => {
    it('says why the send is unavailable instead of failing silently', () => {
      render(
        <ComposerInput
          {...defaultProps}
          value="build me a blog"
          canSubmit={false}
          canSubmitReason="Getting your agent ready…"
        />
      );
      expect(screen.getByText('Getting your agent ready…')).toBeDefined();
    });

    it('offers a way out on that line when there is one, and it works', () => {
      const onClick = vi.fn();
      render(
        <ComposerInput
          {...defaultProps}
          value="build me a blog"
          canSubmit={false}
          canSubmitReason="Couldn’t check this folder."
          canSubmitAction={{ label: 'Check again', onClick }}
        />
      );
      fireEvent.click(screen.getByRole('button', { name: 'Check again' }));
      expect(onClick).toHaveBeenCalledOnce();
    });
  });
});
