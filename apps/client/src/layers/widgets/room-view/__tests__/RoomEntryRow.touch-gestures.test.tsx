// @vitest-environment jsdom
/**
 * The gesture race between a mention pill's identity card and other touch
 * gestures layered around and above it in a real room message.
 *
 * A resolved mention pill lives inside `EntryActionMenu`, which — on a touch
 * screen (`useIsMobile`) — arms its OWN long-press on the whole row to open a
 * message-actions drawer (`ResponsiveContextMenuTrigger` → `MobileTrigger`,
 * `responsive-context-menu.tsx`). `IdentityHoverCard` arms a SECOND long-press
 * on the pill itself, for the identity card. Both start from the identical
 * `pointerdown`: without gesture priority, holding a pill races both timers
 * and can open the drawer AND the card at once — verified failing against the
 * pre-fix tree (DOR-953 review round 2, must-fix #1).
 *
 * **The fix is a yield, not a sever.** The pill's trigger marks itself
 * `data-gesture-priority`, and `MobileTrigger`'s own `useLongPress` call
 * yields to that selector in its `pointerdown` handler — it simply never
 * arms a timer for a press that starts on a marked descendant. The FIRST
 * attempt used `event.stopPropagation()` instead, which also works for the
 * drawer race but was reverted (round 3): it severs the native event before
 * it reaches `document`, which is where every Radix `DismissableLayer` —
 * including some OTHER open overlay entirely unrelated to this row — listens
 * for "something pressed outside me." The third test below pins exactly the
 * case that broke: a touch press on the pill must still dismiss an
 * unrelated, already-open Radix popover, which only holds if the native
 * event keeps flowing normally.
 *
 * Real timers throughout, deliberately (see `identity-hover-card.test.tsx`'s
 * `withFakeTimers` doc for why): the identity card's own dismiss layer
 * schedules a real `setTimeout(0)` on mount, and the reviewer's own repro
 * used real timers with `matchMedia.matches` flipped to `true` — this
 * reproduces that harness rather than a fake-timer approximation of it.
 */
import { describe, it, expect, vi, beforeAll, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent, act, waitFor } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createMockTransport } from '@dorkos/test-utils';
import type { MentionSpan, RoomEntry, RoomEntryReaction } from '@dorkos/shared/room-schemas';
import { TIMING } from '@/layers/shared/lib';
import { useRoomDraftStore, useRoomOpenThreadStore } from '@/layers/entities/room';
import { TransportProvider } from '@/layers/shared/model';
import { TooltipProvider } from '@/layers/shared/ui';
import type { RosterAuthor } from '../lib/room-timeline';
import { RoomEntryRow } from '../ui/RoomEntryRow';

// A mention pill now reads route state to build its profile link
// (`useProfileDeepLink`), and these tests mount it with no router. The link's
// own behaviour has a dedicated file — `RoomEntryRow.click-to-profile.test.tsx`,
// which mounts a real router and asserts the id that travels. Here it is stubbed
// so the pill renders, which is what this file is actually about.
vi.mock('@/layers/shared/model', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/layers/shared/model')>();
  return {
    ...actual,
    useProfileDeepLink: () => ({
      isOpen: false,
      memberId: null,
      open: vi.fn(),
      close: vi.fn(),
    }),
  };
});

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
  ['ana', { id: 'ana', kind: 'human', displayName: 'Ana', handle: 'ana', origin: 'local' }],
  [
    'bo',
    {
      id: 'bo',
      kind: 'agent',
      displayName: 'Bo',
      handle: 'bo',
      color: '#7c9cf5',
      origin: 'local',
    },
  ],
]);

function entry(
  text: string,
  mentionSpans?: MentionSpan[],
  reactions?: RoomEntryReaction[]
): RoomEntry {
  return {
    roomId: 'room-1',
    seq: 1,
    id: 'entry-1',
    authorId: 'ana',
    kind: 'post',
    body: { text },
    mentions: mentionSpans?.map((s) => s.authorId) ?? [],
    ...(mentionSpans ? { mentionSpans } : {}),
    ...(reactions ? { reactions } : {}),
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

/** One reaction pill, as the wire carries it. */
function pill(emoji: string, authorIds: string[]): RoomEntryReaction {
  return { emoji, authorIds, firstAt: '2026-07-26T10:00:00.000Z' };
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
  const found = content().querySelector<HTMLElement>('[data-kind]');
  if (!found) throw new Error('fixture error: no resolved mention pill in this message');
  return found;
}

/**
 * Holds a REAL touch press on `target` until the long-press threshold has
 * genuinely elapsed.
 *
 * The plain wait is wrapped in `act()`: `useLongPress`'s own timer calls
 * `setState` from a raw `window.setTimeout`, entirely outside React's
 * awareness of the `fireEvent.pointerDown` call above it. Without `act()`
 * here, that state update can land between renders un-flushed — an
 * intermittent, hard-to-reproduce act-warning artifact of exactly this
 * shape, not a hypothetical.
 */
async function realLongPress(target: HTMLElement) {
  fireEvent.pointerDown(target, { button: 0, clientX: 10, clientY: 10, pointerType: 'touch' });
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, TIMING.LONG_PRESS_MS + 50));
  });
  fireEvent.pointerUp(target);
}

describe('RoomEntryRow — touch gesture priority between a mention pill and the message drawer', () => {
  it('long-pressing the mention pill opens its identity card, never the message drawer', async () => {
    const text = 'hey @bo can you take a look?';
    renderRow(entry(text, [spanFor(text, '@bo', 'bo')]));

    await realLongPress(pillOf());

    await waitFor(() =>
      expect(document.querySelector('[data-slot="identity-hover-card"]')).not.toBeNull()
    );
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
    // The CARD, by its slot — the drawer that just opened carries a "View
    // profile" action of its own now (DOR-1251), so the words alone no longer
    // tell the two surfaces apart.
    expect(document.querySelector('[data-slot="identity-hover-card"]')).toBeNull();
  });

  it('a touch press on the mention pill still dismisses an unrelated, already-open Radix popover', async () => {
    // The exact blast radius `stopPropagation` opened (review round 3): a
    // touch press on the pill's trigger severed the native event before it
    // ever reached `document`, so it could no longer close ANY other open
    // Radix `DismissableLayer` — not just another identity card. The reaction
    // picker is the real, reachable case: `EntryReactionRow` renders it (a
    // non-modal Radix `Popover`, no mobile gate) on every message that
    // already has a reaction, regardless of `useIsMobile`.
    const text = 'hey @bo can you take a look?';
    renderRow(entry(text, [spanFor(text, '@bo', 'bo')], [pill('👍', ['ana'])]));

    fireEvent.click(screen.getByTestId('entry-reactions-add'));
    // Waiting for the open assertion (rather than asserting synchronously
    // right after the click) also gives Radix's own `DismissableLayer` the
    // real tick it needs to arm its outside-pointerdown listener — it defers
    // that by a real `setTimeout(0)` specifically so it never catches the
    // very press that opened it.
    await waitFor(() => expect(screen.getByTestId('reaction-picker')).toBeInTheDocument());

    // A full tap sequence, not just `pointerdown`: Radix's non-modal
    // `Popover` sets `deferPointerDownOutside`, so it only ARMS its dismiss
    // on the outside `pointerdown` but doesn't fire it until the matching
    // `click` completes (this is Popover-specific — `HoverCard` has no such
    // deferral). A real tap produces exactly this sequence on release; only
    // firing `pointerdown` here would prove nothing either way.
    const target = pillOf();
    fireEvent.pointerDown(target, { button: 0, clientX: 10, clientY: 10, pointerType: 'touch' });
    fireEvent.pointerUp(target, { button: 0, clientX: 10, clientY: 10, pointerType: 'touch' });
    fireEvent.click(target);

    await waitFor(() => expect(screen.queryByTestId('reaction-picker')).not.toBeInTheDocument());
  });
});
