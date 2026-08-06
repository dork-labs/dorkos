// @vitest-environment jsdom
/**
 * The gesture race between a mention pill's identity card and the message
 * row's own touch-only actions drawer.
 *
 * A resolved mention pill lives inside `EntryActionMenu`, which — on a touch
 * screen (`useIsMobile`) — arms its OWN long-press on the whole row to open a
 * message-actions drawer (`ResponsiveContextMenuTrigger` → `MobileTrigger`,
 * `responsive-context-menu.tsx`). `IdentityHoverCard` arms a SECOND long-press
 * on the pill itself, for the identity card. Both start from the identical
 * `pointerdown`: without gesture priority, holding a pill races both timers
 * and can open the drawer AND the card at once — verified failing against the
 * pre-fix tree (DOR-953 review, must-fix #1). The fix gives the more specific
 * target (the pill) priority: its `pointerdown` handler calls
 * `stopPropagation` for touch/pen presses, so the row's own long-press never
 * arms. This file pins both directions: a hold that starts ON the pill opens
 * the card and never the drawer; a hold that starts anywhere ELSE on the
 * message still opens the drawer exactly as it always has.
 *
 * Real timers throughout, deliberately (see `identity-hover-card.test.tsx`'s
 * `withFakeTimers` doc for why): the identity card's own dismiss layer
 * schedules a real `setTimeout(0)` on mount, and the reviewer's own repro
 * used real timers with `matchMedia.matches` flipped to `true` — this
 * reproduces that harness rather than a fake-timer approximation of it.
 */
import { describe, it, expect, vi, beforeAll, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createMockTransport } from '@dorkos/test-utils';
import type { MentionSpan, RoomEntry } from '@dorkos/shared/room-schemas';
import { TIMING } from '@/layers/shared/lib';
import { useRoomDraftStore, useRoomOpenThreadStore } from '@/layers/entities/room';
import { TransportProvider } from '@/layers/shared/model';
import { TooltipProvider } from '@/layers/shared/ui';
import type { RosterAuthor } from '../lib/room-timeline';
import { RoomEntryRow } from '../ui/RoomEntryRow';

/**
 * A touch screen. `useIsMobile` reads `matchMedia`, and it is what decides
 * whether `EntryActionMenu` arms a right-click menu (desktop, no competing
 * long-press at all) or the mobile drawer's own long-press — only the latter
 * can race the pill's gesture, so this must be `true` for the race to be
 * reachable at all (`RoomEntryRow.mentions.test.tsx` deliberately mocks this
 * `false`, which is why it never saw this bug).
 */
beforeAll(() => {
  Object.defineProperty(window, 'matchMedia', {
    writable: true,
    value: vi.fn().mockImplementation((query: string) => ({
      matches: true,
      media: query,
      onchange: null,
      addListener: vi.fn(),
      removeListener: vi.fn(),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      dispatchEvent: vi.fn(),
    })),
  });
});

afterEach(() => {
  cleanup();
  useRoomDraftStore.setState({ drafts: {} });
  useRoomOpenThreadStore.setState({ open: {} });
});

/** The room's roster — resolved mentions draw their identity from here, and nowhere else. */
const AUTHORS = new Map<string, RosterAuthor>([
  ['ana', { id: 'ana', kind: 'human', displayName: 'Ana', mentionHandle: 'ana', origin: 'local' }],
  [
    'bo',
    {
      id: 'bo',
      kind: 'agent',
      displayName: 'Bo',
      mentionHandle: 'bo',
      color: '#7c9cf5',
      origin: 'local',
    },
  ],
]);

function entry(text: string, mentionSpans?: MentionSpan[]): RoomEntry {
  return {
    roomId: 'room-1',
    seq: 1,
    id: 'entry-1',
    authorId: 'ana',
    kind: 'post',
    body: { text },
    mentions: mentionSpans?.map((s) => s.authorId) ?? [],
    ...(mentionSpans ? { mentionSpans } : {}),
    sessionId: null,
    cascadeRoot: 'entry-1',
    cascadeDepth: 0,
    parentEntryId: null,
    threadRootEntryId: null,
    signature: null,
    createdAt: '2026-07-26T10:00:00.000Z',
  };
}

/** One span, positioned by slicing `text` so a test cannot mistype an offset. */
function spanFor(text: string, needle: string, authorId: string): MentionSpan {
  const offset = text.indexOf(needle);
  if (offset === -1) throw new Error(`fixture error: "${needle}" is not in "${text}"`);
  return { offset, length: needle.length, authorId };
}

function renderRow(target: RoomEntry) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return render(
    <RoomEntryRow
      roomId="room-1"
      entry={target}
      author={{ id: 'ana', kind: 'human', displayName: 'Ana' }}
      authorRef={AUTHORS.get('ana')}
      authors={AUTHORS}
      viewerAuthorId="ana"
      authorNames={new Map([['ana', 'Ana']])}
      reactionFrequents={['👍', '❤️', '🎉']}
      grouping={{ position: 'only' }}
    />,
    {
      wrapper: ({ children }) => (
        <QueryClientProvider client={queryClient}>
          <TransportProvider transport={createMockTransport()}>
            <TooltipProvider>{children}</TooltipProvider>
          </TransportProvider>
        </QueryClientProvider>
      ),
    }
  );
}

/** The message body's own content region — both the pill and its surrounding plain text live here. */
function content(): HTMLElement {
  return document.querySelector('[data-slot="message-content"]') as HTMLElement;
}

/** The resolved mention pill inside the message body (see the doc on the equivalent helper in `RoomEntryRow.mentions.test.tsx` for why `data-kind` is the query). */
function pillOf(): HTMLElement {
  const pill = content().querySelector<HTMLElement>('[data-kind]');
  if (!pill) throw new Error('fixture error: no resolved mention pill in this message');
  return pill;
}

/** Holds a REAL touch press on `target` until the long-press threshold has genuinely elapsed. */
async function realLongPress(target: HTMLElement) {
  fireEvent.pointerDown(target, { button: 0, clientX: 10, clientY: 10, pointerType: 'touch' });
  await new Promise((resolve) => setTimeout(resolve, TIMING.LONG_PRESS_MS + 50));
  fireEvent.pointerUp(target);
}

describe('RoomEntryRow — touch gesture priority between a mention pill and the message drawer', () => {
  it('long-pressing the mention pill opens its identity card, never the message drawer', async () => {
    const text = 'hey @bo can you take a look?';
    renderRow(entry(text, [spanFor(text, '@bo', 'bo')]));

    await realLongPress(pillOf());

    expect(await screen.findByText('View profile')).toBeInTheDocument();
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('long-pressing the message elsewhere still opens the drawer, never the identity card', async () => {
    const text = 'hey @bo can you take a look?';
    renderRow(entry(text, [spanFor(text, '@bo', 'bo')]));

    // The message body itself, NOT the pill inside it — a hold that starts
    // here has nothing claiming gesture priority, so it must reach the row's
    // own long-press exactly as it did before the pill existed.
    await realLongPress(content());

    expect(await screen.findByRole('dialog')).toBeInTheDocument();
    expect(screen.queryByText('View profile')).not.toBeInTheDocument();
  });
});
