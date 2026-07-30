/**
 * The room showcases, and the fixture backend that makes them reachable.
 *
 * Seven of the sheet's states used to need a live server with the right rows in
 * it, so nobody ever reviewed six of them. What replaces the server is a
 * transport built in `rooms-showcase-helpers` — and that helper is what this
 * file tests, because it fails silently: if the override stopped reaching the
 * sheet, every state would collapse to the same "room not there" rendering and
 * the page would look plausible while showing one state seven times.
 *
 * The writes are tested for the same reason. A fixture that accepted a change
 * and then answered the re-read with the room as it was would look exactly like
 * a working one for the length of one frame.
 *
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, render, screen, fireEvent, cleanup, waitFor, within } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { TransportProvider } from '@/layers/shared/model';
import { createPlaygroundTransport } from '../playground-transport';
import { PlaygroundSearch } from '../PlaygroundSearch';
import { getPageFromPath, PAGE_CONFIGS } from '../playground-config';
import { PLAYGROUND_REGISTRY } from '../playground-registry';
import { RoomsPage } from '../pages/RoomsPage';
import { RoomSheetDemo, type RoomSheetDemoProps } from '../showcases/rooms-showcase-helpers';
import {
  ARCHIVED_ROOM,
  CHANNEL_ROOM,
  DM_ROOM,
  EMPTY_ROOM,
  MEMBER,
} from '../showcases/rooms-showcase-data';

vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
const { toast } = await import('sonner');

beforeEach(() => {
  vi.clearAllMocks();
  Element.prototype.scrollIntoView = vi.fn();
  const proto = Element.prototype as unknown as Record<string, unknown>;
  if (!proto.hasPointerCapture) proto.hasPointerCapture = vi.fn();
  if (!proto.releasePointerCapture) proto.releasePointerCapture = vi.fn();
  // The page's TOC observes its own anchors, and jsdom has no such thing.
  vi.stubGlobal(
    'IntersectionObserver',
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    }
  );
});

afterEach(() => vi.unstubAllGlobals());

afterEach(cleanup);

/**
 * Open one showcase's sheet the way a reader does.
 *
 * The playground supplies the transport at the shell, so the demo mounts its
 * own over the top of it — mirror the shell here so the override is exercised
 * rather than substituted for.
 */
async function openSheet(props: RoomSheetDemoProps): Promise<void> {
  render(
    <TransportProvider transport={createPlaygroundTransport()}>
      <RoomSheetDemo {...props} />
    </TransportProvider>
  );
  fireEvent.click(screen.getByRole('button', { name: props.label }));
  await screen.findByRole('dialog');
}

/** The roster region, whatever it currently holds. */
function roster(): HTMLElement {
  return screen.getByRole('region', { name: 'Current members' });
}

/** Let every promise that was going to settle, settle. */
async function settle(): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

describe('the room sheet fixture reaches every state', () => {
  it('a read that never lands leaves the roster busy and says nothing about loudness', async () => {
    await openSheet({ label: 'Loading', read: 'loading', holds: CHANNEL_ROOM });

    // Flushed first, and that is the whole test: a sheet one frame old is busy
    // whatever the fixture is about to do, so asserting straight after the open
    // would pass just as happily against a read that fails a microtask later.
    await settle();
    expect(roster()).toHaveAttribute('aria-busy', 'true');
    // The loudness line is withheld until there is a roster to describe: an
    // empty one is a real answer, so drawing it during the read would state
    // something false and then correct itself.
    expect(screen.queryByText(/answer you here/)).not.toBeInTheDocument();
    // The header still draws, from the copy the caller already held.
    expect(screen.getByRole('button', { name: /Room name.*General/ })).toBeInTheDocument();
  });

  it('a read that fails offers the way out of it', async () => {
    await openSheet({ label: 'Roster failed', read: 'error', holds: CHANNEL_ROOM });

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent(/Couldn.t read who is in here\./);
    expect(within(alert).getByRole('button', { name: 'Try again' })).toBeInTheDocument();
  });

  it('a channel draws its whole roster and what the room does', async () => {
    await openSheet({ label: '#general', read: CHANNEL_ROOM, holds: CHANNEL_ROOM });

    const members = roster();
    await within(members).findByText('Mio Clicker PM');
    expect(within(members).getByText('mio-click-code')).toBeInTheDocument();
    expect(within(members).getByText('Kai')).toBeInTheDocument();
    // The reader is in the list, marked, and has no loudness pill of their own.
    expect(within(members).getByText('(you)')).toBeInTheDocument();
    expect(
      within(members).queryByRole('button', { name: 'How loud Dorian is here' })
    ).not.toBeInTheDocument();

    // One agent is `engaged`, the other two are quieter, so the room answers
    // once and names no exception (two would be a list).
    expect(screen.getByText('One agent will answer you here')).toBeInTheDocument();
  });

  it('describes the engaged rung with this install’s own ceilings', async () => {
    await openSheet({ label: '#general', read: CHANNEL_ROOM, holds: CHANNEL_ROOM });

    fireEvent.click(await screen.findByRole('button', { name: 'How loud Mio Clicker PM is here' }));

    // The numbers are settings, and the control says less rather than quoting
    // the shipped defaults when the config read has not landed. A fixture that
    // stopped answering `getConfig` would leave the sentence looking finished
    // and quietly wrong about somebody's install.
    expect(
      await screen.findByText(/keeps answering for 10 more minutes or 5 more messages/)
    ).toBeInTheDocument();
  });

  it('a room with nobody in it opens its picker itself', async () => {
    await openSheet({ label: '#design', read: EMPTY_ROOM, holds: EMPTY_ROOM });

    expect(await screen.findByRole('combobox', { name: 'Search agents' })).toBeInTheDocument();
    expect(screen.getByText('There is nobody here to answer you')).toBeInTheDocument();
  });

  it('a one-to-one offers three rungs and says what a second agent would do', async () => {
    await openSheet({ label: 'DM', read: DM_ROOM, holds: DM_ROOM });

    expect(
      await screen.findByText('Adding a second agent turns this into a group conversation.')
    ).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'How loud Mio Clicker PM is here' }));
    const group = await screen.findByRole('radiogroup');
    expect(within(group).getAllByRole('radio')).toHaveLength(3);
    expect(within(group).queryByRole('radio', { name: 'Engaged' })).not.toBeInTheDocument();
  });

  it('an archived room says its settings are on hold and keeps them reachable', async () => {
    await openSheet({ label: '#old-thing', read: ARCHIVED_ROOM, holds: ARCHIVED_ROOM });

    expect(await screen.findByText(/Nobody is triggered in an archived room/)).toBeInTheDocument();
    expect(screen.getByText('Archived')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'How loud Mio Clicker PM is here' }));
    const rungs = within(await screen.findByRole('radiogroup')).getAllByRole('radio');
    for (const rung of rungs) {
      // `aria-disabled`, never `disabled`: a disabled button leaves the tab
      // order, so the reason a screen reader was given would sit on a control
      // it can never reach.
      expect(rung).toHaveAttribute('aria-disabled', 'true');
      expect(rung).not.toBeDisabled();
    }
  });

  it('a fleet with nobody in it says so and offers the route out', async () => {
    await openSheet({
      label: 'No agents yet',
      read: EMPTY_ROOM,
      holds: EMPTY_ROOM,
      fleet: [],
      focus: 'add',
    });

    expect(await screen.findByText('You have not added any agents yet.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Create agent' })).toBeInTheDocument();
  });
});

describe('the fixture accepts the writes the sheet makes', () => {
  it('a rung survives the re-read that follows it', async () => {
    await openSheet({ label: '#general', read: CHANNEL_ROOM, holds: CHANNEL_ROOM });

    const pill = await screen.findByRole('button', { name: 'How loud Kai is here' });
    expect(pill).toHaveTextContent('Silent');
    fireEvent.click(pill);

    const group = await screen.findByRole('radiogroup', { name: 'How loud is Kai here?' });
    fireEvent.click(within(group).getByRole('radio', { name: 'Everything' }));

    // The optimistic write moves it within the frame; the assertion that
    // matters is that it is still there after the invalidation re-read, which
    // a read-only fixture would answer with `Silent` again.
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'How loud Kai is here' })).toHaveTextContent(
        'Everything'
      )
    );
    await waitFor(() =>
      expect(screen.getByText('Two agents will answer you here')).toBeInTheDocument()
    );
  });

  it('a removal really removes, and leaves the undo behind', async () => {
    await openSheet({ label: '#general', read: CHANNEL_ROOM, holds: CHANNEL_ROOM });

    await within(roster()).findByText('Kai');
    // Radix opens this menu on `pointerdown`, which `fireEvent.click` does
    // not send.
    fireEvent.pointerDown(screen.getByRole('button', { name: 'Kai actions' }));
    fireEvent.click(within(await screen.findByRole('menu')).getByText('Remove from this room'));
    fireEvent.click(
      within(await screen.findByRole('group', { name: 'Remove Kai from #general?' })).getByRole(
        'button',
        { name: 'Remove' }
      )
    );

    await waitFor(() => expect(within(roster()).queryByText('Kai')).not.toBeInTheDocument());
    // The undo only exists on a removal the server agreed to, and only when the
    // fleet can still name the directory to put back.
    expect(toast.success).toHaveBeenCalledWith(
      'Kai removed from #general',
      expect.objectContaining({ action: expect.objectContaining({ label: 'Undo' }) })
    );
  });

  it('an agent added from the picker joins the roster', async () => {
    // `ravi-bot` is the one member of the cast not already in #general.
    await openSheet({ label: '#general', read: CHANNEL_ROOM, holds: CHANNEL_ROOM, focus: 'add' });

    const field = await screen.findByRole('combobox', { name: 'Search agents' });
    fireEvent.keyDown(field, { key: 'ArrowDown' });
    fireEvent.keyDown(field, { key: 'Enter' });
    fireEvent.click(screen.getByRole('button', { name: 'Add agent' }));

    await waitFor(() => expect(within(roster()).getByText('ravi-bot')).toBeInTheDocument());
  });
});

describe('the page itself draws every section', () => {
  /**
   * The whole page, once.
   *
   * The sheet gets its own describe block above because it is the one thing
   * here with a fake server behind it. The other six sections are plain props
   * — which means nothing would stop one of them throwing on mount, being
   * swallowed by `ShowcaseErrorBoundary`, and shipping as a red box that only
   * somebody who opened `/dev/rooms` would ever see.
   */
  it('renders all seven, and none of them crashes into the boundary', async () => {
    render(
      <TransportProvider transport={createPlaygroundTransport()}>
        <RoomsPage />
      </TransportProvider>
    );
    await settle();

    for (const section of PLAYGROUND_REGISTRY.filter((s) => s.page === 'rooms')) {
      expect(screen.getByRole('heading', { name: new RegExp(section.title) })).toBeInTheDocument();
      // The anchor the TOC and ⌘K point at has to exist on the page, not only
      // in the registry.
      expect(document.getElementById(section.id)).not.toBeNull();
    }
    expect(screen.queryByText(/crashed$/)).not.toBeInTheDocument();
  });

  it('draws every loudness level and every rung the two room kinds offer', async () => {
    render(
      <TransportProvider transport={createPlaygroundTransport()}>
        <RoomsPage />
      </TransportProvider>
    );
    await settle();

    // Ten meters: five levels at two sizes, live — and ten more dormant.
    const meters = document.querySelectorAll('[data-slot="loudness-meter"]');
    expect(meters.length).toBeGreaterThanOrEqual(20);
    expect(document.querySelectorAll('[data-slot="loudness-meter"][data-dormant]')).toHaveLength(
      10
    );

    // Four sections of rungs: a channel's four, a DM's three, a stored value
    // this room does not offer landing on the rung it behaves as, and the
    // dormant one. The DM sections are what would silently disappear if
    // `rungsFor` ever stopped reading the room kind.
    const groups = screen.getAllByRole('radiogroup');
    expect(groups.map((group) => within(group).getAllByRole('radio').length)).toEqual([4, 3, 3, 4]);
  });
});

describe('the rooms page is wired into the playground', () => {
  it('resolves from its own URL', () => {
    expect(getPageFromPath('/dev/rooms')).toBe('rooms');
  });

  it('has a nav entry in the agents group', () => {
    const config = PAGE_CONFIGS.find((page) => page.id === 'rooms');
    expect(config?.group).toBe('agents');
    expect(config?.sections).toEqual(
      PLAYGROUND_REGISTRY.filter((section) => section.page === 'rooms')
    );
  });

  it('puts every room section in reach of the search', () => {
    render(<PlaygroundSearch open onOpenChange={vi.fn()} onSelect={vi.fn()} />);
    for (const section of PLAYGROUND_REGISTRY.filter((s) => s.page === 'rooms')) {
      expect(screen.getByText(section.title)).toBeInTheDocument();
    }
  });

  it('opens the section the search was asked for', () => {
    const onSelect = vi.fn();
    render(<PlaygroundSearch open onOpenChange={vi.fn()} onSelect={onSelect} />);

    fireEvent.click(screen.getByText('Room Sheet'));
    expect(onSelect).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'room-sheet', page: 'rooms' })
    );
  });

  it('names the member whose row the sheet marks as the reader', () => {
    // The fixture's `viewerAuthorId` has to be the person, or the "(you)" the
    // channel test looks for would land on an agent and still pass.
    expect(CHANNEL_ROOM.viewerAuthorId).toBe(MEMBER.reader.authorId);
    expect(MEMBER.reader.author.kind).toBe('human');
  });
});
