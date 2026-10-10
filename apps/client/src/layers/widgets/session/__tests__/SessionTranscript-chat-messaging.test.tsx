// @vitest-environment jsdom
/**
 * Chats messaging chats in a session's transcript (spec `spin-off-chats` §6):
 * a "Stopped by" line is a quiet system row, not a message — it takes no
 * message's place in the feed, the final-message rule, the new-row latch or
 * the read cursor — and a spin-off's folded first prompt reads as the words
 * another chat sent, never their fence.
 */
import type React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { cleanup, fireEvent, screen, waitFor } from '@testing-library/react';
import type { ChatStopNotice } from '@dorkos/shared/chat-messages';

vi.mock('@/layers/shared/model', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/layers/shared/model')>();
  return { ...actual, useEventSubscription: () => {} };
});

const { captured, activity } = vi.hoisted(() => ({
  captured: [] as unknown[],
  activity: { sent: [] as unknown[], stops: [] as unknown[] },
}));

vi.mock('@/layers/features/chat/model/messaging/use-chat-activity', () => ({
  useChatActivity: () => activity,
}));
vi.mock('../ui/SessionMessage', () => ({
  SessionMessage: (props: unknown) => {
    captured.push(props);
    return <div data-testid="message-item" />;
  },
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
vi.mock('@tanstack/react-router', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@tanstack/react-router')>()),
  useNavigate: () => vi.fn(),
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
import type { ChatMessage } from '@/layers/shared/model';
import { createReadCursorHarness, renderWithTransport } from './session-transcript-test-helpers';

const readState = createReadCursorHarness();

function render(ui: React.ReactElement) {
  return renderWithTransport(ui, readState.transport);
}

interface Captured {
  message: ChatMessage;
  isNew: boolean;
  isFinalMessage: boolean;
  feedPosition: { index: number; total: number };
}

function rows(): Captured[] {
  return captured as Captured[];
}

function at(minute: number): string {
  const d = new Date();
  d.setHours(10, minute, 0, 0);
  return d.toISOString();
}

function msg(id: string, minute: number, role: ChatMessage['role'] = 'assistant'): ChatMessage {
  return { id, role, content: id, parts: [{ type: 'text', text: id }], timestamp: at(minute) };
}

const STOP: ChatStopNotice = {
  id: 's1',
  by: { chatId: 'chat-b', chatTitle: 'Fix it', agentName: 'Builder' },
  reason: 'wrong branch',
  at: at(30),
};

beforeEach(() => {
  captured.length = 0;
  activity.stops = [];
  readState.reset();
});

afterEach(() => {
  cleanup();
  window.localStorage.clear();
});

describe('SessionTranscript and chat messaging', () => {
  it('draws a stop as a quiet system line, never through the message row', () => {
    activity.stops = [STOP];
    render(<SessionTranscript sessionId="s" messages={[msg('a', 0), msg('b', 45)]} />);
    expect(screen.getByTestId('chat-stop-line').textContent).toContain('Stopped by Builder');
    expect([...new Set(rows().map((r) => r.message.id))]).toEqual(['a', 'b']);
  });

  it('counts messages only: a stop moves no feed position and takes no final place', () => {
    activity.stops = [{ ...STOP, at: at(50) }];
    render(<SessionTranscript sessionId="s" messages={[msg('a', 0), msg('b', 45)]} />);
    const byId = new Map(rows().map((r) => [r.message.id, r]));
    expect(byId.get('b')?.isFinalMessage).toBe(true);
    expect(byId.get('a')?.feedPosition).toEqual({ index: 1, total: 2 });
    expect(byId.get('b')?.feedPosition).toEqual({ index: 2, total: 2 });
  });

  it('a stop arriving late does not animate history as new', () => {
    const history = [msg('a', 0), msg('b', 45)];
    const { rerender } = render(<SessionTranscript sessionId="s" messages={history} />);
    captured.length = 0;
    activity.stops = [{ ...STOP, at: at(10) }];
    rerender(<SessionTranscript sessionId="s" messages={[...history, msg('c', 55)]} />);
    const byId = new Map(rows().map((r) => [r.message.id, r]));
    expect(byId.get('b')?.isNew).toBe(false);
    expect(byId.get('c')?.isNew).toBe(true);
  });

  it('records only messages as read: a stop line is not one', async () => {
    activity.stops = [{ ...STOP, at: at(10) }];
    render(<SessionTranscript sessionId="s" messages={[msg('a', 0), msg('b', 45)]} />);
    await waitFor(() => expect(readState.written).toEqual([2]));
  });

  it('folds a spin-off’s first message as the words sent, not their fence', () => {
    const first: ChatMessage = {
      ...msg('u1', 0, 'user'),
      content:
        '--- BEGIN CHAT MESSAGE 0000abcd ---\nCut the release.\n--- END CHAT MESSAGE 0000abcd ---',
      chatMessages: [
        {
          id: 'cm-1',
          kind: 'start',
          from: { chatId: 'chat-a', agentName: 'Planner' },
          text: 'Cut the release.',
          delivery: 'queue',
          status: 'working',
          sentAt: at(0),
        },
      ],
    };
    render(<SessionTranscript sessionId="s" messages={[first, msg('a', 1)]} foldFirstPrompt />);
    fireEvent.click(screen.getByRole('button', { name: /What it was asked/ }));
    const prompt = screen.getByTestId('started-prompt');
    expect(prompt.textContent).toContain('Cut the release.');
    expect(prompt.textContent).not.toContain('BEGIN CHAT MESSAGE');
  });
});
