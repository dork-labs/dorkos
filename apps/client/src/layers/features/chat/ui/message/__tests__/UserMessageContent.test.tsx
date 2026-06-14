/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { UserMessageContent } from '../UserMessageContent';
import type { ChatMessage } from '../../../model/use-chat-session';

// Stub the shared tool-output renderer so we assert delegation, not its internals.
vi.mock('../OutputRenderer', () => ({
  OutputRenderer: ({ content }: { content: string }) => (
    <pre data-testid="output-renderer">{content}</pre>
  ),
}));

function makeMessage(overrides: Partial<ChatMessage>): ChatMessage {
  return {
    id: 'm1',
    role: 'user',
    content: '',
    parts: [],
    timestamp: '',
    ...overrides,
  };
}

describe('UserMessageContent', () => {
  afterEach(() => {
    cleanup();
  });

  it('renders local-command output via OutputRenderer (DOR-126)', () => {
    render(
      <UserMessageContent
        message={makeMessage({
          messageType: 'local_command_output',
          content: 'Context: 12,345 tokens (6%)',
        })}
      />
    );
    expect(screen.getByTestId('output-renderer')).toHaveTextContent('Context: 12,345 tokens (6%)');
  });

  it('renders a command as monospace text, not as output', () => {
    render(
      <UserMessageContent message={makeMessage({ messageType: 'command', content: '/context' })} />
    );
    expect(screen.getByText('/context')).toBeInTheDocument();
    expect(screen.queryByTestId('output-renderer')).not.toBeInTheDocument();
  });

  it('renders plain user text without invoking the output renderer', () => {
    render(<UserMessageContent message={makeMessage({ content: 'hello world' })} />);
    expect(screen.getByText('hello world')).toBeInTheDocument();
    expect(screen.queryByTestId('output-renderer')).not.toBeInTheDocument();
  });
});
