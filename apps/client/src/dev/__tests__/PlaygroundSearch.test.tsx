/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { PlaygroundSearch } from '../PlaygroundSearch';
import type { PlaygroundSection } from '../playground-registry';

// jsdom does not implement ResizeObserver (required by cmdk CommandList)
globalThis.ResizeObserver = vi.fn().mockImplementation(() => ({
  observe: vi.fn(),
  unobserve: vi.fn(),
  disconnect: vi.fn(),
}));

// jsdom does not implement scrollIntoView (required by cmdk item selection)
Element.prototype.scrollIntoView = vi.fn();

// matchMedia mock required for Radix Dialog / viewport checks
beforeEach(() => {
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
  vi.clearAllMocks();
});

afterEach(() => {
  cleanup();
});

function renderSearch({
  open = true,
  onOpenChange = vi.fn(),
  onSelect = vi.fn(),
}: {
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  onSelect?: (section: PlaygroundSection) => void;
} = {}) {
  return {
    onOpenChange,
    onSelect,
    ...render(<PlaygroundSearch open={open} onOpenChange={onOpenChange} onSelect={onSelect} />),
  };
}

describe('PlaygroundSearch', () => {
  it('renders the search input when open', () => {
    renderSearch();
    expect(screen.getByPlaceholderText('Search sections...')).toBeInTheDocument();
  });

  it('does not render content when closed', () => {
    renderSearch({ open: false });
    expect(screen.queryByPlaceholderText('Search sections...')).not.toBeInTheDocument();
  });

  it('renders all three page group headings', () => {
    renderSearch();
    expect(screen.getByText('Design Tokens')).toBeInTheDocument();
    expect(screen.getByText('Components')).toBeInTheDocument();
    expect(screen.getByText('Chat')).toBeInTheDocument();
  });

  it('renders sections from the tokens page', () => {
    renderSearch();
    expect(screen.getByText('Semantic Colors')).toBeInTheDocument();
    expect(screen.getByText('Typography')).toBeInTheDocument();
    expect(screen.getByText('Spacing')).toBeInTheDocument();
  });

  it('renders sections from the components page', () => {
    renderSearch();
    expect(screen.getByText('Button')).toBeInTheDocument();
    expect(screen.getByText('Dialog')).toBeInTheDocument();
  });

  it('renders sections from the chat page', () => {
    renderSearch();
    expect(screen.getByText('ToolCallCard')).toBeInTheDocument();
    expect(screen.getByText('ChatInput')).toBeInTheDocument();
  });

  it('calls onSelect with the section when a result is clicked', () => {
    const { onSelect } = renderSearch();

    fireEvent.click(screen.getByText('Semantic Colors'));
    expect(onSelect).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'semantic-colors', page: 'tokens' })
    );
  });

  it('calls onOpenChange(false) after selecting a section', () => {
    const { onOpenChange } = renderSearch();

    fireEvent.click(screen.getByText('Semantic Colors'));
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it('shows empty state when search query has no matches', () => {
    renderSearch();

    const input = screen.getByPlaceholderText('Search sections...');
    fireEvent.change(input, { target: { value: 'xyznonexistent123' } });

    expect(screen.getByText('No sections found.')).toBeInTheDocument();
  });

  it('filters results by title when typing', () => {
    renderSearch();

    const input = screen.getByPlaceholderText('Search sections...');
    fireEvent.change(input, { target: { value: 'Typography' } });

    expect(screen.getByText('Typography')).toBeInTheDocument();
    // Unrelated sections should be filtered out
    expect(screen.queryByText('Semantic Colors')).not.toBeInTheDocument();
  });
});
