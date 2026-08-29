/**
 * The room showcases, and the fixture backend that makes them reachable.
 *
 * Seven of the panel's states used to need a live server with the right rows in
 * it, so nobody ever reviewed six of them. What replaces the server is a
 * transport built in `rooms-showcase-helpers` — and that helper is what this
 * file tests, because it fails silently: if the override stopped reaching the
 * panel, every state would collapse to the same "room not there" rendering and
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
import { EventStreamProvider, TransportProvider } from '@/layers/shared/model';
import { createPlaygroundTransport } from '../playground-transport';
import { PlaygroundSearch } from '../PlaygroundSearch';
import { getPageFromPath, PAGE_CONFIGS } from '../playground-config';
import { PLAYGROUND_REGISTRY } from '../playground-registry';
import { RoomsPage } from '../pages/RoomsPage';
import { RoomPanelDemo, type RoomPanelDemoProps } from '../showcases/rooms-showcase-helpers';
import { ARCHIVED_ROOM, CHANNEL_ROOM, DM_ROOM, EMPTY_ROOM } from '../showcases/rooms-showcase-data';

// **The budget here is a sum, not any one wait.** Every case mounts a real panel
// (or, twice, the whole seven-showcase page) and then chains several Testing
// Library waits, each with its own one-second ceiling. A case that genuinely
// breaks still fails at the wait that broke, in under a second, with the element
// it could not find — so this ceiling never hides a defect. It only ever fires
// when a loaded machine stretches four honest waits past the five-second default,
// which is what took this file red in the pre-push gate while it passed alone.
vi.setConfig({ testTimeout: 30_000 });

vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

// The room panel reads route state to decide where each member row's face leads
// (`useProfileDeepLink`), and the playground mounts it with no router. Where
// that link goes has its own file —
// `features/room-management/__tests__/RoomMemberRow.click-to-profile.test.tsx`,
// which mounts a real router and asserts the id that travels.
vi.mock('@/layers/shared/model', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/layers/shared/model')>();
  return {
    ...actual,
    useProfileDeepLink: () => ({ isOpen: false, memberId: null, open: vi.fn(), close: vi.fn() }),
  };
});
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
 * Mount one showcase's panel.
 *
 * The playground supplies the transport at the shell, so the demo mounts its
 * own over the top of it — mirror the shell here so the override is exercised
 * rather than substituted for.
 *
 * No trigger to press since phase R2: the panel is not a modal, so the showcase
 * renders it open. Awaiting the panel's own frame is what replaces waiting for
 * a dialog to appear.
 */
async function openSheet(props: RoomPanelDemoProps): Promise<void> {
  render(
    <EventStreamProvider>
      <TransportProvider transport={createPlaygroundTransport()}>
        <RoomPanelDemo {...props} />
      </TransportProvider>
    </EventStreamProvider>
  );
  await screen.findByText(props.label);
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

describe('the room panel fixture reaches every state', () => {
  it('a read that never lands leaves the roster busy and says nothing about loudness', async () => {
    await openSheet({ label: 'Loading', read: 'loading', holds: CHANNEL_ROOM });

    // Flushed first, and that is the whole test: a panel one frame old is busy
    // whatever the fixture is about to do, so asserting straight after the open
    // would pass just as happily against a read that fails a microtask later.
    await settle();
    expect(roster()).toHaveAttribute('aria-busy', 'true');
    // The loudness line is withheld until there is a roster to describe: an
    // empty one is a real answer, so drawing it during the read would state
    // something false and then correct itself.
    expect(screen.queryByText(/answer you here/)).not.toBeInTheDocument();
    // And the room's name is withheld for the same reason. The panel is
    // addressed by id — it is handed no summary the way the modal was, so a name
    // here before the read lands would be an invention rather than a head start.
    expect(screen.queryByRole('button', { name: /Room name/ })).not.toBeInTheDocument();
  });

  it('a read that fails offers the way out of it', async () => {
    await openSheet({ label: 'Room read failed', read: 'error', holds: CHANNEL_ROOM });

    // The panel is addressed by id, so a failed read means there is no room on
    // this surface at all — not a roster it could not fetch under a name that
    // never arrives. The fixture reaches the state; the sentence and the retry
    // are `RoomPanel.test.tsx`'s contract.
    expect(await screen.findByText("That room isn't here")).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Try again' })).toBeInTheDocument();
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

  it('a one-to-one offers all four rungs and says what a second agent would do', async () => {
    await openSheet({ label: 'DM', read: DM_ROOM, holds: DM_ROOM });

    expect(
      await screen.findByText('Adding a second agent turns this into a group conversation.')
    ).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'How loud Mio Clicker PM is here' }));
    const group = await screen.findByRole('radiogroup');
    // The second agent this panel offers to add is exactly why `Engaged` has to
    // be here: the conversation it makes is still a `dm`, and it is the room
    // where an unbounded `Everything` agent is hardest to live with.
    expect(within(group).getAllByRole('radio')).toHaveLength(4);
    expect(within(group).getByRole('radio', { name: 'Engaged' })).toBeInTheDocument();
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

describe('the fixture accepts the writes the panel makes', () => {
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
   * The panel gets its own describe block above because it is the one thing
   * here with a fake server behind it. Room Files brings its own fixture
   * source and its own query cache, so it needs no server either. The
   * remaining six sections are plain props — which means nothing would stop
   * one of them throwing on mount, being swallowed by
   * `ShowcaseErrorBoundary`, and shipping as a red box that only somebody who
   * opened `/dev/rooms` would ever see.
   *
   * The list is read from the registry rather than written out here, so a
   * section added to the page is asserted by this test the day it lands.
   */
  it('renders all eight, and none of them crashes into the boundary', async () => {
    render(
      <EventStreamProvider>
        <TransportProvider transport={createPlaygroundTransport()}>
          <RoomsPage />
        </TransportProvider>
      </EventStreamProvider>
    );
    await settle();

    for (const section of PLAYGROUND_REGISTRY.filter((s) => s.page === 'rooms')) {
      expect(screen.getByRole('heading', { name: new RegExp(section.title) })).toBeInTheDocument();
      // The anchor the TOC and ⌘K point at has to exist on the page, not only
      // in the registry.
      expect(document.getElementById(section.id)).not.toBeNull();
    }
    expect(screen.queryByText(/crashed$/)).not.toBeInTheDocument();
    // A generous ceiling on purpose. These two render the WHOLE page, so their
    // cost is the page's — every section anybody adds lands in both, and the
    // default 5s was already within a second of the real ~4s when Room Files
    // arrived. The number is not a performance budget; it is headroom so that a
    // page growing by a section reds on an assertion rather than on a clock.
  }, 20_000);

  it('draws every loudness level and every rung the two room kinds offer', async () => {
    render(
      <EventStreamProvider>
        <TransportProvider transport={createPlaygroundTransport()}>
          <RoomsPage />
        </TransportProvider>
      </EventStreamProvider>
    );
    await settle();

    // The meter gallery, counted exactly and counted where the number is
    // knowable: five levels at two sizes, live, and the same five again
    // dormant. A page-wide count would be an assertion about every OTHER
    // showcase's meters too — it was `>= 20` against a real 33, which is a
    // number that only ever goes up and so could not fail.
    const gallery = document.getElementById('loudnessmeter')!;
    expect(gallery.querySelectorAll('[data-slot="loudness-meter"]')).toHaveLength(20);
    expect(gallery.querySelectorAll('[data-slot="loudness-meter"][data-dormant]')).toHaveLength(10);

    // Four sections of rungs: a channel, a direct message, the engaged rung a
    // direct message could not reach until it had four, and the dormant one.
    // Every one of them is the same four now — a section that came back with
    // three would be the collapse this page exists to show is gone.
    const groups = screen.getAllByRole('radiogroup');
    expect(groups.map((group) => within(group).getAllByRole('radio').length)).toEqual([4, 4, 4, 4]);
  }, 20_000);
});

describe('the rooms page is wired into the playground', () => {
  it('resolves from its own URL', () => {
    expect(getPageFromPath('/dev/rooms')).toBe('rooms');
  });

  it('has a nav entry in the agents group', () => {
    const config = PAGE_CONFIGS.find((page) => page.id === 'rooms');
    expect(config?.group).toBe('agents');
    // Deliberately NOT `expect(config.sections).toEqual(registry.filter(…))`:
    // both read the same imported `ROOMS_SECTIONS`, so that compares an array
    // to a filter of itself and can only go red on a typo in the literal it is
    // filtering by. What can actually break is a section with nothing behind
    // it, which the search test below renders for real.
    expect(config?.sections?.length).toBeGreaterThan(0);
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

    fireEvent.click(screen.getByText('Room Panel'));
    expect(onSelect).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'room-panel', page: 'rooms' })
    );
  });

  it('marks the person, not an agent, as the reader', async () => {
    // The channel test asserts a "(you)" is on screen and that Dorian has no
    // pill. Neither says the two are the same row — point `viewerAuthorId` at
    // an agent and both still pass, with the mark on the wrong member. This
    // reads the row it actually landed on.
    //
    // Asserting the fixture's own `viewerAuthorId` instead would prove nothing:
    // `createRoomWithRoster` derives it from the roster's first non-agent, so
    // the comparison would be the factory restated over its own output.
    await openSheet({ label: '#general', read: CHANNEL_ROOM, holds: CHANNEL_ROOM });

    // The roster is read asynchronously, so wait for it rather than reading the
    // skeleton that stands in for it.
    const marked = (await within(roster()).findByText('(you)')).closest(
      '[data-slot="room-member-row"]'
    );
    expect(marked).not.toBeNull();
    expect(within(marked as HTMLElement).getByText('Dorian')).toBeInTheDocument();
    // A person has no loudness at all, so the row carrying the mark must not
    // have one either — which is the half that catches the mark landing on an
    // agent whose name happens to be off screen.
    expect(within(marked as HTMLElement).queryByRole('button', { name: /^How loud / })).toBeNull();
  });
});
