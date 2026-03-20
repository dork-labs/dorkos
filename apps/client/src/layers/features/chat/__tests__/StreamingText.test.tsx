// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import type { StreamdownProps } from 'streamdown';

// Mock Streamdown to inspect props passed to it
const MockStreamdown = vi.fn((props: StreamdownProps) => (
  <div data-testid="streamdown">{props.children}</div>
));

vi.mock('streamdown', () => ({
  Streamdown: (props: StreamdownProps) => MockStreamdown(props),
}));
vi.mock('streamdown/styles.css', () => ({}));

import { StreamingText } from '../ui/StreamingText';
import type { TextEffectConfig } from '@/layers/shared/lib';

afterEach(() => {
  cleanup();
  MockStreamdown.mockClear();
});

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

  it('passes TypeScript array type syntax through without truncation', () => {
    // Purpose: Regression guard for the streamdown@2.3.0/remend@1.2.1 bug where `[]`
    // inside inline code spans caused trailing content to be silently dropped during
    // streaming. Verifies the full content string—including array brackets—reaches
    // <Streamdown> unchanged. This test CAN fail if the dependency is downgraded to 2.3.x.
    const content =
      '- **Array literals**: `numbers` is typed as `number[]`\n\nThis paragraph must also render.';
    render(<StreamingText content={content} />);
    expect(screen.getByTestId('streamdown').textContent).toBe(content);
  });

  it('passes animated config when textEffect mode is not none', () => {
    render(<StreamingText content="Hello" isStreaming={true} />);
    const call = MockStreamdown.mock.calls[0][0];
    expect(call.animated).toEqual({
      animation: 'blurIn',
      duration: 150,
      easing: 'ease-out',
      sep: 'word',
    });
  });

  it('passes animated=false when textEffect mode is none', () => {
    const noEffect: TextEffectConfig = { mode: 'none' };
    render(<StreamingText content="Hello" textEffect={noEffect} />);
    const call = MockStreamdown.mock.calls[0][0];
    expect(call.animated).toBe(false);
  });

  it('passes isAnimating=true when isStreaming is true', () => {
    render(<StreamingText content="Hello" isStreaming={true} />);
    const call = MockStreamdown.mock.calls[0][0];
    expect(call.isAnimating).toBe(true);
  });

  it('passes isAnimating=false when isStreaming is false', () => {
    render(<StreamingText content="Hello" isStreaming={false} />);
    const call = MockStreamdown.mock.calls[0][0];
    expect(call.isAnimating).toBe(false);
  });

  it('defaults to DEFAULT_TEXT_EFFECT (blur-in) when no textEffect prop provided', () => {
    render(<StreamingText content="Hello" />);
    const call = MockStreamdown.mock.calls[0][0];
    expect(call.animated).toEqual({
      animation: 'blurIn',
      duration: 150,
      easing: 'ease-out',
      sep: 'word',
    });
  });
});
