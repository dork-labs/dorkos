/**
 * @vitest-environment jsdom
 *
 * A reloaded conversation must show a failed sign-in the way the live turn
 * showed it: an error card with a way out, not a sentence the agent appears to
 * have said (DOR-1649).
 *
 * The server now hydrates the CLI's synthetic API-error record as a typed
 * `error` part, so this drives the two production seams that stand between that
 * part and the screen — `mapHistoryMessage`, then `AssistantMessageContent`.
 */
import React from 'react';
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { HistoryMessage } from '@dorkos/shared/types';
import { createMockTransport } from '@dorkos/test-utils';
import { TransportProvider } from '@/layers/shared/model';
import type { ChatMessage } from '@/layers/shared/model/chat-message-types';
import {
  mapHistoryMessage,
  reconcileTaggedMessages,
} from '../../../model/stream/stream-history-helpers';
import { MessageProvider } from '../MessageContext';
import { AssistantMessageContent } from '../AssistantMessageContent';

// The error card deep-links to Settings → Runtimes, which needs TanStack Router
// context. Everything else in the module is the real thing.
const { openSettings } = vi.hoisted(() => ({ openSettings: vi.fn() }));
vi.mock('@/layers/shared/model', async () => {
  const actual = await vi.importActual<Record<string, unknown>>('@/layers/shared/model');
  return { ...actual, useSettingsDeepLink: () => ({ open: openSettings }) };
});

/** The message the server builds from the CLI's expired-sign-in record. */
const authFailureHistory: HistoryMessage = {
  id: 'aae96903-ccea-4fdc-a73c-34116a710dd8',
  role: 'assistant',
  content: '',
  parts: [
    {
      type: 'error',
      message: 'Your Claude sign-in stopped working. Sign in again to keep going.',
      category: 'auth_error',
      details: 'Failed to authenticate: OAuth session expired and could not be refreshed',
    },
  ],
  timestamp: '2026-09-01T12:06:43.988Z',
};

/**
 * Render as production does. `onRetry` defaults to a wired handler because
 * ChatPanel always wires one, and it re-sends the session's LAST user message —
 * which is exactly what must not be offered from an unclassifiable card.
 *
 * The query/transport providers are here because the card can now sign the
 * runtime back in from the conversation (DOR-1651), and naming a session is
 * what lets it: with a `sessionId` in context it reads the session list to
 * learn which runtime failed. That read is genuinely needed here — production
 * always has both providers — and the session is deliberately left ABSENT from
 * the list, which is the honest shape for a hydrated card whose session may not
 * be in the current working directory's listing at all. Unknown runtime means
 * no sign-in to offer, so the deep-link below is what renders.
 */
function renderMessage(message: ChatMessage, onRetry: (() => void) | undefined = vi.fn()) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 }, mutations: { retry: false } },
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <TransportProvider transport={createMockTransport()}>
        <MessageProvider
          value={{
            sessionId: 'session-1',
            isStreaming: false,
            isLatestWidgetMessage: false,
            activeToolCallId: null,
            onToolRef: undefined,
            focusedOptionIndex: 0,
            onToolDecided: undefined,
            onRetry,
            inputZoneToolCallId: null,
            runtimeLabel: 'Claude',
          }}
        >
          <AssistantMessageContent message={message} />
        </MessageProvider>
      </TransportProvider>
    </QueryClientProvider>
  );
}

/** Render a message straight off the wire, through the history mapper. */
function renderHydrated(message: HistoryMessage, onRetry: (() => void) | undefined = vi.fn()) {
  return renderMessage(mapHistoryMessage(message), onRetry);
}

/** The uncategorised tier: a limit notice in the CLI's own words. */
const limitNoticeHistory: HistoryMessage = {
  id: 'limit-1',
  role: 'assistant',
  content: '',
  parts: [{ type: 'error', message: "You've hit your weekly limit · resets Aug 24 at 8pm" }],
};

describe('a hydrated API-error notice', () => {
  afterEach(() => {
    cleanup();
    openSettings.mockClear();
  });

  it('renders the sign-in card, not agent speech', () => {
    renderHydrated(authFailureHistory);

    expect(screen.getByTestId('error-message-block')).toBeInTheDocument();
    expect(screen.getByText('Sign in to Claude again')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /fix sign-in/i })).toBeInTheDocument();
  });

  it('keeps the CLI wording out of the conversation and behind Details', () => {
    renderHydrated(authFailureHistory);

    // The vendor sentence is the collapsed detail, never the message body.
    expect(
      screen.queryByText('Failed to authenticate: OAuth session expired and could not be refreshed')
    ).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: /details/i })).toBeInTheDocument();
  });

  it('shows an uncategorised notice in the CLI wording, still as a card', () => {
    renderHydrated(limitNoticeHistory);

    expect(screen.getByTestId('error-message-block')).toBeInTheDocument();
    expect(
      screen.getByText("You've hit your weekly limit · resets Aug 24 at 8pm")
    ).toBeInTheDocument();
  });

  // The blocker this test exists for: ChatPanel always wires `onRetry`, and it
  // re-sends the session's LAST user message. On a limit notice sitting in the
  // middle of a conversation that is an unrelated prompt, sent without warning.
  it('offers no Retry on an uncategorised notice, even with onRetry wired', () => {
    const onRetry = vi.fn();
    renderHydrated(limitNoticeHistory, onRetry);

    expect(screen.queryByRole('button', { name: /retry/i })).not.toBeInTheDocument();
    // The card is still there, and the words still lead.
    expect(
      screen.getByText("You've hit your weekly limit · resets Aug 24 at 8pm")
    ).toBeInTheDocument();
  });

  it('keeps Retry beside Fix sign-in on the categorised auth card', () => {
    const onRetry = vi.fn();
    renderHydrated(authFailureHistory, onRetry);

    expect(screen.getByRole('button', { name: /fix sign-in/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /retry/i })).toBeInTheDocument();
  });

  // The turn-end reconcile is why this server-side mapping matters to a turn
  // nobody reloaded. `reconcileTaggedMessages` takes the SERVER's parts as the
  // winner, so whatever the live stream folded in is replaced by canonical
  // history the moment the turn settles. Before this change that history carried
  // the vendor sentence as plain text, which is how a live auth failure ended up
  // reading as agent speech until the page was refreshed (DOR-1690). This pins
  // the swap: same content, delivered by the reconcile rather than a reload.
  it('keeps the card when the turn-end reconcile swaps in canonical history', () => {
    const live: ChatMessage[] = [
      {
        id: 'tag-user',
        role: 'user',
        content: 'carry on',
        parts: [{ type: 'text', text: 'carry on' }],
        timestamp: '',
        _streaming: true,
      },
      {
        id: 'tag-assistant',
        role: 'assistant',
        content: '',
        parts: [],
        timestamp: '',
        _streaming: true,
      },
    ];
    const history: HistoryMessage[] = [
      { id: 'h-user', role: 'user', content: 'carry on' },
      authFailureHistory,
    ];

    let reconciled = live;
    reconcileTaggedMessages(live, history, (fn) => {
      reconciled = fn(reconciled);
    });

    const assistant = reconciled.find((m) => m.role === 'assistant');
    expect(assistant?.parts).toEqual(authFailureHistory.parts);
    expect(assistant?._streaming).toBe(false);

    // And that swapped-in content renders the card, not a sentence.
    renderMessage(assistant!);

    expect(screen.getByTestId('error-message-block')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /fix sign-in/i })).toBeInTheDocument();
  });

  it('leaves an ordinary hydrated reply as plain text', () => {
    renderHydrated({
      id: 'ok-1',
      role: 'assistant',
      content: 'Your OAuth token expired, so I refreshed it.',
    });

    expect(screen.queryByTestId('error-message-block')).not.toBeInTheDocument();
    expect(screen.getByText('Your OAuth token expired, so I refreshed it.')).toBeInTheDocument();
  });
});
