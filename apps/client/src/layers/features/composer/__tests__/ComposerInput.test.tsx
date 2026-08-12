// @vitest-environment jsdom
import { createRef, useState } from 'react';
import { describe, it, expect, vi, afterEach, beforeEach, beforeAll } from 'vitest';
import { render, screen, fireEvent, cleanup, act } from '@testing-library/react';
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
/** iPad + Magic Keyboard: coarse primary pointer, but a trackpad is attached. */
const TABLET_WITH_TRACKPAD: EmulatedDevice = {
  width: 1024,
  primaryPointerCoarse: true,
  hasFinePointer: true,
};

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

  it('renders textarea with placeholder', () => {
    render(<ComposerInput {...defaultProps} />);
    expect(screen.getByPlaceholderText(/Send a message/)).toBeDefined();
  });

  it('renders custom placeholder when provided', () => {
    render(<ComposerInput {...defaultProps} placeholder="Compose next" />);
    expect(screen.getByPlaceholderText('Compose next')).toBeDefined();
  });

  it('uses default placeholder when not provided', () => {
    render(<ComposerInput {...defaultProps} />);
    expect(screen.getByPlaceholderText('Send a message...')).toBeDefined();
  });

  it('calls onChange when typing', () => {
    const onChange = vi.fn();
    render(<ComposerInput {...defaultProps} onChange={onChange} />);
    fireEvent.change(screen.getByRole('combobox'), { target: { value: 'hello' } });
    expect(onChange).toHaveBeenCalledWith('hello');
  });

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

  it('shows stop button when streaming (no text)', () => {
    render(<ComposerInput {...defaultProps} isStreaming={true} onStop={vi.fn()} />);
    expect(screen.getByLabelText('Stop generating')).toBeDefined();
  });

  it('shows send button when not streaming and has text', () => {
    render(<ComposerInput {...defaultProps} value="hello" />);
    expect(screen.getByLabelText('Send message')).toBeDefined();
  });

  it('hides send button when value is empty', () => {
    render(<ComposerInput {...defaultProps} value="" />);
    // No visible button when hidden state — check button is not displayed or is disabled
    // The button is rendered with opacity 0 and pointer-events-none
    const btn = screen.queryByLabelText('Send message');
    // In hidden state, no aria-label matches any active button
    expect(btn).toBeNull();
  });

  it('shows send button when value is non-empty', () => {
    render(<ComposerInput {...defaultProps} value="hello" />);
    expect(screen.getByLabelText('Send message')).toBeDefined();
  });

  it('calls onStop when stop button is clicked', () => {
    const onStop = vi.fn();
    render(<ComposerInput {...defaultProps} isStreaming={true} onStop={onStop} />);
    fireEvent.click(screen.getByLabelText('Stop generating'));
    expect(onStop).toHaveBeenCalled();
  });

  it('calls onEscape when Escape pressed', () => {
    const onEscape = vi.fn();
    render(<ComposerInput {...defaultProps} onEscape={onEscape} />);
    fireEvent.keyDown(screen.getByRole('combobox'), { key: 'Escape' });
    expect(onEscape).toHaveBeenCalled();
  });

  it('paperclip button is NOT disabled during streaming', () => {
    const onAttach = vi.fn();
    render(<ComposerInput {...defaultProps} isStreaming={true} onAttach={onAttach} />);
    const btn = screen.getByLabelText('Attach file');
    expect(btn).not.toHaveProperty('disabled', true);
  });

  it('clear button works during streaming', () => {
    render(<ComposerInput {...defaultProps} value="hello" isStreaming={true} onClear={vi.fn()} />);
    const btn = screen.getByLabelText('Clear message');
    expect(btn.className).not.toContain('pointer-events-none');
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

    it('calls onArrowUp when ArrowUp pressed and palette open', () => {
      const onArrowUp = vi.fn();
      render(<ComposerInput {...defaultProps} {...openPalette} onArrowUp={onArrowUp} />);
      fireEvent.keyDown(screen.getByRole('combobox'), { key: 'ArrowUp' });
      expect(onArrowUp).toHaveBeenCalledOnce();
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

    it('calls onEscape on Escape when palette open', () => {
      const onEscape = vi.fn();
      render(<ComposerInput {...defaultProps} {...openPalette} onEscape={onEscape} />);
      fireEvent.keyDown(screen.getByRole('combobox'), { key: 'Escape' });
      expect(onEscape).toHaveBeenCalledOnce();
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
    it('does not call onArrowDown when ArrowDown pressed and palette closed', () => {
      const onArrowDown = vi.fn();
      render(<ComposerInput {...defaultProps} isPaletteOpen={false} onArrowDown={onArrowDown} />);
      fireEvent.keyDown(screen.getByRole('combobox'), { key: 'ArrowDown' });
      expect(onArrowDown).not.toHaveBeenCalled();
    });

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

    it('has aria-expanded false when palette closed', () => {
      render(<ComposerInput {...defaultProps} isPaletteOpen={false} />);
      expect(screen.getByRole('combobox').getAttribute('aria-expanded')).toBe('false');
    });

    it('has aria-expanded false by default (no isPaletteOpen)', () => {
      render(<ComposerInput {...defaultProps} />);
      expect(screen.getByRole('combobox').getAttribute('aria-expanded')).toBe('false');
    });

    it('has aria-activedescendant when palette open with activeDescendantId', () => {
      render(
        <ComposerInput {...defaultProps} isPaletteOpen={true} activeDescendantId="command-item-2" />
      );
      expect(screen.getByRole('combobox').getAttribute('aria-activedescendant')).toBe(
        'command-item-2'
      );
    });

    it('does not have aria-activedescendant when palette closed', () => {
      render(
        <ComposerInput
          {...defaultProps}
          isPaletteOpen={false}
          activeDescendantId="command-item-2"
        />
      );
      expect(screen.getByRole('combobox').getAttribute('aria-activedescendant')).toBeNull();
    });

    it('has aria-controls pointing to command palette listbox when palette is open', () => {
      render(
        <ComposerInput
          {...defaultProps}
          isPaletteOpen={true}
          paletteListboxId="command-palette-listbox"
          activeDescendantId="command-item-0"
        />
      );
      expect(screen.getByRole('combobox').getAttribute('aria-controls')).toBe(
        'command-palette-listbox'
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

    it('has no aria-controls when palette is closed', () => {
      render(<ComposerInput {...defaultProps} paletteListboxId="command-palette-listbox" />);
      expect(screen.getByRole('combobox').getAttribute('aria-controls')).toBeNull();
    });

    it('has aria-autocomplete set to list', () => {
      render(<ComposerInput {...defaultProps} />);
      expect(screen.getByRole('combobox').getAttribute('aria-autocomplete')).toBe('list');
    });
  });

  describe('clear button', () => {
    it('is visible when text exists', () => {
      render(<ComposerInput {...defaultProps} value="hello" onClear={vi.fn()} />);
      expect(screen.getByLabelText('Clear message')).toBeDefined();
      const btn = screen.getByLabelText('Clear message');
      expect(btn.className).not.toContain('pointer-events-none');
    });

    it('is hidden when empty', () => {
      render(<ComposerInput {...defaultProps} value="" onClear={vi.fn()} />);
      const btn = screen.getByLabelText('Clear message');
      expect(btn.className).toContain('pointer-events-none');
    });

    it('is visible during streaming (clear works while agent responds)', () => {
      render(
        <ComposerInput {...defaultProps} value="hello" isStreaming={true} onClear={vi.fn()} />
      );
      const btn = screen.getByLabelText('Clear message');
      expect(btn.className).not.toContain('pointer-events-none');
    });

    it('calls onClear when clicked', () => {
      const onClear = vi.fn();
      render(<ComposerInput {...defaultProps} value="hello" onClear={onClear} />);
      fireEvent.click(screen.getByLabelText('Clear message'));
      expect(onClear).toHaveBeenCalledOnce();
    });

    // The dashboard and onboarding composers wire no onClear. The X rendered
    // anyway — half opacity, enabled, tab-reachable, onClick undefined.
    it('is not rendered at all when no onClear is wired', () => {
      render(<ComposerInput {...defaultProps} value="hello" />);
      expect(screen.queryByLabelText('Clear message')).toBeNull();
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
    it('first Escape calls onEscape, not onClear', () => {
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
      fireEvent.keyDown(screen.getByRole('combobox'), { key: 'Escape' });
      expect(onEscape).toHaveBeenCalledOnce();
      expect(onClear).not.toHaveBeenCalled();
    });

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

    it('selects the whole draft before wiping it, so nothing survives the edit', () => {
      stubExecCommandWithInputEvent();
      const { textarea } = renderControlled({
        initialValue: 'one\ntwo',
        onSubmit: vi.fn(),
        isStreaming: false,
        onClear: vi.fn(),
      });
      textarea.setSelectionRange(0, 0);
      fireEvent.keyDown(textarea, { key: 'Escape' });
      fireEvent.keyDown(textarea, { key: 'Escape' });
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

    it('calls onEscape when palette open (even with text)', () => {
      const onClear = vi.fn();
      const onEscape = vi.fn();
      render(
        <ComposerInput
          {...defaultProps}
          value="hello"
          isPaletteOpen={true}
          onClear={onClear}
          onEscape={onEscape}
        />
      );
      fireEvent.keyDown(screen.getByRole('combobox'), { key: 'Escape' });
      expect(onEscape).toHaveBeenCalledOnce();
      expect(onClear).not.toHaveBeenCalled();
    });

    it('calls onEscape when palette closed and text is empty', () => {
      const onClear = vi.fn();
      const onEscape = vi.fn();
      render(
        <ComposerInput
          {...defaultProps}
          value=""
          isPaletteOpen={false}
          onClear={onClear}
          onEscape={onEscape}
        />
      );
      const combobox = screen.getByRole('combobox');
      fireEvent.keyDown(combobox, { key: 'Escape' });
      fireEvent.keyDown(combobox, { key: 'Escape' });
      expect(onEscape).toHaveBeenCalledTimes(2);
      expect(onClear).not.toHaveBeenCalled();
    });
  });

  describe('blur handling', () => {
    it('calls onEscape on blur when palette is open', () => {
      const onEscape = vi.fn();
      render(<ComposerInput {...defaultProps} isPaletteOpen={true} onEscape={onEscape} />);
      fireEvent.blur(screen.getByRole('combobox'));
      expect(onEscape).toHaveBeenCalledOnce();
    });

    it('does not call onEscape on blur when palette is closed', () => {
      const onEscape = vi.fn();
      render(<ComposerInput {...defaultProps} isPaletteOpen={false} onEscape={onEscape} />);
      fireEvent.blur(screen.getByRole('combobox'));
      expect(onEscape).not.toHaveBeenCalled();
    });
  });

  describe('canSubmit state', () => {
    it('disables the send button when canSubmit is false (target not ready)', () => {
      render(<ComposerInput {...defaultProps} value="hello" canSubmit={false} />);
      const btn = screen.getByLabelText('Send message');
      expect(btn).toHaveProperty('disabled', true);
      expect(btn.className).toContain('pointer-events-none');
    });

    it('keeps the input typeable when canSubmit is false', () => {
      render(<ComposerInput {...defaultProps} canSubmit={false} />);
      expect(screen.getByRole('combobox')).toHaveProperty('disabled', false);
    });

    it('does not show a busy message when canSubmit is false', () => {
      render(<ComposerInput {...defaultProps} value="hello" canSubmit={false} />);
      expect(screen.queryByText(/still finishing/)).toBeNull();
    });

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

    it('submits on Enter when canSubmit is true (default)', () => {
      const onSubmit = vi.fn();
      render(<ComposerInput {...defaultProps} value="hello" onSubmit={onSubmit} />);
      fireEvent.keyDown(screen.getByRole('combobox'), { key: 'Enter' });
      expect(onSubmit).toHaveBeenCalledOnce();
    });

    it('enables the send button by default (canSubmit defaults to true)', () => {
      const onSubmit = vi.fn();
      render(<ComposerInput {...defaultProps} value="hello" onSubmit={onSubmit} />);
      const btn = screen.getByLabelText('Send message');
      expect(btn).toHaveProperty('disabled', false);
      fireEvent.click(btn);
      expect(onSubmit).toHaveBeenCalledOnce();
    });
  });

  describe('queue button states', () => {
    it('send button shows Queue icon during streaming with text', () => {
      render(<ComposerInput {...defaultProps} isStreaming={true} value="text" onQueue={vi.fn()} />);
      expect(screen.getByLabelText('Queue message')).toBeDefined();
    });

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

    it('send button shows Stop icon during streaming without text', () => {
      render(<ComposerInput {...defaultProps} isStreaming={true} value="" onStop={vi.fn()} />);
      expect(screen.getByLabelText('Stop generating')).toBeDefined();
    });

    it('queue badge renders with correct count', () => {
      render(<ComposerInput {...defaultProps} isStreaming={true} value="text" queueDepth={3} />);
      expect(screen.getByText('3')).toBeDefined();
    });

    it('queue badge not rendered when queueDepth is 0', () => {
      render(<ComposerInput {...defaultProps} isStreaming={true} value="text" queueDepth={0} />);
      expect(screen.queryByText('0')).toBeNull();
    });

    it('editing label names which message is being rewritten', () => {
      render(
        <ComposerInput
          {...defaultProps}
          editingQueueItem={true}
          editingPosition={2}
          queueDepth={3}
          value="text"
        />
      );
      expect(screen.getByText('Editing message 2 of 3')).toBeInTheDocument();
    });

    it('falls back to a bare label when the position is unknown', () => {
      render(<ComposerInput {...defaultProps} editingQueueItem={true} value="text" />);
      expect(screen.getByText('Editing message')).toBeInTheDocument();
    });

    it('editing border applied when editingQueueItem is true', () => {
      // `.toBeDefined()` passed on a `null` querySelector — deleting the border
      // left the test green. `null` is defined; only `undefined` is not.
      const { container } = render(<ComposerInput {...defaultProps} editingQueueItem={true} />);
      expect(container.querySelector('.border-primary\\/40')).not.toBeNull();
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

    it('Up arrow does NOT navigate when queue is empty', () => {
      const onQueueNavigateUp = vi.fn();
      render(
        <ComposerInput
          {...defaultProps}
          queueHasItems={false}
          value=""
          onQueueNavigateUp={onQueueNavigateUp}
        />
      );
      fireEvent.keyDown(screen.getByRole('combobox'), { key: 'ArrowUp' });
      expect(onQueueNavigateUp).not.toHaveBeenCalled();
    });

    it('Down arrow does NOT navigate when not editing queue item', () => {
      const onQueueNavigateDown = vi.fn();
      render(
        <ComposerInput
          {...defaultProps}
          queueHasItems={true}
          editingQueueItem={false}
          onQueueNavigateDown={onQueueNavigateDown}
        />
      );
      fireEvent.keyDown(screen.getByRole('combobox'), { key: 'ArrowDown' });
      expect(onQueueNavigateDown).not.toHaveBeenCalled();
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

    it('Escape does NOT cancel edit when not editing', () => {
      const onCancelEdit = vi.fn();
      const onEscape = vi.fn();
      render(
        <ComposerInput
          {...defaultProps}
          editingQueueItem={false}
          onCancelEdit={onCancelEdit}
          onEscape={onEscape}
        />
      );
      fireEvent.keyDown(screen.getByRole('combobox'), { key: 'Escape' });
      expect(onEscape).toHaveBeenCalled();
      expect(onCancelEdit).not.toHaveBeenCalled();
    });
  });

  describe('IME composition guard', () => {
    it('does not submit on the Enter that commits an IME candidate', () => {
      const onSubmit = vi.fn();
      render(<ComposerInput {...defaultProps} value="こん" onSubmit={onSubmit} />);
      fireEvent.keyDown(screen.getByRole('combobox'), { key: 'Enter', isComposing: true });
      expect(onSubmit).not.toHaveBeenCalled();
    });

    it('honours the legacy keyCode 229 signal', () => {
      const onSubmit = vi.fn();
      render(<ComposerInput {...defaultProps} value="こん" onSubmit={onSubmit} />);
      fireEvent.keyDown(screen.getByRole('combobox'), { key: 'Enter', keyCode: 229 });
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

    // The event's flags are not the only signal. A rich-text editor keeps its own
    // composition state and can be mid-candidate on a keydown that looks clear,
    // so the ladder asks the surface too — and a send on that keystroke would be
    // a half-typed message.
    it('does not submit when the surface reports a composition the event did not', () => {
      surfaceComposing.current = true;
      const onSubmit = vi.fn();
      render(<ComposerInput {...defaultProps} value="こん" onSubmit={onSubmit} />);
      fireEvent.keyDown(screen.getByRole('combobox'), { key: 'Enter' });
      expect(onSubmit).not.toHaveBeenCalled();
    });

    it('submits once the composition has ended', () => {
      const onSubmit = vi.fn();
      render(<ComposerInput {...defaultProps} value="こん" onSubmit={onSubmit} />);
      const combobox = screen.getByRole('combobox');
      fireEvent.keyDown(combobox, { key: 'Enter', isComposing: true });
      fireEvent.keyDown(combobox, { key: 'Enter' });
      expect(onSubmit).toHaveBeenCalledOnce();
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

    it('edits through execCommand so the native undo stack survives', () => {
      const exec = stubExecCommandWithInputEvent();
      const { textarea, hostValue } = renderControlled({
        ...controlledDefaults,
        initialValue: 'foo\\',
      });
      fireEvent.keyDown(textarea, { key: 'Enter' });
      expect(exec).toHaveBeenCalledWith('insertText', false, '\n');
    });

    it('submits on an escaped literal backslash (even run)', () => {
      stubExecCommandWithInputEvent();
      const onSubmit = vi.fn();
      const { textarea, hostValue } = renderControlled({
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

    it('submits when the backslash does not touch the caret', () => {
      stubExecCommandWithInputEvent();
      const onSubmit = vi.fn();
      const { textarea, hostValue } = renderControlled({
        ...controlledDefaults,
        initialValue: 'foo\\ ',
        onSubmit,
      });
      fireEvent.keyDown(textarea, { key: 'Enter' });
      expect(onSubmit).toHaveBeenCalledOnce();
    });

    it('requires a collapsed caret', () => {
      stubExecCommandWithInputEvent();
      const onSubmit = vi.fn();
      const { textarea, hostValue } = renderControlled({
        ...controlledDefaults,
        initialValue: 'foo\\',
        onSubmit,
      });
      textarea.setSelectionRange(0, 4);
      fireEvent.keyDown(textarea, { key: 'Enter' });
      expect(onSubmit).toHaveBeenCalledOnce();
    });

    it('works mid-prompt, at the caret rather than at the end of the value', () => {
      stubExecCommandWithInputEvent();
      const onSubmit = vi.fn();
      const { textarea, hostValue } = renderControlled(
        { ...controlledDefaults, initialValue: 'foo\\bar', onSubmit },
        4
      );
      fireEvent.keyDown(textarea, { key: 'Enter' });
      expect(onSubmit).not.toHaveBeenCalled();
      expect(textarea.value).toBe('foo\nbar');
      expect(hostValue()).toBe('foo\nbar');
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

    it('never saves a queue-item edit', () => {
      stubExecCommandWithInputEvent();
      const onSaveEdit = vi.fn();
      const { textarea, hostValue } = renderControlled({
        ...controlledDefaults,
        initialValue: 'foo\\',
        editingQueueItem: true,
        onSaveEdit,
      });
      fireEvent.keyDown(textarea, { key: 'Enter' });
      expect(onSaveEdit).not.toHaveBeenCalled();
      expect(textarea.value).toBe('foo\n');
      expect(hostValue()).toBe('foo\n');
    });

    it('eats the backslash on mobile too, so the text matches every platform', () => {
      device = PHONE;
      const exec = stubExecCommandWithInputEvent();
      const { textarea, hostValue } = renderControlled({
        ...controlledDefaults,
        initialValue: 'foo\\',
      });
      fireEvent.keyDown(textarea, { key: 'Enter' });
      expect(exec).toHaveBeenCalledWith('insertText', false, '\n');
      expect(textarea.value).toBe('foo\n');
      expect(hostValue()).toBe('foo\n');
    });

    it('leaves the backslash alone on Shift+Enter (already a newline)', () => {
      const exec = stubExecCommandWithInputEvent();
      const { textarea, hostValue } = renderControlled({
        ...controlledDefaults,
        initialValue: 'foo\\',
      });
      fireEvent.keyDown(textarea, { key: 'Enter', shiftKey: true });
      expect(exec).not.toHaveBeenCalled();
      expect(textarea.value).toBe('foo\\');
    });

    it('does not fire during an IME composition', () => {
      const exec = stubExecCommandWithInputEvent();
      const { textarea, hostValue } = renderControlled({
        ...controlledDefaults,
        initialValue: 'foo\\',
      });
      fireEvent.keyDown(textarea, { key: 'Enter', isComposing: true });
      expect(exec).not.toHaveBeenCalled();
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

    it('does not pick a palette entry', () => {
      stubExecCommandWithInputEvent();
      const onCommandSelect = vi.fn();
      const { textarea, hostValue } = renderControlled({
        ...controlledDefaults,
        initialValue: '/dai',
        isPaletteOpen: true,
        paletteHasResults: true,
        onCommandSelect,
      });
      fireEvent.keyDown(textarea, { key: 'Enter', altKey: true });
      expect(onCommandSelect).not.toHaveBeenCalled();
      expect(textarea.value).toBe('/dai\n');
      expect(hostValue()).toBe('/dai\n');
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

    it('does not arm the draft wipe when Escape closed a palette', () => {
      const onClear = vi.fn();
      const onEscape = vi.fn();
      const { rerender } = render(
        <ComposerInput
          {...defaultProps}
          value="hello"
          isPaletteOpen={true}
          onClear={onClear}
          onEscape={onEscape}
        />
      );
      fireEvent.keyDown(screen.getByRole('combobox'), { key: 'Escape' });
      rerender(
        <ComposerInput
          {...defaultProps}
          value="hello"
          isPaletteOpen={false}
          onClear={onClear}
          onEscape={onEscape}
        />
      );
      fireEvent.keyDown(screen.getByRole('combobox'), { key: 'Escape' });
      expect(onClear).not.toHaveBeenCalled();
      expect(onEscape).toHaveBeenCalledTimes(2);
    });

    it('still clears on two bare escapes after a palette dismiss', () => {
      stubExecCommand();
      const onClear = vi.fn();
      const { rerender } = render(
        <ComposerInput {...defaultProps} value="hello" isPaletteOpen={true} onClear={onClear} />
      );
      const combobox = screen.getByRole('combobox');
      fireEvent.keyDown(combobox, { key: 'Escape' });
      rerender(
        <ComposerInput {...defaultProps} value="hello" isPaletteOpen={false} onClear={onClear} />
      );
      fireEvent.keyDown(combobox, { key: 'Escape' });
      fireEvent.keyDown(combobox, { key: 'Escape' });
      expect(onClear).toHaveBeenCalledOnce();
    });
  });

  describe('the armed-to-clear signal', () => {
    /**
     * ComposerInput owns WHEN the double-Escape is armed; ChatInputContainer owns
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

    it('is down until the first Escape raises it', () => {
      render(<ComposerInput {...armable()} />);
      expect(isArmed()).toBe(false);
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

    it('comes down when the second Escape does the clearing', () => {
      const props = armable();
      render(<ComposerInput {...props} />);
      const combobox = screen.getByRole('combobox');
      fireEvent.keyDown(combobox, { key: 'Escape' });
      fireEvent.keyDown(combobox, { key: 'Escape' });
      expect(props.onClear).toHaveBeenCalledOnce();
      expect(isArmed()).toBe(false);
    });

    it('stays down on an empty composer, where a second Escape would clear nothing', () => {
      render(<ComposerInput {...armable()} value="" />);
      fireEvent.keyDown(screen.getByRole('combobox'), { key: 'Escape' });
      expect(isArmed()).toBe(false);
    });

    it('stays down when the Escape only dismissed a palette', () => {
      // That Escape deliberately does not arm the clear, so advertising it would
      // promise a keystroke that does nothing.
      render(<ComposerInput {...armable()} isPaletteOpen={true} />);
      fireEvent.keyDown(screen.getByRole('combobox'), { key: 'Escape' });
      expect(isArmed()).toBe(false);
    });

    it('stays down while streaming, where Escape stops the turn instead', () => {
      render(<ComposerInput {...armable()} isStreaming={true} onStop={vi.fn()} />);
      fireEvent.keyDown(screen.getByRole('combobox'), { key: 'Escape' });
      expect(isArmed()).toBe(false);
    });

    it('stays down on a host that wires no onClear, where no clear button exists', () => {
      // The dashboard and onboarding composers pass no `onClear`, so the
      // labelled X is not rendered at all — while Escape-Escape still wipes the
      // draft. A readout that assistive tech is told to ignore would hand
      // sighted people a destructive shortcut and nobody else, so the arm is
      // never raised where the equal alternative is missing.
      render(<ComposerInput {...armable()} onClear={undefined} />);
      fireEvent.keyDown(screen.getByRole('combobox'), { key: 'Escape' });

      expect(screen.queryByLabelText('Clear message')).toBeNull();
      expect(isArmed()).toBe(false);
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

  describe('the action-button slot', () => {
    it('is held open at rest by a spacer with the button’s own box', () => {
      // The button used to appear with the first keystroke, so the composer's
      // right edge — and the text you were typing — jumped sideways exactly as
      // you started. jsdom reports every element as 0×0, so this pins that the
      // spacer exists and is built from the same padding and icon-size tokens
      // the button uses; the measured offset is in the PR's browser evidence.
      const { rerender } = render(<ComposerInput {...defaultProps} value="" />);

      const spacer = screen.getByTestId('action-slot-spacer');
      expect(screen.queryByLabelText('Send message')).toBeNull();
      expect(spacer.className).toContain('p-1.5');
      expect(spacer.firstElementChild!.className).toContain('size-(--size-icon-sm)');

      rerender(<ComposerInput {...defaultProps} value="h" />);

      expect(screen.queryByTestId('action-slot-spacer')).toBeNull();
      const button = screen.getByLabelText('Send message');
      expect(button.className).toContain('p-1.5');
      // The glyph is an <svg>, whose `className` is an SVGAnimatedString.
      expect(button.querySelector('svg')!.getAttribute('class')).toContain('size-(--size-icon-sm)');
    });
  });

  describe('keyboard focus rings', () => {
    it('gives every composer control a visible focus ring', () => {
      render(
        <ComposerInput {...defaultProps} value="hello" onAttach={vi.fn()} onClear={vi.fn()} />
      );
      for (const name of ['Attach file', 'Clear message', 'Send message']) {
        expect(screen.getByLabelText(name).className).toContain('focus-ring');
      }
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

    it('still focuses on touch through the unguarded focus() — a deliberate tap', () => {
      device = PHONE;
      const ref = createRef<ComposerInputHandle>();
      render(<ComposerInput {...defaultProps} ref={ref} />);
      act(() => ref.current!.focus());
      expect(document.activeElement).toBe(screen.getByRole('combobox'));
    });

    // Gating this on viewport width instead would take focus away from a
    // desktop window dragged narrow — no software keyboard, nothing to guard
    // against, and the same mistake the Enter rule is being fixed for.
    it('focuses a narrow desktop window, which has no software keyboard', () => {
      device = NARROW_DESKTOP;
      const ref = createRef<ComposerInputHandle>();
      render(<ComposerInput {...defaultProps} ref={ref} />);
      screen.getByRole('combobox').blur();
      act(() => ref.current!.focusUnlessTouch());
      expect(document.activeElement).toBe(screen.getByRole('combobox'));
    });

    it('focuses a tablet with a trackpad', () => {
      device = TABLET_WITH_TRACKPAD;
      const ref = createRef<ComposerInputHandle>();
      render(<ComposerInput {...defaultProps} ref={ref} />);
      screen.getByRole('combobox').blur();
      act(() => ref.current!.focusUnlessTouch());
      expect(document.activeElement).toBe(screen.getByRole('combobox'));
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

    // THE regression this rule exists for: a window dragged beside an editor is
    // under the old 768px breakpoint but still has a keyboard and a mouse.
    it('still sends in a desktop window dragged under 768px', () => {
      device = NARROW_DESKTOP;
      expect(pressEnter().submitted).toBe(true);
    });

    // iPadOS reports a coarse primary pointer with a Magic Keyboard attached.
    // A bare `(pointer: coarse)` rule took Enter-to-send away from it, with no
    // setting to get it back.
    it('sends on a tablet with a trackpad attached', () => {
      device = TABLET_WITH_TRACKPAD;
      expect(pressEnter().submitted).toBe(true);
    });

    it('inserts a newline on a phone rather than sending', () => {
      device = PHONE;
      const { submitted } = pressEnter();
      expect(submitted).toBe(false);
    });
  });

  describe('editing a queued item with an emptied field', () => {
    // Select-all + delete used to leave NO button rendered while the banner
    // still read "Editing message". Desktop Escape rescued it; a phone has no
    // Escape key, so the only exit was the row's X, which deletes the message.
    it('offers an explicit cancel instead of no button at all', () => {
      render(<ComposerInput {...defaultProps} editingQueueItem={true} value="" />);
      expect(screen.getByLabelText('Cancel edit')).toBeDefined();
    });

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

    it('goes back to Save edit as soon as there is text again', () => {
      render(<ComposerInput {...defaultProps} editingQueueItem={true} value="rewritten" />);
      expect(screen.getByLabelText('Save edit')).toBeDefined();
      expect(screen.queryByLabelText('Cancel edit')).toBeNull();
    });
  });

  describe('attachment upload in flight', () => {
    it('shows the upload rather than a Stop with no turn to stop', () => {
      render(
        <ComposerInput
          {...defaultProps}
          value="here you go"
          isUploading={true}
          onCancelUpload={vi.fn()}
        />
      );
      expect(screen.queryByLabelText('Stop generating')).toBeNull();
      expect(screen.queryByLabelText('Send message')).toBeNull();
    });

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
      it('makes the progress spinner the control that cancels', () => {
        const onCancelUpload = vi.fn();
        render(
          <ComposerInput
            {...defaultProps}
            value="here you go"
            isUploading={true}
            onCancelUpload={onCancelUpload}
          />
        );
        fireEvent.click(screen.getByRole('button', { name: 'Cancel upload' }));
        expect(onCancelUpload).toHaveBeenCalledOnce();
      });

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

      // The control says what pressing it DOES; the live region says what is
      // HAPPENING. Losing the second one is invisible to anyone watching the
      // screen and total for anyone who is not.
      it('still announces the upload through a live region', () => {
        render(
          <ComposerInput
            {...defaultProps}
            value="here you go"
            isUploading={true}
            onCancelUpload={vi.fn()}
          />
        );
        expect(screen.getByRole('status')).toHaveTextContent('Uploading attachment');
        expect(screen.getByRole('button', { name: 'Cancel upload' })).toBeVisible();
      });
    });

    // A host that reports an upload it cannot stop gets no progress control at
    // all. The inert spinner it used to get was the wedge in miniature: a
    // control-shaped thing with nothing behind it.
    it('shows no upload control when the host offers no cancel', () => {
      render(<ComposerInput {...defaultProps} value="here you go" isUploading={true} />);
      expect(screen.queryByRole('button', { name: /upload/i })).toBeNull();
      expect(screen.queryByRole('status')).toBeNull();
      expect(screen.getByLabelText('Send message')).toBeVisible();
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

    it('does not queue again on Enter mid-stream', () => {
      const onQueue = vi.fn();
      render(
        <ComposerInput
          {...defaultProps}
          value="/compact the api bits"
          isStreaming
          commandPending
          onQueue={onQueue}
        />
      );
      fireEvent.keyDown(screen.getByRole('combobox'), { key: 'Enter' });
      expect(onQueue).not.toHaveBeenCalled();
    });

    it('shows the dispatch instead of a control that would re-fire it', () => {
      render(
        <ComposerInput {...defaultProps} value="/compact the api bits" isStreaming commandPending />
      );
      const status = screen.getByRole('status');
      expect(status).toHaveTextContent('Running command');
      expect(screen.queryByLabelText('Queue message')).toBeNull();
      expect(screen.queryByLabelText('Send message')).toBeNull();
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

    it('says nothing once the send target is ready', () => {
      render(
        <ComposerInput
          {...defaultProps}
          value="hello"
          canSubmitReason="Getting your agent ready…"
        />
      );
      expect(screen.queryByText('Getting your agent ready…')).toBeNull();
    });
  });
});
