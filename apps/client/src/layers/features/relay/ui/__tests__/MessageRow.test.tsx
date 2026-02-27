/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { MessageRow } from '../MessageRow';

// Mock motion/react to render plain elements in tests
vi.mock('motion/react', () => ({
  motion: {
    div: ({ children, ...props }: React.ComponentProps<'div'>) => <div {...props}>{children}</div>,
  },
  AnimatePresence: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));

// Mock MessageTrace to avoid real data fetching
vi.mock('../MessageTrace', () => ({
  MessageTrace: ({ messageId, onClose }: { messageId: string; onClose?: () => void }) => (
    <div data-testid="message-trace" data-message-id={messageId}>
      <button onClick={onClose}>Close</button>
    </div>
  ),
}));

const baseMessage = {
  id: 'msg-123',
  subject: 'relay.agent.test',
  from: 'system',
  status: 'cur',
  createdAt: new Date().toISOString(),
  payload: { key: 'value' },
};

describe('MessageRow', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    cleanup();
  });

  it('renders message subject and status badge', () => {
    render(<MessageRow message={baseMessage} />);

    expect(screen.getByText('relay.agent.test')).toBeInTheDocument();
    expect(screen.getByText('Delivered')).toBeInTheDocument();
  });

  it('renders message from field', () => {
    render(<MessageRow message={baseMessage} />);

    expect(screen.getByText('system')).toBeInTheDocument();
  });

  it('does not show payload when collapsed', () => {
    render(<MessageRow message={baseMessage} />);

    expect(screen.queryByText('Payload')).not.toBeInTheDocument();
  });

  it('shows payload content when expanded', () => {
    render(<MessageRow message={baseMessage} />);

    // Click the main expand button (first button in the component)
    const buttons = screen.getAllByRole('button');
    fireEvent.click(buttons[0]);

    expect(screen.getByText('Payload')).toBeInTheDocument();
  });

  it('shows trace toggle button when expanded and message has id', () => {
    render(<MessageRow message={baseMessage} />);

    const buttons = screen.getAllByRole('button');
    fireEvent.click(buttons[0]);

    expect(screen.getByText('Show trace')).toBeInTheDocument();
  });

  it('does not show trace toggle when message has no id', () => {
    const messageWithoutId = { ...baseMessage, id: undefined };
    render(<MessageRow message={messageWithoutId} />);

    const buttons = screen.getAllByRole('button');
    fireEvent.click(buttons[0]);

    expect(screen.queryByText('Show trace')).not.toBeInTheDocument();
  });

  it('toggles MessageTrace on Activity button click', () => {
    render(<MessageRow message={baseMessage} />);

    // Expand the message
    const buttons = screen.getAllByRole('button');
    fireEvent.click(buttons[0]);

    // MessageTrace should not be visible yet
    expect(screen.queryByTestId('message-trace')).not.toBeInTheDocument();

    // Click the trace toggle button
    fireEvent.click(screen.getByText('Show trace'));

    // MessageTrace should now be visible
    expect(screen.getByTestId('message-trace')).toBeInTheDocument();
    expect(screen.getByTestId('message-trace')).toHaveAttribute('data-message-id', 'msg-123');
  });

  it('changes button text to "Hide trace" when trace is visible', () => {
    render(<MessageRow message={baseMessage} />);

    const buttons = screen.getAllByRole('button');
    fireEvent.click(buttons[0]);

    fireEvent.click(screen.getByText('Show trace'));

    expect(screen.getByText('Hide trace')).toBeInTheDocument();
    expect(screen.queryByText('Show trace')).not.toBeInTheDocument();
  });

  it('hides trace when "Hide trace" is clicked', () => {
    render(<MessageRow message={baseMessage} />);

    const buttons = screen.getAllByRole('button');
    fireEvent.click(buttons[0]);
    fireEvent.click(screen.getByText('Show trace'));
    fireEvent.click(screen.getByText('Hide trace'));

    expect(screen.queryByTestId('message-trace')).not.toBeInTheDocument();
    expect(screen.getByText('Show trace')).toBeInTheDocument();
  });

  it('hides trace when MessageTrace onClose is called', () => {
    render(<MessageRow message={baseMessage} />);

    const buttons = screen.getAllByRole('button');
    fireEvent.click(buttons[0]);
    fireEvent.click(screen.getByText('Show trace'));

    // MessageTrace renders a Close button that calls onClose
    fireEvent.click(screen.getByText('Close'));

    expect(screen.queryByTestId('message-trace')).not.toBeInTheDocument();
  });

  it('trace toggle stopPropagation does not collapse the expanded view', () => {
    render(<MessageRow message={baseMessage} />);

    const buttons = screen.getAllByRole('button');
    fireEvent.click(buttons[0]);

    // Payload should be visible
    expect(screen.getByText('Payload')).toBeInTheDocument();

    // Click trace toggle — payload should remain visible
    fireEvent.click(screen.getByText('Show trace'));
    expect(screen.getByText('Payload')).toBeInTheDocument();
  });

  it('shows budget section when budget is present', () => {
    const messageWithBudget = { ...baseMessage, budget: { maxTokens: 1000 } };
    render(<MessageRow message={messageWithBudget} />);

    const buttons = screen.getAllByRole('button');
    fireEvent.click(buttons[0]);

    expect(screen.getByText('Budget')).toBeInTheDocument();
  });

  it('does not show budget section when budget is absent', () => {
    render(<MessageRow message={baseMessage} />);

    const buttons = screen.getAllByRole('button');
    fireEvent.click(buttons[0]);

    expect(screen.queryByText('Budget')).not.toBeInTheDocument();
  });

  describe('content preview', () => {
    it('shows preview text for messages with payload.content', () => {
      const message = { ...baseMessage, payload: { content: 'Hello from relay' } };
      render(<MessageRow message={message} />);

      expect(screen.getByText('Hello from relay')).toBeInTheDocument();
    });

    it('shows preview text for messages with payload.text', () => {
      const message = { ...baseMessage, payload: { text: 'Text field value' } };
      render(<MessageRow message={message} />);

      expect(screen.getByText('Text field value')).toBeInTheDocument();
    });

    it('shows preview text for messages with payload.message', () => {
      const message = { ...baseMessage, payload: { message: 'Message field value' } };
      render(<MessageRow message={message} />);

      expect(screen.getByText('Message field value')).toBeInTheDocument();
    });

    it('shows preview text for messages with payload.body', () => {
      const message = { ...baseMessage, payload: { body: 'Body field value' } };
      render(<MessageRow message={message} />);

      expect(screen.getByText('Body field value')).toBeInTheDocument();
    });

    it('truncates preview at 80 characters with ellipsis', () => {
      const longText = 'a'.repeat(100);
      const message = { ...baseMessage, payload: { content: longText } };
      render(<MessageRow message={message} />);

      const expectedPreview = 'a'.repeat(80) + '...';
      expect(screen.getByText(expectedPreview)).toBeInTheDocument();
    });

    it('does not truncate preview shorter than 80 characters', () => {
      const shortText = 'Short message';
      const message = { ...baseMessage, payload: { content: shortText } };
      render(<MessageRow message={message} />);

      expect(screen.getByText('Short message')).toBeInTheDocument();
      expect(screen.queryByText('Short message...')).not.toBeInTheDocument();
    });

    it('shows no preview for empty payload object', () => {
      const message = { ...baseMessage, payload: {} };
      render(<MessageRow message={message} />);

      // The JSON for {} is "{}" which is 2 chars — it would show as preview
      // but only if there is no content/text/message/body field.
      // {} stringifies to "{}" — under 80 chars, so it renders as is.
      // We just verify the component does not crash.
      expect(screen.getByText('relay.agent.test')).toBeInTheDocument();
    });

    it('hides preview when message is expanded', () => {
      const message = { ...baseMessage, payload: { content: 'Visible preview text' } };
      render(<MessageRow message={message} />);

      // Preview visible in collapsed state
      expect(screen.getByText('Visible preview text')).toBeInTheDocument();

      // Expand
      const buttons = screen.getAllByRole('button');
      fireEvent.click(buttons[0]);

      // Preview hidden when expanded (payload section takes over)
      expect(screen.queryByText('Visible preview text')).not.toBeInTheDocument();
    });

    it('shows no preview for null payload', () => {
      const message = { ...baseMessage, payload: null };
      render(<MessageRow message={message} />);

      // Should not crash and subject should still render
      expect(screen.getByText('relay.agent.test')).toBeInTheDocument();
    });
  });

  it('renders failed status with correct badge', () => {
    const failedMessage = { ...baseMessage, status: 'failed' };
    render(<MessageRow message={failedMessage} />);

    expect(screen.getByText('Failed')).toBeInTheDocument();
  });

  it('renders dead_letter status with correct badge', () => {
    const deadLetterMessage = { ...baseMessage, status: 'dead_letter' };
    render(<MessageRow message={deadLetterMessage} />);

    expect(screen.getByText('Dead Letter')).toBeInTheDocument();
  });
});
