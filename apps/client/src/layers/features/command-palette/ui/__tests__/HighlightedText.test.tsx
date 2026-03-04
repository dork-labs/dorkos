/**
 * @vitest-environment jsdom
 */
import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { HighlightedText } from '../HighlightedText';

describe('HighlightedText', () => {
  it('renders plain text when no indices are provided', () => {
    render(<HighlightedText text="Hello World" />);
    expect(screen.getByText('Hello World')).toBeInTheDocument();
  });

  it('renders plain text when indices array is empty', () => {
    const { container } = render(<HighlightedText text="Hello World" indices={[]} />);
    expect(container.textContent).toBe('Hello World');
    expect(container.querySelectorAll('mark')).toHaveLength(0);
  });

  it('renders mark elements for matched ranges', () => {
    const { container } = render(
      <HighlightedText text="Hello" indices={[[0, 2]]} />
    );
    const marks = container.querySelectorAll('mark');
    expect(marks).toHaveLength(1);
    expect(marks[0].textContent).toBe('Hel');
  });

  it('renders non-matched text between matches', () => {
    const { container } = render(
      <HighlightedText text="Hello" indices={[[0, 0], [4, 4]]} />
    );
    const marks = container.querySelectorAll('mark');
    expect(marks).toHaveLength(2);
    expect(marks[0].textContent).toBe('H');
    expect(marks[1].textContent).toBe('o');
    expect(container.textContent).toBe('Hello');
  });

  it('handles match at the start of the string', () => {
    const { container } = render(
      <HighlightedText text="abcdef" indices={[[0, 1]]} />
    );
    const marks = container.querySelectorAll('mark');
    expect(marks[0].textContent).toBe('ab');
  });

  it('handles match at the end of the string', () => {
    const { container } = render(
      <HighlightedText text="abcdef" indices={[[4, 5]]} />
    );
    const marks = container.querySelectorAll('mark');
    expect(marks[0].textContent).toBe('ef');
  });

  it('handles adjacent match ranges', () => {
    const { container } = render(
      <HighlightedText text="abcdef" indices={[[0, 2], [3, 5]]} />
    );
    const marks = container.querySelectorAll('mark');
    expect(marks).toHaveLength(2);
    expect(marks[0].textContent).toBe('abc');
    expect(marks[1].textContent).toBe('def');
  });

  it('applies font-semibold class to mark elements', () => {
    const { container } = render(
      <HighlightedText text="Hello" indices={[[0, 0]]} />
    );
    const mark = container.querySelector('mark');
    expect(mark).toHaveClass('font-semibold');
  });

  it('applies custom className to wrapper span', () => {
    const { container } = render(
      <HighlightedText text="Hello" className="custom-class" />
    );
    expect(container.firstChild).toHaveClass('custom-class');
  });

  it('preserves full text content regardless of highlighting', () => {
    const { container } = render(
      <HighlightedText text="Auth Service" indices={[[0, 3]]} />
    );
    expect(container.textContent).toBe('Auth Service');
  });
});
