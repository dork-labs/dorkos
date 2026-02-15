// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import { StreamingText } from '../ui/StreamingText';

afterEach(() => {
  cleanup();
});

// Mock Streamdown to avoid complex rendering in unit tests
vi.mock('streamdown', () => ({
  Streamdown: ({ children }: { children: string }) => <div data-testid="streamdown">{children}</div>,
}));

describe('StreamingText', () => {
  it('passes content to Streamdown component', () => {
    render(<StreamingText content="# Hello" />);
    expect(screen.getByTestId('streamdown')).toBeDefined();
    expect(screen.getByText('# Hello')).toBeDefined();
  });

  it('handles empty content', () => {
    const { container } = render(<StreamingText content="" />);
    expect(container).toBeDefined();
    expect(screen.getByTestId('streamdown')).toBeDefined();
  });

  it('passes markdown content through unchanged', () => {
    render(<StreamingText content="**bold** and `code`" />);
    expect(screen.getByText('**bold** and `code`')).toBeDefined();
  });

  it('adds streaming-cursor class when isStreaming is true', () => {
    const { container } = render(<StreamingText content="Hello" isStreaming={true} />);
    const wrapper = container.firstElementChild;
    expect(wrapper?.classList.contains('streaming-cursor')).toBe(true);
  });

  it('does not add streaming-cursor class when isStreaming is false', () => {
    const { container } = render(<StreamingText content="Hello" isStreaming={false} />);
    const wrapper = container.firstElementChild;
    expect(wrapper?.classList.contains('streaming-cursor')).toBe(false);
  });

  it('does not add streaming-cursor class by default (isStreaming omitted)', () => {
    const { container } = render(<StreamingText content="Hello" />);
    const wrapper = container.firstElementChild;
    expect(wrapper?.classList.contains('streaming-cursor')).toBe(false);
  });
});
