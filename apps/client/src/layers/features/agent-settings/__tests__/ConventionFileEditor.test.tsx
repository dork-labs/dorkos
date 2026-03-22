/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, fireEvent, within } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { ConventionFileEditor } from '../ui/ConventionFileEditor';

describe('ConventionFileEditor', () => {
  const defaultProps = {
    title: 'Custom Instructions (SOUL.md)',
    content: 'Hello world',
    enabled: true,
    maxChars: 4000,
    onChange: vi.fn(),
    onToggle: vi.fn(),
  };

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('renders title, toggle, and textarea', () => {
    const { container } = render(<ConventionFileEditor {...defaultProps} />);
    const view = within(container);

    expect(view.getByText('Custom Instructions (SOUL.md)')).toBeInTheDocument();
    expect(view.getByRole('switch')).toBeInTheDocument();
    expect(view.getByRole('textbox')).toBeInTheDocument();
  });

  it('shows character count', () => {
    const { container } = render(<ConventionFileEditor {...defaultProps} />);
    expect(within(container).getByText('11 / 4,000')).toBeInTheDocument();
  });

  it('calls onToggle when switch is clicked', () => {
    const onToggle = vi.fn();
    const { container } = render(<ConventionFileEditor {...defaultProps} onToggle={onToggle} />);

    fireEvent.click(within(container).getByRole('switch'));
    expect(onToggle).toHaveBeenCalledWith(false);
  });

  it('calls onChange when content changes', () => {
    const onChange = vi.fn();
    const { container } = render(
      <ConventionFileEditor {...defaultProps} content="" onChange={onChange} />
    );

    fireEvent.change(within(container).getByRole('textbox'), { target: { value: 'a' } });
    expect(onChange).toHaveBeenCalled();
  });

  it('dims the card when disabled', () => {
    const { container } = render(<ConventionFileEditor {...defaultProps} enabled={false} />);
    expect(container.querySelector('.opacity-60')).toBeInTheDocument();
  });

  it('shows disclaimer when provided', () => {
    const { container } = render(
      <ConventionFileEditor
        {...defaultProps}
        disclaimer="These boundaries guide agent behavior but are not enforced."
      />
    );
    expect(
      within(container).getByText(/These boundaries guide agent behavior/)
    ).toBeInTheDocument();
  });

  it('does not show disclaimer when not provided', () => {
    const { container } = render(<ConventionFileEditor {...defaultProps} />);
    expect(
      within(container).queryByText(/These boundaries guide agent behavior/)
    ).not.toBeInTheDocument();
  });
});
