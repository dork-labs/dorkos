// @vitest-environment jsdom
/**
 * While a reply streams, only the row that changed draws again (DOR-2895).
 *
 * Drives the real transcript and the real memoized row, counting how often a
 * row's body is drawn. The parent hands a NEW `onRetry` on every render (the
 * chat panel's depends on the messages), so this fails if the transcript stops
 * keeping its row handlers stable, or if the row stops being memoized.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { cleanup } from '@testing-library/react';
import type { ChatMessage } from '@/layers/shared/model';
import { createReadCursorHarness, renderWithTransport } from './session-transcript-test-helpers';

const { bodyRenders } = vi.hoisted(() => ({ bodyRenders: [] as string[] }));

vi.mock('../ui/render-session-body', () => ({
  renderSessionBody: (message: ChatMessage) => {
    bodyRenders.push(message.id);
    return <p>{message.content}</p>;
  },
}));
vi.mock('@/layers/shared/model', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/layers/shared/model')>();
  return { ...actual, useEventSubscription: () => {} };
});
vi.mock('@/layers/features/conversation', async () => ({
  ...(await vi.importActual<object>('@/layers/features/conversation')),
  ScrollThumb: () => null,
}));
vi.mock('@/layers/features/entry-actions/ui/EntryRunWithMenu', () => ({
  EntryRunWithMenu: () => null,
}));
vi.mock('@/layers/entities/agent/model/use-current-agent', () => ({
  useCurrentAgent: () => ({ data: null }),
}));
vi.mock('@/layers/entities/session/model/query/use-session-runtime', () => ({
  useSessionRuntime: () => 'claude-code',
}));
vi.mock('@tanstack/react-virtual', () => ({
  useVirtualizer: ({ count }: { count: number }) => ({
    getVirtualItems: () =>
      Array.from({ length: count }, (_, i) => ({ key: `virt-${i}`, index: i, start: i * 80 })),
    getTotalSize: () => count * 80,
    measureElement: () => {},
    scrollToEnd: () => {},
    scrollToIndex: () => {},
    isAtEnd: () => true,
  }),
}));

import { SessionTranscript } from '../ui/SessionTranscript';

const readState = createReadCursorHarness();

afterEach(() => {
  cleanup();
  bodyRenders.length = 0;
});

const at = '2026-10-13T10:00:00.000Z';
const msg = (id: string, role: ChatMessage['role'], content: string): ChatMessage => ({
  id,
  role,
  content,
  parts: [{ type: 'text', text: content }],
  timestamp: at,
});

describe('SessionTranscript rows while a reply streams', () => {
  it('draws only the streaming row again, though the parent’s handlers are new', () => {
    const settled = [
      msg('u1', 'user', 'question'),
      msg('a1', 'assistant', 'answer'),
      msg('u2', 'user', 'next'),
    ];
    const transcript = (reply: string) => (
      <SessionTranscript
        sessionId="s1"
        messages={[...settled, msg('a2', 'assistant', reply)]}
        isTextStreaming
        onRetry={() => {}}
        onToolDecided={() => {}}
      />
    );
    const { rerender } = renderWithTransport(transcript('Thin'), readState.transport);
    bodyRenders.length = 0;

    rerender(transcript('Thinking'));
    rerender(transcript('Thinking about'));

    // The settled rows kept their message objects; only the reply moved.
    expect(bodyRenders.filter((id) => id !== 'a2')).toEqual([]);
    expect(bodyRenders.filter((id) => id === 'a2')).toHaveLength(2);
  });
});
