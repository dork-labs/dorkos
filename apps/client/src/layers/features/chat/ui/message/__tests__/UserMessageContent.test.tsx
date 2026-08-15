/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { formatUiActionMessage } from '@dorkos/shared/ui-widget';
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

  it('renders a compaction boundary as a labelled rule carrying its metadata', () => {
    render(
      <UserMessageContent
        message={makeMessage({
          messageType: 'compaction',
          content: 'The conversation so far…',
          compactMetadata: { trigger: 'manual', preTokens: 51_226 },
        })}
      />
    );
    expect(screen.getByText('Context compacted · 51.2k tokens · manual')).toBeInTheDocument();
  });

  it('offers no expander on a boundary that has no summary to expand (DOR-1215)', () => {
    // Log-backed runtimes (test-mode, codex) reconstruct the boundary from the
    // event stream, which carries no summary text — Claude's summary lives in
    // the JSONL record the boundary annotates and has no equivalent here. The
    // rule still has to be drawn, because it is what tells the reader the
    // history above it was summarized away; what it must not do is hand them a
    // control that opens onto nothing.
    render(
      <UserMessageContent
        message={makeMessage({
          messageType: 'compaction',
          content: '',
          compactMetadata: { trigger: 'manual' },
        })}
      />
    );
    expect(screen.getByText('Context compacted · manual')).toBeInTheDocument();
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
  });

  it('renders a widget interaction as a calm chip, not the raw <ui_action> XML', () => {
    const content = formatUiActionMessage({
      actionId: 'move-1-1',
      widgetTitle: 'Tic-Tac-Toe',
      payload: { glyph: 'X' },
    });
    render(<UserMessageContent message={makeMessage({ content })} />);

    expect(screen.getByTestId('ui-action-chip')).toBeInTheDocument();
    expect(screen.getByText('Tic-Tac-Toe')).toBeInTheDocument();
    expect(screen.getByText('move 1 1')).toBeInTheDocument();
    expect(screen.queryByText(/<ui_action>/)).not.toBeInTheDocument();
  });
});
