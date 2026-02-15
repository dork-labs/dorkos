// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach, beforeAll } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import { ChatInput } from '../ui/ChatInput';

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

afterEach(() => {
  cleanup();
});

describe('ChatInput', () => {
  const defaultProps = {
    value: '',
    onChange: vi.fn(),
    onSubmit: vi.fn(),
    isLoading: false,
  };

  it('renders textarea with placeholder', () => {
    render(<ChatInput {...defaultProps} />);
    expect(screen.getByPlaceholderText(/Message Claude/)).toBeDefined();
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

  it('does not submit when loading', () => {
    const onSubmit = vi.fn();
    render(<ChatInput {...defaultProps} value="hello" isLoading={true} onSubmit={onSubmit} />);
    fireEvent.keyDown(screen.getByRole('combobox'), { key: 'Enter' });
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it('disables textarea when loading', () => {
    render(<ChatInput {...defaultProps} isLoading={true} />);
    expect(screen.getByRole('combobox')).toHaveProperty('disabled', true);
  });

  it('shows stop button when loading', () => {
    render(<ChatInput {...defaultProps} isLoading={true} onStop={vi.fn()} />);
    expect(screen.getByLabelText('Stop generating')).toBeDefined();
  });

  it('shows send button when not loading and has text', () => {
    render(<ChatInput {...defaultProps} value="hello" />);
    expect(screen.getByLabelText('Send message')).toBeDefined();
  });

  it('hides send button when value is empty', () => {
    render(<ChatInput {...defaultProps} value="" />);
    const btn = screen.getByLabelText('Send message');
    expect(btn.getAttribute('disabled')).toBeDefined();
    expect(btn.className).toContain('pointer-events-none');
  });

  it('shows send button when value is non-empty', () => {
    render(<ChatInput {...defaultProps} value="hello" />);
    expect(screen.getByLabelText('Send message')).toBeDefined();
  });

  it('calls onStop when stop button is clicked', () => {
    const onStop = vi.fn();
    render(<ChatInput {...defaultProps} isLoading={true} onStop={onStop} />);
    fireEvent.click(screen.getByLabelText('Stop generating'));
    expect(onStop).toHaveBeenCalled();
  });

  it('calls onEscape when Escape pressed', () => {
    const onEscape = vi.fn();
    render(<ChatInput {...defaultProps} onEscape={onEscape} />);
    fireEvent.keyDown(screen.getByRole('combobox'), { key: 'Escape' });
    expect(onEscape).toHaveBeenCalled();
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
        <ChatInput {...defaultProps} value="/daily" isPaletteOpen={true} onCommandSelect={onCommandSelect} onSubmit={onSubmit} />
      );
      fireEvent.keyDown(screen.getByRole('combobox'), { key: 'Enter' });
      expect(onCommandSelect).toHaveBeenCalledOnce();
      expect(onSubmit).not.toHaveBeenCalled();
    });

    it('calls onCommandSelect on Tab when palette open', () => {
      const onCommandSelect = vi.fn();
      render(<ChatInput {...defaultProps} isPaletteOpen={true} onCommandSelect={onCommandSelect} />);
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
      render(<ChatInput {...defaultProps} isPaletteOpen={true} onCommandSelect={onCommandSelect} />);
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
        <ChatInput {...defaultProps} value="hello" isPaletteOpen={false} onSubmit={onSubmit} onCommandSelect={onCommandSelect} />
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
      render(<ChatInput {...defaultProps} isPaletteOpen={true} activeDescendantId="command-item-2" />);
      expect(screen.getByRole('combobox').getAttribute('aria-activedescendant')).toBe('command-item-2');
    });

    it('does not have aria-activedescendant when palette closed', () => {
      render(<ChatInput {...defaultProps} isPaletteOpen={false} activeDescendantId="command-item-2" />);
      expect(screen.getByRole('combobox').getAttribute('aria-activedescendant')).toBeNull();
    });

    it('has aria-controls pointing to command palette listbox when palette is open', () => {
      render(<ChatInput {...defaultProps} isPaletteOpen={true} activeDescendantId="command-item-0" />);
      expect(screen.getByRole('combobox').getAttribute('aria-controls')).toBe('command-palette-listbox');
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

    it('is hidden when loading', () => {
      render(<ChatInput {...defaultProps} value="hello" isLoading={true} />);
      const btn = screen.getByLabelText('Clear message');
      expect(btn.className).toContain('pointer-events-none');
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
      render(<ChatInput {...defaultProps} value="hello" isPaletteOpen={false} onClear={onClear} onEscape={onEscape} />);
      fireEvent.keyDown(screen.getByRole('combobox'), { key: 'Escape' });
      expect(onEscape).toHaveBeenCalledOnce();
      expect(onClear).not.toHaveBeenCalled();
    });

    it('second Escape within 500ms calls onClear when text exists', () => {
      const onClear = vi.fn();
      const onEscape = vi.fn();
      render(<ChatInput {...defaultProps} value="hello" isPaletteOpen={false} onClear={onClear} onEscape={onEscape} />);
      const combobox = screen.getByRole('combobox');
      fireEvent.keyDown(combobox, { key: 'Escape' });
      fireEvent.keyDown(combobox, { key: 'Escape' });
      expect(onClear).toHaveBeenCalledOnce();
    });

    it('second Escape after 500ms does not call onClear', () => {
      vi.useFakeTimers();
      const onClear = vi.fn();
      const onEscape = vi.fn();
      render(<ChatInput {...defaultProps} value="hello" isPaletteOpen={false} onClear={onClear} onEscape={onEscape} />);
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
      render(<ChatInput {...defaultProps} value="hello" isPaletteOpen={true} onClear={onClear} onEscape={onEscape} />);
      fireEvent.keyDown(screen.getByRole('combobox'), { key: 'Escape' });
      expect(onEscape).toHaveBeenCalledOnce();
      expect(onClear).not.toHaveBeenCalled();
    });

    it('calls onEscape when palette closed and text is empty', () => {
      const onClear = vi.fn();
      const onEscape = vi.fn();
      render(<ChatInput {...defaultProps} value="" isPaletteOpen={false} onClear={onClear} onEscape={onEscape} />);
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
    it('disables textarea when sessionBusy is true', () => {
      render(<ChatInput {...defaultProps} sessionBusy={true} />);
      expect(screen.getByRole('combobox')).toHaveProperty('disabled', true);
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
});
