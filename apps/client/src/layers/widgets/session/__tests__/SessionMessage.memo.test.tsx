// @vitest-environment jsdom
/**
 * A transcript row whose message did not change does not re-render while
 * another row streams (DOR-2895). The transcript rebuilds its grouping, author
 * and feed-position objects on every render, so the row compares those by
 * value; everything else by identity.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render } from '@testing-library/react';
import type { ReactNode } from 'react';
import type { ChatMessage, MessageAuthor } from '@/layers/shared/model';
import { Conversation } from '@/layers/features/conversation';
import { SESSION_CAPABILITIES } from '../model/session-capabilities';

const bodyRenders = vi.fn();
vi.mock('../ui/render-session-body', () => ({
  renderSessionBody: (message: ChatMessage) => {
    bodyRenders(message.id);
    return <p>{message.content}</p>;
  },
}));
vi.mock('@/layers/features/entry-actions/ui/EntryRunWithMenu', () => ({
  EntryRunWithMenu: () => null,
}));

import { SessionMessage, sessionMessagePropsEqual } from '../ui/SessionMessage';

afterEach(cleanup);

const message: ChatMessage = {
  id: 'a1',
  role: 'assistant',
  content: 'Done.',
  parts: [{ type: 'text', text: 'Done.' }],
  timestamp: '2026-10-13T12:00:00.000Z',
};

/** The props a transcript render hands the row: fresh objects every time. */
function rowProps(overrides: Partial<Parameters<typeof SessionMessage>[0]> = {}) {
  const author: MessageAuthor = { kind: 'agent', id: 'agent-1', displayName: 'DorkBot' };
  return {
    message,
    grouping: { position: 'only' as const },
    author: { ...author },
    sessionId: 's1',
    feedPosition: { index: 1, total: 3 },
    ...overrides,
  };
}

function Session({ children }: { children: ReactNode }) {
  return (
    <Conversation.Root surface="session" capabilities={SESSION_CAPABILITIES}>
      {children}
    </Conversation.Root>
  );
}

describe('SessionMessage memo', () => {
  it('skips the render when only fresh-but-equal objects arrive', () => {
    const { rerender } = render(<SessionMessage {...rowProps()} />, { wrapper: Session });
    expect(bodyRenders).toHaveBeenCalledTimes(1);
    rerender(<SessionMessage {...rowProps()} />);
    rerender(<SessionMessage {...rowProps()} />);
    expect(bodyRenders).toHaveBeenCalledTimes(1);
  });

  it('renders again when what it shows changes', () => {
    bodyRenders.mockClear();
    const { rerender } = render(<SessionMessage {...rowProps()} />, { wrapper: Session });
    rerender(<SessionMessage {...rowProps({ message: { ...message, content: 'Done!' } })} />);
    rerender(<SessionMessage {...rowProps({ isStreaming: true, message: { ...message } })} />);
    expect(bodyRenders).toHaveBeenCalledTimes(3);
  });

  it('compares the rebuilt objects by what they say', () => {
    const base = rowProps();
    expect(sessionMessagePropsEqual(base, rowProps())).toBe(true);
    expect(sessionMessagePropsEqual(base, rowProps({ grouping: { position: 'first' } }))).toBe(
      false
    );
    expect(sessionMessagePropsEqual(base, rowProps({ feedPosition: { index: 1, total: 4 } }))).toBe(
      false
    );
    expect(
      sessionMessagePropsEqual(
        base,
        rowProps({ author: { kind: 'agent', id: 'agent-1', displayName: 'Renamed' } })
      )
    ).toBe(false);
    expect(sessionMessagePropsEqual(base, rowProps({ onRetry: () => {} }))).toBe(false);
  });
});
