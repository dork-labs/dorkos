// @vitest-environment jsdom
/**
 * The `@` picker, driven through the real composer.
 *
 * The claim under test is not "a list appears". It is that **the row a screen
 * reader announces is the row Enter inserts** — the two came apart once already
 * in this repo, and with one cursor crossing section boundaries it is the
 * easiest thing here to get wrong. Every assertion below reads the highlight
 * back out of `aria-activedescendant` rather than assuming it.
 */
import { describe, it, expect, vi, beforeAll, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup, waitFor, within } from '@testing-library/react';
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
import { RoomComposer } from '../ui/RoomComposer';

vi.mock('sonner', () => ({ toast: { error: vi.fn() } }));

/** A desktop: a real pointer, so Enter picks and sends rather than newlining. */
beforeAll(() => {
  // jsdom implements no scrolling at all, and the palette keeps the highlighted
  // row in view. Nothing here asserts on scrolling — a real browser does that.
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

/**
 * A room whose roster holds every case that matters: the reader, another
 * person, two agents, the room's own voice, and an agent nothing can address.
 */
const MEMBERS: RoomRosterEntry[] = [
  member({ id: 'you', kind: 'human', displayName: 'You', handle: 'You' }),
  member({ id: 'priya', kind: 'human', displayName: 'Priya', handle: 'priya' }),
  member({ id: 'ana', kind: 'agent', displayName: 'Ana Reyes', handle: 'ana' }),
  member({
    id: 'mio',
    kind: 'agent',
    displayName: 'Mio Clicker PM',
    handle: 'mio-clicker-pm',
  }),
  member({ id: 'sys', kind: 'system', displayName: 'DorkOS', handle: null }),
  member({ id: 'ab', kind: 'agent', displayName: 'Art Blocks Analytics', handle: null }),
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

function renderComposer(
  transport: Transport = createMockTransport(),
  members: RoomRosterEntry[] = MEMBERS
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
  render(<RoomComposer room={roomWith({ members })} />, { wrapper });
  return { field: screen.getByRole('combobox') as HTMLTextAreaElement, transport };
}

/** Type into the composer the way a person does — one controlled change. */
function type(field: HTMLTextAreaElement, text: string) {
  fireEvent.change(field, { target: { value: text } });
}

/**
 * The row the composer is currently POINTING assistive tech at, resolved to a
 * real element. Throws when the id dangles, which is the failure mode this
 * whole file exists to catch — an `aria-activedescendant` naming an element
 * that was never rendered announces nothing at all.
 */
function announcedRow(field: HTMLTextAreaElement): HTMLElement {
  const id = field.getAttribute('aria-activedescendant');
  if (!id) throw new Error('Nothing is announced as active');
  const el = document.getElementById(id);
  if (!el) throw new Error(`aria-activedescendant points at missing element ${id}`);
  return el;
}

describe('RoomComposer — the @ picker opens', () => {
  it('opens on a bare @ with People before Agents', () => {
    const { field } = renderComposer();
    type(field, '@');

    const listbox = screen.getByRole('listbox', { name: 'Mentions' });
    expect(listbox).toBeInTheDocument();
    // Both groups present, and in the order a room wants them.
    const groups = screen.getAllByRole('group');
    expect(groups.map((g) => g.getAttribute('aria-label'))).toEqual(['People', 'Agents']);
  });

  it('leaves out the room’s own voice and the person typing', () => {
    const { field } = renderComposer();
    type(field, '@');

    const names = screen.getAllByRole('option').map((o) => o.textContent);
    expect(names.some((n) => n?.includes('DorkOS'))).toBe(false);
    expect(names.some((n) => n?.includes('You'))).toBe(false);
  });

  it('does not open inside an email address', () => {
    const { field } = renderComposer();
    // The `@` has a letter before it, so nothing triggers — which is why
    // writing an address in a room does not summon a picker.
    type(field, 'write to dorian@dorkos.ai');
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument();
  });
});

describe('RoomComposer — one cursor across two sections', () => {
  it('announces the first person, then crosses into Agents on one ArrowDown', () => {
    const { field } = renderComposer();
    type(field, '@');

    // Opens on the only person.
    expect(announcedRow(field)).toHaveTextContent('Priya');
    expect(announcedRow(field).closest('[role="group"]')).toHaveAttribute('aria-label', 'People');

    fireEvent.keyDown(field, { key: 'ArrowDown' });

    // One step, and the highlight is in the next section. No second index, no
    // seam to get stuck on.
    expect(announcedRow(field)).toHaveTextContent('Ana Reyes');
    expect(announcedRow(field).closest('[role="group"]')).toHaveAttribute('aria-label', 'Agents');
  });

  it('steps over the member nothing can address', () => {
    const { field } = renderComposer();
    type(field, '@');

    // Priya → Ana → Mio → wraps past Art Blocks back to Priya.
    fireEvent.keyDown(field, { key: 'ArrowDown' });
    fireEvent.keyDown(field, { key: 'ArrowDown' });
    expect(announcedRow(field)).toHaveTextContent('Mio Clicker PM');

    fireEvent.keyDown(field, { key: 'ArrowDown' });
    expect(announcedRow(field)).toHaveTextContent('Priya');
  });

  it('steps FORWARD over an unaddressable member sitting mid-list', () => {
    // The arrangement that tells skipping apart from clamping. With the
    // unaddressable member last, a cursor that lands on it and gets snapped
    // back to the top looks exactly like one that stepped over it. In the
    // middle it does not: skipping goes on to Mio, clamping jumps back to Ana.
    const { field } = renderComposer(createMockTransport(), [
      MEMBERS[0]!, // You — excluded from the picker
      MEMBERS[2]!, // Ana Reyes
      MEMBERS[5]!, // Art Blocks Analytics — no handle
      MEMBERS[3]!, // Mio Clicker PM
    ]);
    type(field, '@');

    expect(announcedRow(field)).toHaveTextContent('Ana Reyes');
    fireEvent.keyDown(field, { key: 'ArrowDown' });
    expect(announcedRow(field)).toHaveTextContent('Mio Clicker PM');
  });

  it('steps BACKWARD over an unaddressable member sitting mid-list', () => {
    const { field } = renderComposer(createMockTransport(), [
      MEMBERS[0]!,
      MEMBERS[2]!, // Ana Reyes
      MEMBERS[5]!, // Art Blocks Analytics — no handle
      MEMBERS[3]!, // Mio Clicker PM
    ]);
    type(field, '@');

    fireEvent.keyDown(field, { key: 'ArrowUp' });
    expect(announcedRow(field)).toHaveTextContent('Mio Clicker PM');
    fireEvent.keyDown(field, { key: 'ArrowUp' });
    expect(announcedRow(field)).toHaveTextContent('Ana Reyes');
  });

  it('shows the unaddressable member, saying why, and refuses to highlight it', () => {
    const { field } = renderComposer();
    type(field, '@');

    const row = screen.getByRole('option', { name: /Art Blocks Analytics/ });
    expect(row).toHaveAttribute('aria-disabled', 'true');
    expect(row).toHaveTextContent('No @name');
    // Never the announced row, at any point in a full cycle.
    for (let step = 0; step < 4; step++) {
      expect(announcedRow(field)).not.toBe(row);
      fireEvent.keyDown(field, { key: 'ArrowDown' });
    }
  });
});

describe('RoomComposer — what is announced is what is inserted', () => {
  it('inserts the handle of the row aria-activedescendant named', () => {
    const { field } = renderComposer();
    type(field, '@');
    fireEvent.keyDown(field, { key: 'ArrowDown' });

    // Read the announced row FIRST, then press Enter, then check the text names
    // that same member. Asserting the text alone would pass just as happily
    // while a screen reader was reading out somebody else.
    const announced = announcedRow(field);
    expect(announced).toHaveTextContent('Ana Reyes');

    fireEvent.keyDown(field, { key: 'Enter' });
    expect(field.value).toBe('@ana ');
  });

  it('inserts the SERVER’s handle, not the display name on the row', () => {
    const { field } = renderComposer();
    type(field, '@mio');

    const announced = announcedRow(field);
    // What a person reads is the display name — which has spaces in it and
    // would resolve to nobody if it were what got written.
    expect(announced).toHaveTextContent('Mio Clicker PM');

    fireEvent.keyDown(field, { key: 'Enter' });
    expect(field.value).toBe('@mio-clicker-pm ');
  });

  it('keeps the rest of the sentence, and puts the caret after the mention', () => {
    const { field } = renderComposer();
    type(field, 'hey @an, can you look?');
    // The caret sits right after `@an`, mid-sentence.
    fireEvent.select(field, { target: { selectionStart: 7, selectionEnd: 7 } });

    fireEvent.keyDown(field, { key: 'Enter' });

    expect(field.value).toBe('hey @ana , can you look?');
    // Past the separating space, so the next word typed does not land against
    // the handle.
    expect(field.selectionStart).toBe(9);
  });

  it('still moves the caret when the insert reproduces the text exactly', () => {
    const { field } = renderComposer();
    // An ordinary edit: the sentence is already written, and putting the caret
    // back inside an existing mention reopens the picker on it.
    type(field, 'hey @ana there');
    fireEvent.select(field, { target: { selectionStart: 8, selectionEnd: 8 } });
    expect(announcedRow(field)).toHaveTextContent('Ana Reyes');

    fireEvent.keyDown(field, { key: 'Enter' });

    // `insertMention` returns the SAME string it was given, so nothing about
    // the value changed — but the caret contract did not stop applying. It
    // belongs past the separating space; leaving it at 8 puts the next word
    // straight against the handle (`@anaand`).
    expect(field.value).toBe('hey @ana there');
    expect(field.selectionStart).toBe(9);
  });

  it('does not yank the caret on the next unrelated edit', () => {
    const { field } = renderComposer();
    type(field, 'hey @ana there');
    fireEvent.select(field, { target: { selectionStart: 8, selectionEnd: 8 } });
    fireEvent.keyDown(field, { key: 'Enter' });

    // A caret request that never found a consumer used to sit armed and fire on
    // whatever text change came next, dragging the caret back into the middle
    // of a sentence one keystroke later.
    type(field, 'hey @ana there!');

    expect(field.selectionStart).toBe('hey @ana there!'.length);
  });

  it('takes the picker down once a mention is inserted', async () => {
    const { field } = renderComposer();
    type(field, '@');
    fireEvent.keyDown(field, { key: 'Enter' });

    // The composer stops advertising a panel immediately — that is the part
    // assistive tech reads, and it must not lag the fade-out.
    expect(field).toHaveAttribute('aria-expanded', 'false');
    expect(field).not.toHaveAttribute('aria-activedescendant');
    expect(field).not.toHaveAttribute('aria-controls');
    // The rows leave once the exit animation finishes.
    await waitFor(() => expect(screen.queryByRole('listbox')).not.toBeInTheDocument());
  });
});

describe('RoomComposer — Enter still sends when there is nothing to pick', () => {
  it('sends rather than swallowing Enter on a query nobody matches', async () => {
    const { field, transport } = renderComposer();
    type(field, 'ping @zzz');

    // The panel is up and says so, but it has no row for Enter to take. Scoped
    // to the panel: the composer keeps a live region carrying the same sentence
    // for a screen reader, so the page holds two copies of it on purpose.
    expect(
      within(screen.getByRole('listbox')).getByText('No one by that name.')
    ).toBeInTheDocument();
    expect(field).not.toHaveAttribute('aria-activedescendant');

    fireEvent.keyDown(field, { key: 'Enter' });

    await waitFor(() => expect(transport.postToRoom).toHaveBeenCalledTimes(1));
    expect(transport.postToRoom).toHaveBeenCalledWith('room-1', { text: 'ping @zzz' });
  });

  it('says out loud that nobody matched, from a region that was already there', async () => {
    // "No one by that name." was drawn inside a panel that mounts with the
    // sentence already in it, which is the classic case assistive technology
    // never announces — so for a screen reader, typing `@zzz` did nothing at
    // all. The announcer is mounted from the start and empty until there is
    // something to say.
    const { field } = renderComposer();
    const announcer = screen.getByRole('status');
    expect(announcer).toBeEmptyDOMElement();

    type(field, 'ping @zzz');

    await waitFor(() => expect(announcer).toHaveTextContent('No one by that name.'));
  });

  it('says nothing while the picker has rows, because the rows already speak', () => {
    // The composer publishes the highlighted row as `aria-activedescendant`, so
    // a screen reader reads it on every keystroke. A second voice repeating the
    // same thing is the duplicate-announcement defect this repo has shipped
    // before.
    const { field } = renderComposer();

    type(field, 'ping @a');

    expect(screen.getByRole('status')).toBeEmptyDOMElement();
  });

  it('closes the no-match panel when the message goes', async () => {
    const { field, transport } = renderComposer();
    type(field, 'ping @zzz');
    fireEvent.keyDown(field, { key: 'Enter' });

    await waitFor(() => expect(transport.postToRoom).toHaveBeenCalledTimes(1));
    // Nothing else would take it down — trigger detection only runs on a
    // keystroke or a caret move — so it would float over the room's replies.
    expect(screen.queryByText('No one by that name.')).not.toBeInTheDocument();
  });

  it('still posts a message that contains an unresolvable @name, unaltered', async () => {
    const { field, transport } = renderComposer();
    // The server leaves this as plain text; the composer must not "fix" it.
    type(field, 'the @99 charge');
    fireEvent.keyDown(field, { key: 'Enter' });

    await waitFor(() =>
      expect(transport.postToRoom).toHaveBeenCalledWith('room-1', { text: 'the @99 charge' })
    );
  });
});

describe('RoomComposer — Escape', () => {
  it('closes the picker without clearing the draft', async () => {
    const { field } = renderComposer();
    type(field, 'hey @an');

    fireEvent.keyDown(field, { key: 'Escape' });

    expect(field).toHaveAttribute('aria-expanded', 'false');
    await waitFor(() => expect(screen.queryByRole('listbox')).not.toBeInTheDocument());
    // A first Escape closes the panel and nothing else. Clearing the draft
    // takes two BARE taps, and dismissing a palette must never arm that.
    expect(field.value).toBe('hey @an');
  });

  it('opens again as soon as typing resumes', () => {
    const { field } = renderComposer();
    type(field, 'hey @an');
    fireEvent.keyDown(field, { key: 'Escape' });
    expect(field).toHaveAttribute('aria-expanded', 'false');

    // Dismissing is about THIS moment, not about the rest of the sentence. A
    // suppression that outlived the next keystroke would be a picker that
    // silently stopped working for the remainder of the message.
    type(field, 'hey @ana');

    expect(field).toHaveAttribute('aria-expanded', 'true');
    expect(announcedRow(field)).toHaveTextContent('Ana Reyes');
  });
});
