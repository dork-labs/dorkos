// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach, beforeEach, beforeAll } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import { ChatInput } from '../ui/input/ChatInput';

/** Flipped by the mobile tests; read by the `matchMedia` mock below. */
let isMobileViewport = false;

beforeAll(() => {
  Object.defineProperty(window, 'matchMedia', {
    writable: true,
    value: vi.fn().mockImplementation((query: string) => ({
      matches: isMobileViewport,
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

/** Render the composer and place a collapsed caret at `caret` (default: end of value). */
function renderWithCaret(props: Parameters<typeof ChatInput>[0], caret?: number) {
  const view = render(<ChatInput {...props} />);
  const textarea = screen.getByRole('combobox') as HTMLTextAreaElement;
  textarea.focus();
  const pos = caret ?? textarea.value.length;
  textarea.setSelectionRange(pos, pos);
  return { ...view, textarea };
}

beforeEach(() => {
  isMobileViewport = false;
});

afterEach(() => {
  cleanup();
});

describe('ChatInput', () => {
  const defaultProps = {
    value: '',
    onChange: vi.fn(),
    onSubmit: vi.fn(),
    isStreaming: false,
  };

  it('renders textarea with placeholder', () => {
    render(<ChatInput {...defaultProps} />);
    expect(screen.getByPlaceholderText(/Send a message/)).toBeDefined();
  });

  it('renders custom placeholder when provided', () => {
    render(<ChatInput {...defaultProps} placeholder="Compose next" />);
    expect(screen.getByPlaceholderText('Compose next')).toBeDefined();
  });

  it('uses default placeholder when not provided', () => {
    render(<ChatInput {...defaultProps} />);
    expect(screen.getByPlaceholderText('Send a message...')).toBeDefined();
  });

  it('calls onChange when typing', () => {
    const onChange = vi.fn();
    render(<ChatInput {...defaultProps} onChange={onChange} />);
    fireEvent.change(screen.getByRole('combobox'), { target: { value: 'hello' } });
    expect(onChange).toHaveBeenCalledWith('hello');
  });

  it('calls onSubmit on Enter key when value is non-empty', () => {
    const onSubmit = vi.fn();
    render(<ChatInput {...defaultProps} value="hello" onSubmit={onSubmit} />);
    fireEvent.keyDown(screen.getByRole('combobox'), { key: 'Enter' });
    expect(onSubmit).toHaveBeenCalled();
  });

  it('does not submit on Shift+Enter', () => {
    const onSubmit = vi.fn();
    render(<ChatInput {...defaultProps} value="hello" onSubmit={onSubmit} />);
    fireEvent.keyDown(screen.getByRole('combobox'), { key: 'Enter', shiftKey: true });
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it('does not submit when value is empty', () => {
    const onSubmit = vi.fn();
    render(<ChatInput {...defaultProps} value="" onSubmit={onSubmit} />);
    fireEvent.keyDown(screen.getByRole('combobox'), { key: 'Enter' });
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it('does not submit when streaming', () => {
    const onSubmit = vi.fn();
    render(<ChatInput {...defaultProps} value="hello" isStreaming={true} onSubmit={onSubmit} />);
    fireEvent.keyDown(screen.getByRole('combobox'), { key: 'Enter' });
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it('does NOT disable textarea when streaming', () => {
    render(<ChatInput {...defaultProps} isStreaming={true} />);
    expect(screen.getByRole('combobox')).toHaveProperty('disabled', false);
  });

  it('textarea is NOT disabled during streaming', () => {
    render(<ChatInput {...defaultProps} isStreaming={true} />);
    expect(screen.getByRole('combobox')).toHaveProperty('disabled', false);
  });

  it('textarea stays typeable when sessionBusy is true', () => {
    render(<ChatInput {...defaultProps} sessionBusy={true} />);
    expect(screen.getByRole('combobox')).toHaveProperty('disabled', false);
  });

  it('shows stop button when streaming (no text)', () => {
    render(<ChatInput {...defaultProps} isStreaming={true} onStop={vi.fn()} />);
    expect(screen.getByLabelText('Stop generating')).toBeDefined();
  });

  it('shows send button when not streaming and has text', () => {
    render(<ChatInput {...defaultProps} value="hello" />);
    expect(screen.getByLabelText('Send message')).toBeDefined();
  });

  it('hides send button when value is empty', () => {
    render(<ChatInput {...defaultProps} value="" />);
    // No visible button when hidden state — check button is not displayed or is disabled
    // The button is rendered with opacity 0 and pointer-events-none
    const btn = screen.queryByLabelText('Send message');
    // In hidden state, no aria-label matches any active button
    expect(btn).toBeNull();
  });

  it('shows send button when value is non-empty', () => {
    render(<ChatInput {...defaultProps} value="hello" />);
    expect(screen.getByLabelText('Send message')).toBeDefined();
  });

  it('calls onStop when stop button is clicked', () => {
    const onStop = vi.fn();
    render(<ChatInput {...defaultProps} isStreaming={true} onStop={onStop} />);
    fireEvent.click(screen.getByLabelText('Stop generating'));
    expect(onStop).toHaveBeenCalled();
  });

  it('calls onEscape when Escape pressed', () => {
    const onEscape = vi.fn();
    render(<ChatInput {...defaultProps} onEscape={onEscape} />);
    fireEvent.keyDown(screen.getByRole('combobox'), { key: 'Escape' });
    expect(onEscape).toHaveBeenCalled();
  });

  it('paperclip button is NOT disabled during streaming', () => {
    const onAttach = vi.fn();
    render(<ChatInput {...defaultProps} isStreaming={true} onAttach={onAttach} />);
    const btn = screen.getByLabelText('Attach file');
    expect(btn).not.toHaveProperty('disabled', true);
  });

  it('clear button works during streaming', () => {
    render(<ChatInput {...defaultProps} value="hello" isStreaming={true} />);
    const btn = screen.getByLabelText('Clear message');
    expect(btn.className).not.toContain('pointer-events-none');
  });

  describe('palette-open keyboard handling', () => {
    it('calls onArrowDown when ArrowDown pressed and palette open', () => {
      const onArrowDown = vi.fn();
      render(<ChatInput {...defaultProps} isPaletteOpen={true} onArrowDown={onArrowDown} />);
      fireEvent.keyDown(screen.getByRole('combobox'), { key: 'ArrowDown' });
      expect(onArrowDown).toHaveBeenCalledOnce();
    });

    it('calls onArrowUp when ArrowUp pressed and palette open', () => {
      const onArrowUp = vi.fn();
      render(<ChatInput {...defaultProps} isPaletteOpen={true} onArrowUp={onArrowUp} />);
      fireEvent.keyDown(screen.getByRole('combobox'), { key: 'ArrowUp' });
      expect(onArrowUp).toHaveBeenCalledOnce();
    });

    it('calls onCommandSelect on Enter when palette open', () => {
      const onCommandSelect = vi.fn();
      const onSubmit = vi.fn();
      render(
        <ChatInput
          {...defaultProps}
          value="/daily"
          isPaletteOpen={true}
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
        <ChatInput {...defaultProps} isPaletteOpen={true} onCommandSelect={onCommandSelect} />
      );
      fireEvent.keyDown(screen.getByRole('combobox'), { key: 'Tab' });
      expect(onCommandSelect).toHaveBeenCalledOnce();
    });

    it('calls onEscape on Escape when palette open', () => {
      const onEscape = vi.fn();
      render(<ChatInput {...defaultProps} isPaletteOpen={true} onEscape={onEscape} />);
      fireEvent.keyDown(screen.getByRole('combobox'), { key: 'Escape' });
      expect(onEscape).toHaveBeenCalledOnce();
    });

    it('does not call onCommandSelect on Shift+Enter when palette open', () => {
      const onCommandSelect = vi.fn();
      render(
        <ChatInput {...defaultProps} isPaletteOpen={true} onCommandSelect={onCommandSelect} />
      );
      fireEvent.keyDown(screen.getByRole('combobox'), { key: 'Enter', shiftKey: true });
      expect(onCommandSelect).not.toHaveBeenCalled();
    });
  });

  describe('palette-closed keyboard regression', () => {
    it('does not call onArrowDown when ArrowDown pressed and palette closed', () => {
      const onArrowDown = vi.fn();
      render(<ChatInput {...defaultProps} isPaletteOpen={false} onArrowDown={onArrowDown} />);
      fireEvent.keyDown(screen.getByRole('combobox'), { key: 'ArrowDown' });
      expect(onArrowDown).not.toHaveBeenCalled();
    });

    it('calls onSubmit on Enter when palette closed (not onCommandSelect)', () => {
      const onSubmit = vi.fn();
      const onCommandSelect = vi.fn();
      render(
        <ChatInput
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
      render(<ChatInput {...defaultProps} />);
      expect(screen.getByRole('combobox')).toBeDefined();
    });

    it('has aria-expanded true when palette open', () => {
      render(<ChatInput {...defaultProps} isPaletteOpen={true} />);
      expect(screen.getByRole('combobox').getAttribute('aria-expanded')).toBe('true');
    });

    it('has aria-expanded false when palette closed', () => {
      render(<ChatInput {...defaultProps} isPaletteOpen={false} />);
      expect(screen.getByRole('combobox').getAttribute('aria-expanded')).toBe('false');
    });

    it('has aria-expanded false by default (no isPaletteOpen)', () => {
      render(<ChatInput {...defaultProps} />);
      expect(screen.getByRole('combobox').getAttribute('aria-expanded')).toBe('false');
    });

    it('has aria-activedescendant when palette open with activeDescendantId', () => {
      render(
        <ChatInput {...defaultProps} isPaletteOpen={true} activeDescendantId="command-item-2" />
      );
      expect(screen.getByRole('combobox').getAttribute('aria-activedescendant')).toBe(
        'command-item-2'
      );
    });

    it('does not have aria-activedescendant when palette closed', () => {
      render(
        <ChatInput {...defaultProps} isPaletteOpen={false} activeDescendantId="command-item-2" />
      );
      expect(screen.getByRole('combobox').getAttribute('aria-activedescendant')).toBeNull();
    });

    it('has aria-controls pointing to command palette listbox when palette is open', () => {
      render(
        <ChatInput {...defaultProps} isPaletteOpen={true} activeDescendantId="command-item-0" />
      );
      expect(screen.getByRole('combobox').getAttribute('aria-controls')).toBe(
        'command-palette-listbox'
      );
    });

    it('has no aria-controls when palette is closed', () => {
      render(<ChatInput {...defaultProps} />);
      expect(screen.getByRole('combobox').getAttribute('aria-controls')).toBeNull();
    });

    it('has aria-autocomplete set to list', () => {
      render(<ChatInput {...defaultProps} />);
      expect(screen.getByRole('combobox').getAttribute('aria-autocomplete')).toBe('list');
    });
  });

  describe('clear button', () => {
    it('is visible when text exists', () => {
      render(<ChatInput {...defaultProps} value="hello" />);
      expect(screen.getByLabelText('Clear message')).toBeDefined();
      const btn = screen.getByLabelText('Clear message');
      expect(btn.className).not.toContain('pointer-events-none');
    });

    it('is hidden when empty', () => {
      render(<ChatInput {...defaultProps} value="" />);
      const btn = screen.getByLabelText('Clear message');
      expect(btn.className).toContain('pointer-events-none');
    });

    it('is visible during streaming (clear works while agent responds)', () => {
      render(<ChatInput {...defaultProps} value="hello" isStreaming={true} />);
      const btn = screen.getByLabelText('Clear message');
      expect(btn.className).not.toContain('pointer-events-none');
    });

    it('calls onClear when clicked', () => {
      const onClear = vi.fn();
      render(<ChatInput {...defaultProps} value="hello" onClear={onClear} />);
      fireEvent.click(screen.getByLabelText('Clear message'));
      expect(onClear).toHaveBeenCalledOnce();
    });
  });

  describe('escape clears text (double-escape)', () => {
    it('first Escape calls onEscape, not onClear', () => {
      const onClear = vi.fn();
      const onEscape = vi.fn();
      render(
        <ChatInput
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
      const onClear = vi.fn();
      const onEscape = vi.fn();
      render(
        <ChatInput
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

    it('second Escape after 500ms does not call onClear', () => {
      vi.useFakeTimers();
      const onClear = vi.fn();
      const onEscape = vi.fn();
      render(
        <ChatInput
          {...defaultProps}
          value="hello"
          isPaletteOpen={false}
          onClear={onClear}
          onEscape={onEscape}
        />
      );
      const combobox = screen.getByRole('combobox');
      fireEvent.keyDown(combobox, { key: 'Escape' });
      vi.advanceTimersByTime(600);
      fireEvent.keyDown(combobox, { key: 'Escape' });
      expect(onClear).not.toHaveBeenCalled();
      expect(onEscape).toHaveBeenCalledTimes(2);
      vi.useRealTimers();
    });

    it('calls onEscape when palette open (even with text)', () => {
      const onClear = vi.fn();
      const onEscape = vi.fn();
      render(
        <ChatInput
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
        <ChatInput
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
      render(<ChatInput {...defaultProps} isPaletteOpen={true} onEscape={onEscape} />);
      fireEvent.blur(screen.getByRole('combobox'));
      expect(onEscape).toHaveBeenCalledOnce();
    });

    it('does not call onEscape on blur when palette is closed', () => {
      const onEscape = vi.fn();
      render(<ChatInput {...defaultProps} isPaletteOpen={false} onEscape={onEscape} />);
      fireEvent.blur(screen.getByRole('combobox'));
      expect(onEscape).not.toHaveBeenCalled();
    });
  });

  describe('sessionBusy state', () => {
    it('never disables the textarea — disabling drops the caret with no restore', () => {
      render(<ChatInput {...defaultProps} sessionBusy={true} />);
      expect(screen.getByRole('combobox')).toHaveProperty('disabled', false);
    });

    it('does not submit on Enter when sessionBusy is true', () => {
      const onSubmit = vi.fn();
      render(<ChatInput {...defaultProps} value="hello" sessionBusy={true} onSubmit={onSubmit} />);
      fireEvent.keyDown(screen.getByRole('combobox'), { key: 'Enter' });
      expect(onSubmit).not.toHaveBeenCalled();
    });

    it('disables send button when sessionBusy is true', () => {
      render(<ChatInput {...defaultProps} value="hello" sessionBusy={true} />);
      const btn = screen.getByLabelText('Send message');
      expect(btn).toHaveProperty('disabled', true);
      expect(btn.className).toContain('pointer-events-none');
    });

    it('shows busy message when sessionBusy is true', () => {
      render(<ChatInput {...defaultProps} sessionBusy={true} />);
      expect(screen.getByText(/Session is busy/)).toBeDefined();
    });

    it('hides busy message when sessionBusy is false', () => {
      render(<ChatInput {...defaultProps} sessionBusy={false} />);
      expect(screen.queryByText(/Session is busy/)).toBeNull();
    });

    it('hides clear button when sessionBusy is true', () => {
      render(<ChatInput {...defaultProps} value="hello" sessionBusy={true} />);
      const btn = screen.getByLabelText('Clear message');
      expect(btn.className).toContain('pointer-events-none');
    });
  });

  describe('canSubmit state', () => {
    it('disables the send button when canSubmit is false (target not ready)', () => {
      render(<ChatInput {...defaultProps} value="hello" canSubmit={false} />);
      const btn = screen.getByLabelText('Send message');
      expect(btn).toHaveProperty('disabled', true);
      expect(btn.className).toContain('pointer-events-none');
    });

    it('keeps the input typeable when canSubmit is false', () => {
      render(<ChatInput {...defaultProps} canSubmit={false} />);
      expect(screen.getByRole('combobox')).toHaveProperty('disabled', false);
    });

    it('does not show a busy message when canSubmit is false', () => {
      render(<ChatInput {...defaultProps} value="hello" canSubmit={false} />);
      expect(screen.queryByText(/Session is busy/)).toBeNull();
    });

    it('does not call onSubmit when the disabled send button is clicked', () => {
      const onSubmit = vi.fn();
      render(<ChatInput {...defaultProps} value="hello" canSubmit={false} onSubmit={onSubmit} />);
      fireEvent.click(screen.getByLabelText('Send message'));
      expect(onSubmit).not.toHaveBeenCalled();
    });

    it('does not submit on Enter when canSubmit is false', () => {
      const onSubmit = vi.fn();
      render(<ChatInput {...defaultProps} value="hello" canSubmit={false} onSubmit={onSubmit} />);
      fireEvent.keyDown(screen.getByRole('combobox'), { key: 'Enter' });
      expect(onSubmit).not.toHaveBeenCalled();
    });

    it('submits on Enter when canSubmit is true (default)', () => {
      const onSubmit = vi.fn();
      render(<ChatInput {...defaultProps} value="hello" onSubmit={onSubmit} />);
      fireEvent.keyDown(screen.getByRole('combobox'), { key: 'Enter' });
      expect(onSubmit).toHaveBeenCalledOnce();
    });

    it('enables the send button by default (canSubmit defaults to true)', () => {
      const onSubmit = vi.fn();
      render(<ChatInput {...defaultProps} value="hello" onSubmit={onSubmit} />);
      const btn = screen.getByLabelText('Send message');
      expect(btn).toHaveProperty('disabled', false);
      fireEvent.click(btn);
      expect(onSubmit).toHaveBeenCalledOnce();
    });
  });

  describe('queue button states', () => {
    it('send button shows Queue icon during streaming with text', () => {
      render(<ChatInput {...defaultProps} isStreaming={true} value="text" onQueue={vi.fn()} />);
      expect(screen.getByLabelText('Queue message')).toBeDefined();
    });

    it('send button shows Update icon when editing queue item', () => {
      render(
        <ChatInput {...defaultProps} editingQueueItem={true} value="text" onSaveEdit={vi.fn()} />
      );
      expect(screen.getByLabelText('Save edit')).toBeDefined();
    });

    it('send button shows Stop icon during streaming without text', () => {
      render(<ChatInput {...defaultProps} isStreaming={true} value="" onStop={vi.fn()} />);
      expect(screen.getByLabelText('Stop generating')).toBeDefined();
    });

    it('queue badge renders with correct count', () => {
      render(<ChatInput {...defaultProps} isStreaming={true} value="text" queueDepth={3} />);
      expect(screen.getByText('3')).toBeDefined();
    });

    it('queue badge not rendered when queueDepth is 0', () => {
      render(<ChatInput {...defaultProps} isStreaming={true} value="text" queueDepth={0} />);
      expect(screen.queryByText('0')).toBeNull();
    });

    it('editing label shows when editingQueueItem is true', () => {
      render(<ChatInput {...defaultProps} editingQueueItem={true} value="text" />);
      expect(screen.getByText(/Editing message/)).toBeDefined();
    });

    it('editing border applied when editingQueueItem is true', () => {
      const { container } = render(<ChatInput {...defaultProps} editingQueueItem={true} />);
      const wrapper = container.querySelector('.border-primary\\/40');
      expect(wrapper).toBeDefined();
    });
  });

  describe('Enter key queue-aware behavior', () => {
    it('Enter key queues message during streaming when onQueue provided', () => {
      const onQueue = vi.fn();
      render(<ChatInput {...defaultProps} isStreaming={true} value="test" onQueue={onQueue} />);
      fireEvent.keyDown(screen.getByRole('combobox'), { key: 'Enter' });
      expect(onQueue).toHaveBeenCalled();
    });

    it('Enter key saves edit when editingQueueItem is true', () => {
      const onSaveEdit = vi.fn();
      render(
        <ChatInput
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
        <ChatInput
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
        <ChatInput
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
        <ChatInput
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
        <ChatInput
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
        <ChatInput
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
        <ChatInput
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
        <ChatInput
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
      render(<ChatInput {...defaultProps} value="こん" onSubmit={onSubmit} />);
      fireEvent.keyDown(screen.getByRole('combobox'), { key: 'Enter', isComposing: true });
      expect(onSubmit).not.toHaveBeenCalled();
    });

    it('honours the legacy keyCode 229 signal', () => {
      const onSubmit = vi.fn();
      render(<ChatInput {...defaultProps} value="こん" onSubmit={onSubmit} />);
      fireEvent.keyDown(screen.getByRole('combobox'), { key: 'Enter', keyCode: 229 });
      expect(onSubmit).not.toHaveBeenCalled();
    });

    it('does not stop generation on Escape while composing', () => {
      const onStop = vi.fn();
      const onEscape = vi.fn();
      render(
        <ChatInput {...defaultProps} isStreaming={true} onStop={onStop} onEscape={onEscape} />
      );
      fireEvent.keyDown(screen.getByRole('combobox'), { key: 'Escape', isComposing: true });
      expect(onStop).not.toHaveBeenCalled();
      expect(onEscape).not.toHaveBeenCalled();
    });

    it('submits once the composition has ended', () => {
      const onSubmit = vi.fn();
      render(<ChatInput {...defaultProps} value="こん" onSubmit={onSubmit} />);
      const combobox = screen.getByRole('combobox');
      fireEvent.keyDown(combobox, { key: 'Enter', isComposing: true });
      fireEvent.keyDown(combobox, { key: 'Enter' });
      expect(onSubmit).toHaveBeenCalledOnce();
    });
  });

  describe('backslash line continuation', () => {
    it('turns a trailing backslash into a newline instead of submitting', () => {
      stubExecCommand();
      const onSubmit = vi.fn();
      const { textarea } = renderWithCaret({ ...defaultProps, value: 'foo\\', onSubmit });
      fireEvent.keyDown(textarea, { key: 'Enter' });
      expect(onSubmit).not.toHaveBeenCalled();
      expect(textarea.value).toBe('foo\n');
    });

    it('edits through execCommand so the native undo stack survives', () => {
      const exec = stubExecCommand();
      const { textarea } = renderWithCaret({ ...defaultProps, value: 'foo\\' });
      fireEvent.keyDown(textarea, { key: 'Enter' });
      expect(exec).toHaveBeenCalledWith('insertText', false, '\n');
    });

    it('submits on an escaped literal backslash (even run)', () => {
      stubExecCommand();
      const onSubmit = vi.fn();
      const { textarea } = renderWithCaret({ ...defaultProps, value: 'foo\\\\', onSubmit });
      fireEvent.keyDown(textarea, { key: 'Enter' });
      expect(onSubmit).toHaveBeenCalledOnce();
      expect(textarea.value).toBe('foo\\\\');
    });

    it('continues on a three-backslash run (odd)', () => {
      stubExecCommand();
      const onSubmit = vi.fn();
      const { textarea } = renderWithCaret({ ...defaultProps, value: 'foo\\\\\\', onSubmit });
      fireEvent.keyDown(textarea, { key: 'Enter' });
      expect(onSubmit).not.toHaveBeenCalled();
      expect(textarea.value).toBe('foo\\\\\n');
    });

    it('submits when the backslash does not touch the caret', () => {
      stubExecCommand();
      const onSubmit = vi.fn();
      const { textarea } = renderWithCaret({ ...defaultProps, value: 'foo\\ ', onSubmit });
      fireEvent.keyDown(textarea, { key: 'Enter' });
      expect(onSubmit).toHaveBeenCalledOnce();
    });

    it('requires a collapsed caret', () => {
      stubExecCommand();
      const onSubmit = vi.fn();
      const { textarea } = renderWithCaret({ ...defaultProps, value: 'foo\\', onSubmit });
      textarea.setSelectionRange(0, 4);
      fireEvent.keyDown(textarea, { key: 'Enter' });
      expect(onSubmit).toHaveBeenCalledOnce();
    });

    it('works mid-prompt, at the caret rather than at the end of the value', () => {
      stubExecCommand();
      const onSubmit = vi.fn();
      const { textarea } = renderWithCaret({ ...defaultProps, value: 'foo\\bar', onSubmit }, 4);
      fireEvent.keyDown(textarea, { key: 'Enter' });
      expect(onSubmit).not.toHaveBeenCalled();
      expect(textarea.value).toBe('foo\nbar');
    });

    it('never queues while streaming', () => {
      stubExecCommand();
      const onQueue = vi.fn();
      const { textarea } = renderWithCaret({
        ...defaultProps,
        value: 'foo\\',
        isStreaming: true,
        onQueue,
      });
      fireEvent.keyDown(textarea, { key: 'Enter' });
      expect(onQueue).not.toHaveBeenCalled();
      expect(textarea.value).toBe('foo\n');
    });

    it('never saves a queue-item edit', () => {
      stubExecCommand();
      const onSaveEdit = vi.fn();
      const { textarea } = renderWithCaret({
        ...defaultProps,
        value: 'foo\\',
        editingQueueItem: true,
        onSaveEdit,
      });
      fireEvent.keyDown(textarea, { key: 'Enter' });
      expect(onSaveEdit).not.toHaveBeenCalled();
      expect(textarea.value).toBe('foo\n');
    });

    it('eats the backslash on mobile too, so the text matches every platform', () => {
      isMobileViewport = true;
      const exec = stubExecCommand();
      const { textarea } = renderWithCaret({ ...defaultProps, value: 'foo\\' });
      fireEvent.keyDown(textarea, { key: 'Enter' });
      expect(exec).toHaveBeenCalledWith('insertText', false, '\n');
      expect(textarea.value).toBe('foo\n');
    });

    it('leaves the backslash alone on Shift+Enter (already a newline)', () => {
      const exec = stubExecCommand();
      const { textarea } = renderWithCaret({ ...defaultProps, value: 'foo\\' });
      fireEvent.keyDown(textarea, { key: 'Enter', shiftKey: true });
      expect(exec).not.toHaveBeenCalled();
      expect(textarea.value).toBe('foo\\');
    });

    it('does not fire during an IME composition', () => {
      const exec = stubExecCommand();
      const { textarea } = renderWithCaret({ ...defaultProps, value: 'foo\\' });
      fireEvent.keyDown(textarea, { key: 'Enter', isComposing: true });
      expect(exec).not.toHaveBeenCalled();
    });

    it('lets the palette take Enter instead of continuing the line', () => {
      const exec = stubExecCommand();
      const onCommandSelect = vi.fn();
      const { textarea } = renderWithCaret({
        ...defaultProps,
        value: '/daily\\',
        isPaletteOpen: true,
        onCommandSelect,
      });
      fireEvent.keyDown(textarea, { key: 'Enter' });
      expect(onCommandSelect).toHaveBeenCalledOnce();
      expect(exec).not.toHaveBeenCalled();
    });
  });

  describe('Option+Enter newline', () => {
    it('inserts a newline instead of submitting', () => {
      const exec = stubExecCommand();
      const onSubmit = vi.fn();
      const { textarea } = renderWithCaret({ ...defaultProps, value: 'hello', onSubmit });
      fireEvent.keyDown(textarea, { key: 'Enter', altKey: true });
      expect(onSubmit).not.toHaveBeenCalled();
      expect(exec).toHaveBeenCalledWith('insertText', false, '\n');
      expect(textarea.value).toBe('hello\n');
    });

    it('does not pick a palette entry', () => {
      stubExecCommand();
      const onCommandSelect = vi.fn();
      const { textarea } = renderWithCaret({
        ...defaultProps,
        value: '/dai',
        isPaletteOpen: true,
        onCommandSelect,
      });
      fireEvent.keyDown(textarea, { key: 'Enter', altKey: true });
      expect(onCommandSelect).not.toHaveBeenCalled();
      expect(textarea.value).toBe('/dai\n');
    });
  });

  describe('Escape priority ladder', () => {
    it('dismisses the palette instead of stopping the turn', () => {
      const onEscape = vi.fn();
      const onStop = vi.fn();
      render(
        <ChatInput
          {...defaultProps}
          value="hello"
          isStreaming={true}
          isPaletteOpen={true}
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
        <ChatInput
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
        <ChatInput
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
        <ChatInput
          {...defaultProps}
          value="hello"
          isPaletteOpen={true}
          onClear={onClear}
          onEscape={onEscape}
        />
      );
      fireEvent.keyDown(screen.getByRole('combobox'), { key: 'Escape' });
      rerender(
        <ChatInput
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
      const onClear = vi.fn();
      const { rerender } = render(
        <ChatInput {...defaultProps} value="hello" isPaletteOpen={true} onClear={onClear} />
      );
      const combobox = screen.getByRole('combobox');
      fireEvent.keyDown(combobox, { key: 'Escape' });
      rerender(
        <ChatInput {...defaultProps} value="hello" isPaletteOpen={false} onClear={onClear} />
      );
      fireEvent.keyDown(combobox, { key: 'Escape' });
      fireEvent.keyDown(combobox, { key: 'Escape' });
      expect(onClear).toHaveBeenCalledOnce();
    });
  });

  describe('autofocus on mount', () => {
    it('focuses the composer on desktop', () => {
      render(<ChatInput {...defaultProps} />);
      expect(document.activeElement).toBe(screen.getByRole('combobox'));
    });

    it('does not focus on a touch viewport (no surprise keyboard)', () => {
      isMobileViewport = true;
      render(<ChatInput {...defaultProps} />);
      expect(document.activeElement).not.toBe(screen.getByRole('combobox'));
    });
  });
});
