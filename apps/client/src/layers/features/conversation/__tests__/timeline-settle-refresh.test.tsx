// @vitest-environment jsdom
/**
 * The timeline remembers the reader's spot from SETTLED geometry, not only from
 * scroll events.
 *
 * The bug this guards: the remembered top row was captured ONLY on DOM scroll
 * events. When a reader scrolls up into history the virtualizer has not measured
 * yet, its layout settles a moment AFTER the last scroll event — it measures the
 * rows just scrolled into and the same offset comes to rest on a different row —
 * and with no new scroll event, the remembered row was left a row stale. Coming
 * back from a thread then restored to that stale row: off by one.
 *
 * jsdom lays nothing out, so the virtualizer is stood in for — its geometry is
 * whatever this test hands it. That is exactly what makes the settle testable
 * here: swap the virtual items to the SETTLED sizes and fire the virtualizer's
 * `onChange`, which is the signal a real settle raises, with no scroll event.
 */
import type { ReactNode } from 'react';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createMockTransport } from '@dorkos/test-utils';
import { TransportProvider } from '@/layers/shared/model';

/**
 * The virtualizer, stood in for and made controllable.
 *
 * `items` is the geometry the timeline reads back (a real virtualizer computes
 * it from measured DOM; here the test sets it). `onChange` is the settle signal
 * the timeline wires — captured so the test can raise it the way a real
 * measurement would, deliberately WITHOUT a scroll event.
 */
const virt = vi.hoisted(() => ({
  items: [] as Array<{ key: string; index: number; start: number; size: number; end: number }>,
  onChange: undefined as ((instance: { isScrolling: boolean }, sync?: boolean) => void) | undefined,
}));

vi.mock('@tanstack/react-virtual', () => ({
  useVirtualizer: (options: {
    count: number;
    onChange?: (instance: { isScrolling: boolean }, sync?: boolean) => void;
  }) => {
    virt.onChange = options.onChange;
    return {
      getVirtualItems: () => virt.items,
      getTotalSize: () => virt.items.reduce((sum, item) => sum + item.size, 0),
      measureElement: vi.fn(),
      scrollToEnd: vi.fn(),
      scrollToIndex: vi.fn(),
      // False, so the reader reads as scrolled up: a caught-up reader is the one
      // case the remembered row is supposed to be `undefined`.
      isAtEnd: () => false,
    };
  },
}));

import { Conversation } from '..';
import type { ConversationCapabilities } from '../model/capabilities';
import type { ConversationRow, ConversationRowRenderer } from '../lib/row-kinds';

/** No capability on — this is about geometry, not what a row can do. */
const BASE: ConversationCapabilities = {
  reactions: false,
  threads: false,
  runWith: false,
  attachments: false,
  mentions: false,
  streamHealth: false,
  presence: false,
  turnStatus: false,
  asks: false,
};

/** Turn a list of row heights into the virtual items the timeline reads. */
function itemsFromSizes(sizes: readonly number[]) {
  let start = 0;
  return sizes.map((size, index) => {
    const item = { key: `virt-${index}`, index, start, size, end: start + size };
    start += size;
    return item;
  });
}

/** One message row. */
function messageRow(id: string): ConversationRow {
  return {
    kind: 'message',
    id,
    payload: { text: id },
    grouping: { position: 'only' },
    author: { kind: 'human', id: 'author-me', displayName: 'Dorian' },
    at: '2026-08-18T10:00:00.000Z',
  };
}

/** Draws each row as a plain line. */
const renderRow: ConversationRowRenderer = (row) => <div data-testid={`row-${row.id}`} />;

/** The providers the timeline's rows reach through. */
function Providers({ children }: { children: ReactNode }) {
  return (
    <QueryClientProvider
      client={
        new QueryClient({
          defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
        })
      }
    >
      <TransportProvider transport={createMockTransport()}>{children}</TransportProvider>
    </QueryClientProvider>
  );
}

const ROWS = [
  messageRow('e0'),
  messageRow('e1'),
  messageRow('e2'),
  messageRow('e3'),
  messageRow('e4'),
];

/**
 * Mount a timeline and hand back the scroller plus the `onTopRow` spy.
 *
 * The scroller is given a real (fixed) geometry, because jsdom reports 0 for all
 * three and `0 - scrollTop - 0` reads as "at the bottom" for any offset — which
 * would make every remembered row `undefined`.
 */
function mountTimeline() {
  const onTopRow = vi.fn<(id: string | undefined) => void>();
  render(
    <Providers>
      <Conversation.Root surface="room" capabilities={BASE}>
        <Conversation.Timeline
          conversationId="room-1"
          label="Messages in #mio"
          rows={ROWS}
          renderRow={renderRow}
          onTopRow={onTopRow}
        />
      </Conversation.Root>
    </Providers>
  );
  const scroller = screen.getByTestId('conversation-scroller');
  Object.defineProperty(scroller, 'scrollHeight', { configurable: true, value: 10_000 });
  Object.defineProperty(scroller, 'clientHeight', { configurable: true, value: 800 });
  Object.defineProperty(scroller, 'scrollTop', { configurable: true, writable: true, value: 170 });
  return { scroller, onTopRow };
}

beforeAll(() => {
  Element.prototype.scrollTo = function scrollTo() {} as Element['scrollTo'];
  Element.prototype.scrollIntoView = vi.fn();
});

describe('Conversation.Timeline — remembering the reader’s spot', () => {
  it('re-reads the top row when the virtualizer settles after a scroll, with no new scroll event', () => {
    // Pre-settle: every row at the 80px estimate. At scrollTop 170 the first row
    // whose end clears the offset is e2 (ends: 80, 160, 240 …).
    virt.items = itemsFromSizes([80, 80, 80, 80, 80]);
    const { scroller, onTopRow } = mountTimeline();

    fireEvent.scroll(scroller);
    expect(onTopRow).toHaveBeenLastCalledWith('e2');

    // The rows scrolled into now measure their real, shorter heights, so the
    // SAME offset comes to rest on e3 (ends: 40, 80, 120, 240 …). This is the
    // settle — geometry changed, no scroll event.
    virt.items = itemsFromSizes([40, 40, 40, 120, 120]);
    virt.onChange?.({ isScrolling: false });

    // Without the settle-refresh the remembered row would still be the stale e2.
    expect(onTopRow).toHaveBeenLastCalledWith('e3');
  });

  it('leaves the capture to the scroll handler while the list is still moving', () => {
    virt.items = itemsFromSizes([80, 80, 80, 80, 80]);
    const { scroller, onTopRow } = mountTimeline();

    fireEvent.scroll(scroller);
    expect(onTopRow).toHaveBeenLastCalledWith('e2');
    onTopRow.mockClear();

    // A recompute mid-scroll (`isScrolling: true`) must NOT re-capture — the
    // scroll handler owns an active scroll, and re-reading here would be
    // redundant work on every frame.
    virt.items = itemsFromSizes([40, 40, 40, 120, 120]);
    virt.onChange?.({ isScrolling: true });

    expect(onTopRow).not.toHaveBeenCalled();
  });
});
