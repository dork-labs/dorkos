// @vitest-environment jsdom
/**
 * A chat drawn as a direct message (DOR-3074) names both sides the way a room
 * does: the agent it is with on every reply, and the person by their name, each
 * with a face and a time, both on the left. Everything else is the session's.
 */
import React from 'react';
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { screen, cleanup } from '@testing-library/react';
import type { ChatMessage } from '@/layers/shared/model';
import { SessionTranscript } from '../ui/SessionTranscript';
import { createReadCursorHarness, renderWithTransport } from './session-transcript-test-helpers';

vi.mock('@/layers/shared/model', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/layers/shared/model')>()),
  useEventSubscription: () => {},
}));
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
vi.mock('@tanstack/react-virtual', () => ({
  useVirtualizer: ({ count }: { count: number }) => ({
    getVirtualItems: () =>
      Array.from({ length: count }, (_, i) => ({
        key: `v-${i}`,
        index: i,
        start: i * 80,
        size: 80,
      })),
    getTotalSize: () => count * 80,
    measureElement: vi.fn(),
    scrollToEnd: vi.fn(),
    scrollToIndex: vi.fn(),
    isAtEnd: () => true,
  }),
}));

const readState = createReadCursorHarness();

beforeEach(() => readState.reset());
afterEach(cleanup);

const AT = new Date().toISOString();
const MESSAGES: ChatMessage[] = [
  {
    id: 'u1',
    role: 'user',
    content: 'Ship it?',
    parts: [{ type: 'text', text: 'Ship it?' }],
    timestamp: AT,
  },
  {
    id: 'a1',
    role: 'assistant',
    content: 'Shipped.',
    parts: [{ type: 'text', text: 'Shipped.' }],
    timestamp: AT,
  },
];

const SCOUT = { id: 'scout-manifest', displayName: 'Scout', emoji: '🦊', color: 'hsl(20 80% 50%)' };

/** The names on the author lines, in order. */
function authorNames(): string[] {
  return Array.from(document.querySelectorAll('[data-slot="message-author"]')).map(
    (line) => line.firstElementChild?.textContent ?? ''
  );
}

describe('SessionTranscript as a direct message', () => {
  it('names the person and the agent the way a room does', () => {
    renderWithTransport(
      <SessionTranscript
        sessionId="scout-direct"
        messages={MESSAGES}
        directMessage={{ agent: SCOUT, humanName: 'Dorian', settled: true }}
      />,
      readState.transport
    );

    expect(authorNames()).toEqual(['Dorian', 'Scout']);
    // Each side opens its group with a face in the gutter, the room's look.
    expect(document.querySelectorAll('[data-slot="message-author-avatar"]')).toHaveLength(2);
    expect(screen.getByText('Ship it?')).toBeInTheDocument();
  });

  it('says "You" for a person with no name yet, and keeps the agent', () => {
    renderWithTransport(
      <SessionTranscript
        sessionId="scout-direct"
        messages={MESSAGES}
        directMessage={{ agent: SCOUT, humanName: null, settled: true }}
      />,
      readState.transport
    );

    expect(authorNames()).toEqual(['You', 'Scout']);
  });

  it('is the session transcript, unchanged, without it', () => {
    renderWithTransport(
      <SessionTranscript sessionId="scout-direct" messages={MESSAGES} />,
      readState.transport
    );

    // No agent at the folder: the runtime's brand, exactly as before.
    expect(authorNames()).toEqual(['You', 'Claude Code']);
  });

  it('names a time on every message, even one that carries none of its own', () => {
    const untimed = MESSAGES.map((message) => ({ ...message, timestamp: '' }));
    renderWithTransport(
      <SessionTranscript
        sessionId="scout-direct"
        messages={untimed}
        directMessage={{ agent: SCOUT, humanName: 'Dorian', settled: true }}
      />,
      readState.transport
    );

    const times = document.querySelectorAll('[data-slot="message-author"] time');
    expect(times).toHaveLength(2);
    for (const time of times) expect(time.getAttribute('datetime')).toMatch(/^\d{4}-/);
  });

  it('keeps a message’s own time as its time', () => {
    renderWithTransport(
      <SessionTranscript
        sessionId="scout-direct"
        messages={MESSAGES}
        directMessage={{ agent: SCOUT, humanName: 'Dorian', settled: true }}
      />,
      readState.transport
    );

    const times = document.querySelectorAll('[data-slot="message-author"] time');
    expect(Array.from(times, (time) => time.getAttribute('datetime'))).toEqual([AT, AT]);
  });
});
