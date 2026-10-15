import { describe, expect, it } from 'vitest';
import {
  EVERYWHERE_PLACEMENT,
  MiniAppPlacementSchema,
  effectivePlacement,
  emptyTargets,
  hideHere,
  pageKeyForPath,
  placementFromInput,
  placementShows,
  savedPlacementFor,
  showHere,
  type MiniAppPlacement,
  type PlacementHere,
} from '../mini-app-placement.js';

const DORKOS = 'agent-dorkos';
const MARKETING = 'agent-marketing';
const ROOM_DORKOS = 'room-dorkos';
const ROOM_MARKETING = 'room-marketing';

/** Social Queue's placement: two agents, two rooms. */
const socialQueue: MiniAppPlacement = {
  show: { agents: [DORKOS, MARKETING], rooms: [ROOM_DORKOS, ROOM_MARKETING], pages: [] },
  hide: emptyTargets(),
};

const chatWith = (agentId: string): PlacementHere => ({ page: 'session', agentId });
const inRoom = (roomId: string): PlacementHere => ({ page: 'channels', roomId });

describe('pageKeyForPath', () => {
  it('names pages by their first segment', () => {
    expect(pageKeyForPath('/')).toBe('home');
    expect(pageKeyForPath('/activity')).toBe('activity');
    expect(pageKeyForPath('/marketplace/sources')).toBe('marketplace');
    expect(pageKeyForPath('/x/social-queue')).toBe('x/social-queue');
    expect(pageKeyForPath('/x/social-queue/post/12')).toBe('x/social-queue');
  });
});

describe('placementShows', () => {
  it('shows everywhere by default', () => {
    expect(placementShows(EVERYWHERE_PLACEMENT, { page: 'activity' })).toBe(true);
    expect(placementShows(EVERYWHERE_PLACEMENT, chatWith(DORKOS))).toBe(true);
    expect(placementShows(EVERYWHERE_PLACEMENT, inRoom(ROOM_DORKOS))).toBe(true);
  });

  it('shows for the listed agents and rooms, and nowhere else', () => {
    expect(placementShows(socialQueue, chatWith(DORKOS))).toBe(true);
    expect(placementShows(socialQueue, chatWith(MARKETING))).toBe(true);
    expect(placementShows(socialQueue, inRoom(ROOM_DORKOS))).toBe(true);
    expect(placementShows(socialQueue, inRoom(ROOM_MARKETING))).toBe(true);
    expect(placementShows(socialQueue, chatWith('someone-else'))).toBe(false);
    expect(placementShows(socialQueue, inRoom('room-other'))).toBe(false);
    expect(placementShows(socialQueue, { page: 'activity' })).toBe(false);
  });

  it('never matches an absent id against a list, even an empty-string id', () => {
    expect(placementShows(socialQueue, { page: 'session', agentId: null })).toBe(false);
    expect(placementShows(socialQueue, { page: 'channels', roomId: '' })).toBe(false);
  });

  it('treats * as everywhere only in pages; agents and rooms hold real ids', () => {
    const starAgent: MiniAppPlacement = {
      show: { ...emptyTargets(), agents: ['*'] },
      hide: emptyTargets(),
    };
    expect(placementShows(starAgent, chatWith('anyone'))).toBe(false);
    const everyChat: MiniAppPlacement = {
      show: { ...emptyTargets(), pages: ['session'] },
      hide: emptyTargets(),
    };
    expect(placementShows(everyChat, chatWith('anyone'))).toBe(true);
    expect(placementShows(everyChat, { page: 'session', agentId: null })).toBe(true);
    expect(placementShows(everyChat, inRoom(ROOM_DORKOS))).toBe(false);
  });

  it('lets hide win over show', () => {
    const placement: MiniAppPlacement = {
      show: { ...emptyTargets(), pages: ['*'] },
      hide: { ...emptyTargets(), rooms: [ROOM_DORKOS] },
    };
    expect(placementShows(placement, inRoom(ROOM_DORKOS))).toBe(false);
    expect(placementShows(placement, inRoom(ROOM_MARKETING))).toBe(true);
  });
});

describe('effectivePlacement', () => {
  it('prefers the saved choice, then the declared default, then everywhere', () => {
    expect(effectivePlacement(undefined, undefined)).toBe(EVERYWHERE_PLACEMENT);
    expect(effectivePlacement(null, socialQueue)).toBe(socialQueue);
    const saved: MiniAppPlacement = { show: emptyTargets(), hide: emptyTargets() };
    expect(effectivePlacement(saved, socialQueue)).toBe(saved);
  });
});

describe('savedPlacementFor', () => {
  it('takes the last entry when one tab has two, and null when it has none', () => {
    const first = { tab: 't', ...socialQueue };
    const last = { tab: 't', ...EVERYWHERE_PLACEMENT };
    expect(savedPlacementFor([first, last], 't')).toBe(last);
    expect(savedPlacementFor([first], 'other')).toBeNull();
  });
});

describe('placementFromInput', () => {
  it('keeps only non-empty strings and returns null for no declaration', () => {
    expect(placementFromInput(undefined)).toBeNull();
    expect(placementFromInput({ agents: [DORKOS, '', 3], rooms: 'nope' })).toEqual({
      show: { agents: [DORKOS], rooms: [], pages: [] },
      hide: emptyTargets(),
    });
  });
});

describe('hideHere', () => {
  it('drops the room from show when the room put it there', () => {
    const next = hideHere(socialQueue, inRoom(ROOM_DORKOS));
    expect(placementShows(next, inRoom(ROOM_DORKOS))).toBe(false);
    expect(next.show.rooms).toEqual([ROOM_MARKETING]);
    expect(next.hide).toEqual(emptyTargets());
  });

  it('adds a hide entry when something wider still covers here', () => {
    const next = hideHere(EVERYWHERE_PLACEMENT, inRoom(ROOM_DORKOS));
    expect(next.hide.rooms).toEqual([ROOM_DORKOS]);
    expect(placementShows(next, inRoom(ROOM_DORKOS))).toBe(false);
    expect(placementShows(next, inRoom(ROOM_MARKETING))).toBe(true);
  });

  it('never hides more than here when a page entry covers every channel', () => {
    const channels: MiniAppPlacement = {
      show: { ...emptyTargets(), pages: ['channels'] },
      hide: emptyTargets(),
    };
    const next = hideHere(channels, inRoom(ROOM_DORKOS));
    expect(placementShows(next, inRoom(ROOM_DORKOS))).toBe(false);
    expect(placementShows(next, inRoom(ROOM_MARKETING))).toBe(true);
  });

  it('hides by agent in a chat and by page elsewhere', () => {
    expect(hideHere(EVERYWHERE_PLACEMENT, chatWith(DORKOS)).hide.agents).toEqual([DORKOS]);
    expect(hideHere(EVERYWHERE_PLACEMENT, { page: 'tasks' }).hide.pages).toEqual(['tasks']);
  });

  it('changes nothing where here has nothing narrower than every chat or channel', () => {
    expect(hideHere(EVERYWHERE_PLACEMENT, { page: 'session', agentId: null })).toBe(
      EVERYWHERE_PLACEMENT
    );
    expect(hideHere(EVERYWHERE_PLACEMENT, { page: 'channels' })).toBe(EVERYWHERE_PLACEMENT);
    expect(showHere(socialQueue, { page: 'home', roomId: null })).toBe(socialQueue);
  });
});

describe('showHere', () => {
  it('adds the most specific target for here', () => {
    const next = showHere(socialQueue, inRoom('room-other'));
    expect(next.show.rooms).toContain('room-other');
    expect(placementShows(next, inRoom('room-other'))).toBe(true);
    expect(placementShows(next, inRoom('room-third'))).toBe(false);
  });

  it('clears a broad hide entry so the tab really shows (hide never silently wins)', () => {
    const hidden: MiniAppPlacement = {
      show: emptyTargets(),
      hide: { ...emptyTargets(), pages: ['channels'] },
    };
    const next = showHere(hidden, inRoom(ROOM_DORKOS));
    expect(placementShows(next, inRoom(ROOM_DORKOS))).toBe(true);
  });

  it('undoes hide here', () => {
    const hidden = hideHere(EVERYWHERE_PLACEMENT, inRoom(ROOM_DORKOS));
    const shown = showHere(hidden, inRoom(ROOM_DORKOS));
    expect(placementShows(shown, inRoom(ROOM_DORKOS))).toBe(true);
    expect(shown.hide.rooms).toEqual([]);
    expect(shown.show).toEqual(EVERYWHERE_PLACEMENT.show);
  });

  it('is a no-op on show when show already matches', () => {
    const next = showHere(socialQueue, chatWith(DORKOS));
    expect(next.show).toBe(socialQueue.show);
  });
});

describe('MiniAppPlacementSchema', () => {
  it('fills missing lists', () => {
    expect(MiniAppPlacementSchema.parse({ show: { agents: [DORKOS] } })).toEqual({
      show: { agents: [DORKOS], rooms: [], pages: [] },
      hide: emptyTargets(),
    });
  });
});
