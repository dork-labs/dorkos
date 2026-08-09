/**
 * What every `MessageList` suite needs before it can mount one: the transport
 * its read cursor is held in (team-room-home §D4).
 *
 * The unread rule is server state now, so the list does not render outside a
 * `TransportProvider` at all — including in the suites that have nothing to say
 * about read state. Shared from here so those suites stay about what they are
 * about, and so the one that DOES assert on the cursor drives it through the
 * same harness.
 *
 * @module features/chat/__tests__/message-list-test-helpers
 */
import React from 'react';
import { vi } from 'vitest';
import { render, type RenderOptions, type RenderResult } from '@testing-library/react';
import type { ReadCursor } from '@dorkos/shared/read-cursor-schemas';
import type { Transport } from '@dorkos/shared/transport';
import { createMockTransport } from '@dorkos/test-utils';
import { TransportProvider } from '@/layers/shared/model';

/** The author id every cursor in these suites belongs to. */
const HARNESS_USER_ID = 'author-me';

/**
 * A stored session cursor, counting `lastReadSeq` messages of `threadId` as
 * seen.
 *
 * @param threadId - The session.
 * @param lastReadSeq - How many messages have been seen.
 */
export function sessionCursor(threadId: string, lastReadSeq: number): ReadCursor {
  return {
    userId: HARNESS_USER_ID,
    threadKind: 'session',
    threadId,
    lastReadSeq,
    updatedAt: new Date().toISOString(),
  };
}

/** A transport standing in for the read-cursor route, with what it was told. */
export interface ReadCursorHarness {
  /** The transport to render inside. */
  transport: Transport;
  /** What the route answers on the next read. Assign before rendering. */
  storedCursor: ReadCursor | null;
  /** Positions the list has asked the route to store, in order. */
  written: number[];
  /** Forget both, between tests. */
  reset: () => void;
}

/**
 * A transport whose read-cursor half is a recording stub.
 *
 * Reads answer with whatever `storedCursor` holds at the moment they are made —
 * a getter rather than a captured value, so a test sets the cursor it wants and
 * then renders, in that order.
 */
export function createReadCursorHarness(): ReadCursorHarness {
  const harness: ReadCursorHarness = {
    transport: undefined as unknown as Transport,
    storedCursor: null,
    written: [],
    reset: () => {
      harness.storedCursor = null;
      harness.written = [];
    },
  };
  harness.transport = createMockTransport({
    getReadCursor: vi.fn(async () => harness.storedCursor),
    setReadCursor: vi.fn(async (_kind: unknown, threadId: string, lastReadSeq: number) => {
      harness.written.push(lastReadSeq);
      return sessionCursor(threadId, lastReadSeq);
    }),
  });
  return harness;
}

/**
 * Render inside a transport, so anything the list reads through one resolves.
 *
 * @param ui - What to render.
 * @param transport - The transport to provide, usually a harness's.
 * @param options - Passed through to Testing Library.
 */
export function renderWithTransport(
  ui: React.ReactElement,
  transport: Transport,
  options?: Omit<RenderOptions, 'wrapper'>
): RenderResult {
  return render(ui, {
    ...options,
    wrapper: ({ children }: { children: React.ReactNode }) => (
      <TransportProvider transport={transport}>{children}</TransportProvider>
    ),
  });
}
