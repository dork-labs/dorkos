// @vitest-environment jsdom
/**
 * The room composer's chrome, serialized — the one visual change in this spec,
 * read against the record of what shipped before it.
 *
 * Rooms are the ONE surface whose DOM legitimately changes here, so the proof
 * is not an empty diff. It is a diff a person read and agreed to. That only
 * works because the "before" side is a real recording of the composer as it
 * shipped: the baselines in `__baselines__/` were captured from the unmigrated
 * component and committed with it (`247ac851a`), and nothing in this file
 * re-records them (spec `composer-parity`, task 3.2).
 *
 * The intended delta, in full — every other node must diff empty:
 * - the root's class set swaps `border-t p-3` for Root's card chrome
 *   (`bg-surface rounded-xl border p-2 m-2`; `relative` was already there and
 *   is unchanged, which is why it appears in neither half of the swap);
 * - the overlay lane's offsets go from `right-3 left-3` to `right-0 left-0`,
 *   because the inset the room hand-rolled is now the card's own padding;
 * - **and, since DOR-947, the attach affordances** — the card's dropzone
 *   (`role="presentation"`, `data-composer-card`, and the hidden
 *   `<input type="file">` react-dropzone mounts), plus the paperclip button and
 *   the second hidden input behind it, with `pl-3` leaving the action row
 *   because the paperclip now supplies that edge.
 *
 * The attach nodes are stripped from the ACTUAL tree before the diff runs,
 * rather than re-baselined away. The differ walks children by index, so four
 * inserted nodes shift every sibling after them and report a page of tag
 * mismatches that hide exactly the regressions this file exists to catch. What
 * is asserted instead is stronger and legible: {@link stripAttachAffordances}
 * names every node it removes, that list is asserted to be precisely the four
 * attach nodes, and what is LEFT must still diff to the same two class swaps
 * the migration was reviewed for. A composer with the files taken back out is
 * the composer that shipped yesterday, node for node.
 *
 * Asserted as a SHAPE — which class tokens left and arrived at which node —
 * rather than against raw diff text, and paired with the claim that no
 * non-class difference exists at all. A node added, removed, retagged,
 * reordered, or reattributed lands in that second bucket and fails.
 *
 * The same delta is stated positively, in words, in `RoomComposer.test.tsx`
 * beside the behavior it must not disturb. That file keeps every behavioral
 * claim; nothing here duplicates one.
 */
import { describe, it, expect, vi, beforeAll, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import type { ReactNode } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createMockTransport } from '@dorkos/test-utils';
import type { Transport } from '@dorkos/shared/transport';
import { REACTION_FREQUENTS_DEFAULT } from '@dorkos/shared/room-schemas';
import type { AuthorRef, RoomRosterEntry, RoomWithRoster } from '@dorkos/shared/room-schemas';
import { useRoomDraftStore } from '@/layers/entities/room';
import { createQueryClientConfig } from '@/layers/shared/lib';
import { TransportProvider } from '@/layers/shared/model';
import {
  serializeDom,
  matchDomBaseline,
  formatDomDiff,
  type DomDiffEntry,
  type SerializedElement,
  type SerializedNode,
} from '@/test-helpers/dom-parity';
import { RoomComposer } from '../ui/RoomComposer';

vi.mock('sonner', () => ({ toast: { error: vi.fn() } }));

/** A desktop: a real pointer, so Enter posts rather than inserting a newline. */
beforeAll(() => {
  if (!Element.prototype.scrollIntoView) Element.prototype.scrollIntoView = vi.fn();
  Object.defineProperty(window, 'matchMedia', {
    writable: true,
    value: vi.fn().mockImplementation((query: string) => ({
      matches: false,
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
});

function member(author: AuthorRef): RoomRosterEntry {
  return {
    roomId: 'room-1',
    authorId: author.id,
    responseMode: 'mention-only',
    joinedAt: '2026-07-26T09:00:00.000Z',
    joinedSeq: 0,
    lastReadSeq: 0,
    author,
    origin: 'local',
  };
}

const MEMBERS: RoomRosterEntry[] = [
  member({ id: 'you', kind: 'human', displayName: 'You', handle: 'You' }),
  member({ id: 'ana', kind: 'agent', displayName: 'Ana Reyes', handle: 'ana' }),
];

function roomWith(overrides: Partial<RoomWithRoster> = {}): RoomWithRoster {
  return {
    id: 'room-1',
    kind: 'channel',
    slug: 'general',
    title: '#general',
    topic: null,
    workspaceId: null,
    archived: false,
    ambientMaxEntries: 30,
    createdAt: '2026-07-26T09:00:00.000Z',
    lastActivityAt: '2026-07-26T10:00:00.000Z',
    members: MEMBERS,
    viewerAuthorId: 'you',
    reactionFrequents: [...REACTION_FREQUENTS_DEFAULT],
    ...overrides,
  };
}

/** Mount the composer under the app's real cache configuration, retries off. */
function renderComposer(
  room: RoomWithRoster = roomWith(),
  transport: Transport = createMockTransport()
) {
  const config = createQueryClientConfig();
  const queryClient = new QueryClient({
    ...config,
    defaultOptions: {
      ...config.defaultOptions,
      queries: { ...config.defaultOptions?.queries, retry: false, gcTime: 0 },
      mutations: { ...config.defaultOptions?.mutations, retry: false },
    },
  });
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={queryClient}>
      <TransportProvider transport={transport}>{children}</TransportProvider>
    </QueryClientProvider>
  );
  return render(<RoomComposer room={room} />, { wrapper });
}

/** Type into the composer the way a person does — one controlled change. */
function type(field: HTMLTextAreaElement, text: string) {
  fireEvent.change(field, { target: { value: text } });
}

/**
 * Where the two changed nodes sit, as the differ names them.
 *
 * The paths are the differ's own walk notation: it starts at the Testing
 * Library container (`div`), the composer's card is its only child (`div`), and
 * the overlay lane is that card's second child among several (`div[1]`), after
 * the screen-reader announcer.
 */
const ROOT_PATH = 'div > div';
const LANE_PATH = 'div > div > div[1]';

/** The room's own strip, gone: what the card chrome replaces. */
const ROOT_CLASSES_REMOVED = ['border-t', 'p-3'];

/**
 * Root's card chrome, arrived. `relative` is deliberately absent — the room's
 * strip already carried it, so it is not part of the swap.
 */
const ROOT_CLASSES_ADDED = ['bg-surface', 'border', 'm-2', 'p-2', 'rounded-xl'];

/** The lane's hand-rolled inset, gone. */
const LANE_CLASSES_REMOVED = ['left-3', 'right-3'];

/** The lane's inset now that the card's `p-2` provides it. */
const LANE_CLASSES_ADDED = ['left-0', 'right-0'];

/**
 * Every attach node, in the order a walk of the tree meets them.
 *
 * Asserted rather than assumed: the stripping below is only honest if what it
 * removed is exactly this and nothing else. A fifth entry means the wiring grew
 * something nobody reviewed; a missing one means attach is not mounted at all
 * and the empty diff that follows would be proving nothing.
 */
const ATTACH_NODES = [
  'the card’s dropzone attributes',
  '<input type="file">',
  '<input type="file">',
  '<button> Attach file',
];

/**
 * The composer with the files taken back out.
 *
 * Removes the four nodes DOR-947 added and the two attributes react-dropzone
 * puts on the card, naming each one as it goes, so what remains can be compared
 * against a baseline recorded before any of it existed.
 *
 * @param node - A serialized subtree.
 * @param removed - Accumulates the name of every node this strips.
 */
function stripAttachAffordances(node: SerializedNode, removed: string[]): SerializedNode {
  if (node.kind === 'text') return node;

  const attrs = { ...node.attrs };
  if ('data-composer-card' in attrs) {
    // The card announces itself as one destination (`data-composer-card`) and
    // react-dropzone marks it a drop target (`role="presentation"`). Both ride
    // on the node the baseline already has, so they are attributes to drop
    // rather than nodes to remove.
    delete attrs['data-composer-card'];
    delete attrs.role;
    removed.push(ATTACH_NODES[0]);
  }

  const children: SerializedNode[] = [];
  for (const child of node.children) {
    if (child.kind === 'element' && child.tag === 'input' && child.attrs.type === 'file') {
      removed.push('<input type="file">');
      continue;
    }
    if (
      child.kind === 'element' &&
      child.tag === 'button' &&
      child.attrs['aria-label'] === 'Attach file'
    ) {
      removed.push('<button> Attach file');
      continue;
    }
    children.push(stripAttachAffordances(child, removed));
  }

  return { ...node, attrs, children };
}

/** Serialize the composer, then take the attach affordances back out. */
function serializeWithoutAttach(container: Element): SerializedElement {
  const removed: string[] = [];
  const tree = stripAttachAffordances(serializeDom(container), removed) as SerializedElement;
  expect(removed).toEqual(ATTACH_NODES);
  return tree;
}

/** One node's class swap, as the assertions below compare it. */
interface ClassSwap {
  path: string;
  added: string[];
  removed: string[];
}

/** Which class tokens left and arrived, per node, in the differ's walk order. */
function classSwaps(diff: readonly DomDiffEntry[]): ClassSwap[] {
  const byPath = new Map<string, ClassSwap>();
  for (const entry of diff) {
    if (entry.kind !== 'class-added' && entry.kind !== 'class-removed') continue;
    const token = /class token "([^"]+)"/.exec(entry.detail)?.[1];
    if (token === undefined) throw new Error(`unparseable class diff: ${entry.detail}`);
    const swap = byPath.get(entry.path) ?? { path: entry.path, added: [], removed: [] };
    (entry.kind === 'class-added' ? swap.added : swap.removed).push(token);
    byPath.set(entry.path, swap);
  }
  return [...byPath.values()].map((swap) => ({
    path: swap.path,
    added: [...swap.added].sort(),
    removed: [...swap.removed].sort(),
  }));
}

/**
 * The whole reviewed delta, asserted against one state's diff.
 *
 * Two claims, in the order they matter. First: nothing that is not a class
 * moved — no node added, removed, retagged, reordered, or reattributed — and
 * the failure prints the offending nodes rather than a count. Second: the class
 * tokens that did move are exactly the two swaps this migration exists for, at
 * exactly the two nodes it is allowed to touch.
 */
function expectIntendedChromeDelta(diff: readonly DomDiffEntry[]) {
  const notChrome = diff.filter(
    (entry) => entry.kind !== 'class-added' && entry.kind !== 'class-removed'
  );
  expect(formatDomDiff(notChrome)).toBe('');

  const swaps = classSwaps(diff);
  const cardAndLane = swaps.filter((swap) => swap.path === ROOT_PATH || swap.path === LANE_PATH);
  expect(cardAndLane).toEqual([
    { path: ROOT_PATH, added: ROOT_CLASSES_ADDED, removed: ROOT_CLASSES_REMOVED },
    { path: LANE_PATH, added: LANE_CLASSES_ADDED, removed: LANE_CLASSES_REMOVED },
  ]);

  // The one swap attach costs, and the only node it may cost it at: the action
  // row drops `pl-3` because the paperclip now supplies that edge. Matched by
  // its tokens rather than by a path — the row sits one child further down when
  // the composer is also drawing a refusal line.
  const fromAttach = swaps.filter((swap) => swap.path !== ROOT_PATH && swap.path !== LANE_PATH);
  expect(fromAttach.map(({ added, removed }) => ({ added, removed }))).toEqual([
    { added: [], removed: ['pl-3'] },
  ]);
}

describe('RoomComposer — serialized-DOM delta against the pre-migration baselines', () => {
  it('idle — the resting composer', () => {
    const { container } = renderComposer();

    expect(screen.getByRole('combobox')).toHaveAttribute('aria-label', 'Message #general…');

    expectIntendedChromeDelta(
      matchDomBaseline(import.meta.url, 'room-composer.idle', serializeWithoutAttach(container))
    );
  });

  it('archived — the composer that says why it cannot be used', () => {
    const { container } = renderComposer(roomWith({ archived: true }));

    expect(
      screen.getByText('This conversation is archived. You can read it, but not add to it.')
    ).toBeInTheDocument();

    expectIntendedChromeDelta(
      matchDomBaseline(import.meta.url, 'room-composer.archived', serializeWithoutAttach(container))
    );
  });

  it('mention picker open — the lane carrying the palette', () => {
    const { container } = renderComposer();
    const field = screen.getByRole('combobox') as HTMLTextAreaElement;

    type(field, 'hey @');
    fireEvent.select(field, { target: { selectionStart: 5 } });

    const lane = container.querySelector('.bottom-full')!;
    expect(lane.querySelector('[role="listbox"]')).not.toBeNull();

    expectIntendedChromeDelta(
      matchDomBaseline(
        import.meta.url,
        'room-composer.mention-open',
        serializeWithoutAttach(container)
      )
    );
  });

  it('clear armed — the lane carrying the hint', () => {
    // The picker and the hint cannot be on screen together: Escape with a
    // palette open dismisses the palette and deliberately does NOT arm. So the
    // lane's two occupants get one baseline each, and the migration has to
    // reproduce both.
    const { container } = renderComposer();
    const field = screen.getByRole('combobox') as HTMLTextAreaElement;

    type(field, 'a draft worth keeping');
    fireEvent.keyDown(field, { key: 'Escape' });

    const lane = container.querySelector('.bottom-full')!;
    expect(lane.contains(screen.getByTestId('clear-armed-hint'))).toBe(true);

    expectIntendedChromeDelta(
      matchDomBaseline(
        import.meta.url,
        'room-composer.clear-armed',
        serializeWithoutAttach(container)
      )
    );
  });
});
