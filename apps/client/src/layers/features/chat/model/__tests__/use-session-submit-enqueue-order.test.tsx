/**
 * @vitest-environment jsdom
 *
 * DOR-1165: enqueue POSTs must be accepted in keystroke order.
 *
 * Each queued message is its own `POST .../messages` and the server orders the
 * queue by the order it ACCEPTS those requests. Under network skew, POSTs fired
 * back-to-back can arrive out of order and transpose what the person typed. The
 * fix chains a session's enqueue requests so request N+1 is not fired until
 * request N settles. This test drives the real {@link useSessionSubmit} hook and
 * asserts the mock Transport accepts the messages in call order even when the
 * FIRST request is the slowest — the exact reordering the chain must defeat.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import React from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { TransportProvider } from '@/layers/shared/model';
import { createMockTransport } from '@dorkos/test-utils';
import { useSessionSubmit } from '../use-session-submit';

const SESSION_ID = 'session-under-test';
const MESSAGES = ['first', 'second', 'third', 'fourth'];
/** Per-step skew, largest for the earliest call, so raw concurrency reverses. */
const SKEW_STEP_MS = 15;

describe('useSessionSubmit enqueue ordering (DOR-1165)', () => {
  let queryClient: QueryClient;

  beforeEach(() => {
    queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
    });
  });

  /**
   * A Transport whose `postMessage` records the order the server ACCEPTS each
   * message — captured after a skewed delay, not at invocation — so it models a
   * network that reorders back-to-back requests. The first call is delayed the
   * longest: fired concurrently, the messages would be accepted in reverse.
   */
  function makeSkewedTransport(accepted: string[]) {
    let callIndex = 0;
    return createMockTransport({
      postMessage: vi.fn((_sessionId: string, content: string) => {
        const delay = (MESSAGES.length - callIndex) * SKEW_STEP_MS;
        callIndex += 1;
        return new Promise<{ sessionId: string }>((resolve) => {
          setTimeout(() => {
            // The instant the server "accepts" this request into the queue.
            accepted.push(content);
            resolve({ sessionId: _sessionId });
          }, delay);
        });
      }),
    });
  }

  function renderSubmit(transport: ReturnType<typeof createMockTransport>) {
    const wrapper = ({ children }: { children: React.ReactNode }) => (
      <QueryClientProvider client={queryClient}>
        <TransportProvider transport={transport}>{children}</TransportProvider>
      </QueryClientProvider>
    );
    return renderHook(
      () =>
        useSessionSubmit({
          sessionId: SESSION_ID,
          input: '',
          status: 'idle',
          transport,
          queryClient,
          selectedCwd: '/test/project',
          onSessionIdChangeReplace: undefined,
          transformContent: undefined,
          launchRuntime: undefined,
          takeSeedContext: undefined,
          setInput: vi.fn(),
          setError: vi.fn(),
          tryNativeCommand: vi.fn(() => ({ handled: false, ran: false, confirmed: undefined })),
        }),
      { wrapper }
    );
  }

  it('accepts back-to-back enqueues in call order despite reverse network skew', async () => {
    const accepted: string[] = [];
    const transport = makeSkewedTransport(accepted);
    const { result } = renderSubmit(transport);

    // Fire every enqueue synchronously, in keystroke order, within one tick —
    // exactly the paste-and-Enter-hammer the bug describes.
    let settled: Promise<boolean[]>;
    await act(async () => {
      settled = Promise.all(MESSAGES.map((content) => result.current.enqueueContent(content)));
      await settled;
    });

    expect(await settled!).toEqual([true, true, true, true]);
    // The server saw them in the order they were typed, not the order the skewed
    // network would have delivered them (which, unsequenced, is reversed).
    expect(accepted).toEqual(MESSAGES);
  });
});
