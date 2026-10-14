// @vitest-environment jsdom
/**
 * A link to a message older than a long chat's opening window (DOR-2889): the
 * transcript reads older pages until the message is loaded, then lands on it.
 * Both ways in: arriving with the link, and following it inside the chat that
 * is already open (a ⌘⇧F hit in the same chat), which an earlier version lost.
 */
import React from 'react';
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { cleanup, waitFor, act } from '@testing-library/react';

vi.mock('@/layers/shared/model', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/layers/shared/model')>();
  return { ...actual, useEventSubscription: () => {} };
});
vi.mock('streamdown', () => ({
  Streamdown: ({ children }: { children: string }) => <div>{children}</div>,
}));
vi.mock('@/layers/features/entry-actions/ui/EntryRunWithMenu', () => ({
  EntryRunWithMenu: () => null,
}));
vi.mock('@/layers/features/conversation', async () => ({
  ...(await vi.importActual<object>('@/layers/features/conversation')),
  ScrollThumb: () => null,
}));
vi.mock('@/layers/entities/agent/model/use-current-agent', () => ({
  useCurrentAgent: () => ({ data: null }),
}));
vi.mock('@/layers/entities/session/model/query/use-session-runtime', () => ({
  useSessionRuntime: () => 'claude-code',
}));
const scrollToEnd = vi.fn();
const scrollToIndex = vi.fn();
vi.mock('@tanstack/react-virtual', () => ({
  useVirtualizer: ({ count }: { count: number }) => ({
    getVirtualItems: () =>
      Array.from({ length: count }, (_, i) => ({
        key: `v${i}`,
        index: i,
        start: i * 80,
        size: 80,
      })),
    getTotalSize: () => count * 80,
    measureElement: vi.fn(),
    scrollToEnd,
    scrollToIndex,
    isAtEnd: () => true,
  }),
}));

import { SessionTranscript } from '../ui/SessionTranscript';
import { useMessageLanding } from '../model/use-message-landing';
import { useHistoryWindowStore } from '@/layers/entities/session';
import type { ChatMessage } from '@/layers/shared/model';
import {
  createReadCursorHarness,
  renderWithTransport,
  sessionCursor,
} from './session-transcript-test-helpers';

const SID = 'long-session';

/** A plain user message. */
function msg(id: string): ChatMessage {
  return {
    id,
    role: 'user',
    content: id,
    parts: [{ type: 'text', text: id }],
    timestamp: new Date().toISOString(),
  };
}
const windowMessages = ['w0', 'w1', 'w2'].map(msg);

/** The page with the linked message: one older message, nothing before it. */
function harnessWithOlderPage() {
  const harness = createReadCursorHarness();
  harness.storedCursor = sessionCursor(SID, 1000);
  harness.transport.getMessages = vi.fn(async () => ({
    messages: [{ id: 'old-7', role: 'user' as const, content: 'old' }],
    earlierMessages: 0,
  }));
  return harness;
}

/** The page as `SessionPage` wires it: the landing hook feeding the transcript. */
function Page({ messageId }: { messageId?: string }) {
  const landOnRow = useMessageLanding(SID, messageId);
  return (
    <SessionTranscript
      sessionId={SID}
      messages={windowMessages}
      {...(landOnRow ? { landOnRow } : {})}
    />
  );
}

/** Where the transcript centred a landing, or undefined if it never did. */
function centredOn(): number | undefined {
  const call = scrollToIndex.mock.calls.find(([, opts]) => opts?.align === 'center');
  return call?.[0] as number | undefined;
}

beforeEach(() => {
  useHistoryWindowStore.setState({ sessions: {}, seeks: {} });
  useHistoryWindowStore.getState().noteSnapshot(SID, 'w0', 1);
  scrollToEnd.mockClear();
  scrollToIndex.mockClear();
});
afterEach(cleanup);

describe('a link to a message older than the window', () => {
  it('lands on it when followed inside the chat already open', async () => {
    const harness = harnessWithOlderPage();
    const view = renderWithTransport(<Page />, harness.transport);
    await waitFor(() => expect(scrollToEnd).toHaveBeenCalled());

    view.rerender(<Page messageId="old-7" />);

    await waitFor(() => expect(harness.transport.getMessages).toHaveBeenCalled());
    // Row 0 is the linked message itself, now read in at the top.
    await waitFor(() => expect(centredOn()).toBe(0));
  });

  it('lands on it when arriving with the link', async () => {
    const harness = harnessWithOlderPage();

    renderWithTransport(<Page messageId="old-7" />, harness.transport);

    await waitFor(() => expect(centredOn()).toBe(0));
    expect(harness.transport.getMessages).toHaveBeenCalledTimes(1);
  });

  it('settles without reading anything when the link names a message already loaded', async () => {
    const harness = harnessWithOlderPage();

    renderWithTransport(<Page messageId="w2" />, harness.transport);

    await waitFor(() => expect(centredOn()).toBeDefined());
    await act(async () => {});
    expect(harness.transport.getMessages).not.toHaveBeenCalled();
  });
});
