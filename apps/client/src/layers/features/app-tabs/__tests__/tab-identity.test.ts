import { describe, it, expect } from 'vitest';
import { Hash, MessageSquare, Puzzle } from 'lucide-react';
import { APP_ROUTE_PATHS } from '@/layers/shared/lib';
import { parseTabHref, projectName } from '../lib/tab-target';
import {
  ROUTE_IDENTITY,
  channelsTabIdentity,
  chatTabIdentity,
  extensionTabIdentity,
  homeTabIdentity,
  marketplaceTabIdentity,
  pickTabStatus,
  profileTabIdentity,
  roomTabIdentity,
  routeTabIdentity,
  settingsTabIdentity,
  tabAccessibleName,
  tabLabel,
  tabStatusSentence,
  teamTabIdentity,
  windowTitle,
  type TabStatus,
  type TabStatusSignals,
} from '../lib/tab-identity';

describe('parseTabHref', () => {
  it('reads the session and project off a chat tab', () => {
    expect(parseTabHref('/session?session=abc&dir=%2FUsers%2Fkai%2Fapi')).toMatchObject({
      pathname: '/session',
      sessionId: 'abc',
      dir: '/Users/kai/api',
      draft: false,
      roomId: null,
    });
  });

  it('reads the draft flag off a chat tab', () => {
    expect(parseTabHref('/session?session=abc&draft=1').draft).toBe(true);
    expect(parseTabHref('/session?session=abc').draft).toBe(false);
  });

  it('ignores session params on other routes', () => {
    expect(parseTabHref('/team?view=topology&session=abc')).toMatchObject({
      pathname: '/team',
      sessionId: null,
    });
  });

  it('reads the room and community off a channel tab', () => {
    expect(parseTabHref('/channels?community=alpha&id=general')).toMatchObject({
      roomId: 'general',
      community: 'alpha',
    });
    expect(parseTabHref('/channels').roomId).toBeNull();
  });

  it('reads the overlays off any route', () => {
    expect(parseTabHref('/team?settings=appearance')).toMatchObject({ settings: 'appearance' });
    expect(parseTabHref('/session?session=a&profile=agent-1')).toMatchObject({
      sessionId: 'a',
      profile: 'agent-1',
    });
  });

  it('reads the search and package off the Marketplace', () => {
    expect(parseTabHref('/marketplace?q=notes&pkg=flow')).toMatchObject({
      query: 'notes',
      pkg: 'flow',
    });
    expect(parseTabHref('/tasks?q=notes').query).toBeNull();
  });

  it('normalizes a trailing slash and degrades nonsense to the dashboard', () => {
    expect(parseTabHref('/marketplace/sources/').pathname).toBe('/marketplace/sources');
    expect(parseTabHref('/?detail=failed-run').pathname).toBe('/');
    expect(parseTabHref('').pathname).toBe('/');
  });
});

describe('projectName', () => {
  it('uses the last path segment, and has no answer for a blank path', () => {
    expect(projectName('/Users/kai/code/api/')).toBe('api');
    expect(projectName(null)).toBeUndefined();
    expect(projectName('')).toBeUndefined();
  });
});

describe('pickTabStatus: one status wins, in one order', () => {
  // Every pair of signals, so moving one rung of the order fails a row here.
  const ORDER: [keyof TabStatusSignals, TabStatus][] = [
    ['needsYou', 'needs-you'],
    ['failed', 'failed'],
    ['paused', 'paused'],
    ['working', 'working'],
    ['unseen', 'new'],
  ];

  it.each(ORDER)('%s alone reads as %s', (signal, status) => {
    expect(pickTabStatus({ [signal]: true })).toBe(status);
  });

  for (let hi = 0; hi < ORDER.length; hi++) {
    for (let lo = hi + 1; lo < ORDER.length; lo++) {
      const [hotter, wins] = ORDER[hi]!;
      const [cooler] = ORDER[lo]!;
      it(`${hotter} beats ${cooler}`, () => {
        expect(pickTabStatus({ [hotter]: true, [cooler]: true })).toBe(wins);
      });
    }
  }

  it('says nothing when idle', () => {
    expect(pickTabStatus({})).toBeUndefined();
  });
});

describe('tabStatusSentence', () => {
  it.each([
    [
      'needs-you',
      { needsYou: { kind: 'approval', toolName: 'Bash' } },
      'Waiting for your OK to run Bash',
    ],
    ['needs-you', { needsYou: { kind: 'approval' } }, 'Waiting for your OK'],
    ['needs-you', { needsYou: { kind: 'question' } }, 'Waiting for your answer'],
    ['needs-you', {}, 'Needs you'],
    ['failed', {}, 'The last reply failed'],
    ['paused', { resetsAt: '3:40 PM' }, 'Out of usage until 3:40 PM'],
    ['paused', { resetsAt: null }, 'Out of usage'],
    ['working', { activity: 'running tests' }, 'Working: running tests'],
    ['working', {}, 'Working'],
    ['new', {}, 'Finished while you were away'],
  ] as const)('%s with %o reads "%s"', (status, detail, sentence) => {
    expect(tabStatusSentence(status, detail)).toBe(sentence);
  });

  it('keeps every sentence within the 15-word copy cap', () => {
    const sentence = tabStatusSentence('needs-you', {
      needsYou: { kind: 'approval', toolName: 'mcp__github__create_pull_request' },
    });
    expect(sentence.split(/\s+/).length).toBeLessThanOrEqual(15);
  });
});

describe('a chat tab', () => {
  it('reads Agent · chat title, in the agent’s emoji', () => {
    const id = chatTabIdentity({
      agentName: 'Scout',
      visual: { emoji: '🔍', color: '#00f' },
      chatTitle: 'Fix the login bug',
      agentKey: 'scout',
    });
    expect(id).toMatchObject({
      primary: 'Scout',
      secondary: 'Fix the login bug',
      icon: { kind: 'emoji', emoji: '🔍' },
      accessibleName: 'Scout, Fix the login bug',
    });
  });

  it('says "Chat", never "Session", while nothing is known', () => {
    const id = chatTabIdentity({});
    expect(id.primary).toBe('Chat');
    expect(id.icon).toEqual({ kind: 'route', Icon: MessageSquare });
  });

  it('names the project folder before the agent resolves', () => {
    expect(chatTabIdentity({ projectName: 'api' }).primary).toBe('api');
  });

  it('announces its status after its name', () => {
    const id = chatTabIdentity({
      agentName: 'Scout',
      chatTitle: 'Fix the login bug',
      signals: { needsYou: true, working: true },
      detail: { needsYou: { kind: 'approval', toolName: 'Bash' } },
    });
    expect(id.status).toBe('needs-you');
    expect(id.accessibleName).toBe(
      'Scout, Fix the login bug, Needs you: Waiting for your OK to run Bash'
    );
  });

  it('says working once, not twice', () => {
    const id = chatTabIdentity({
      agentName: 'Scout',
      signals: { working: true },
      detail: { activity: 'running tests' },
    });
    expect(id.accessibleName).toBe('Scout, Working: running tests');
  });

  it('shows Paused for a chat out of usage', () => {
    const id = chatTabIdentity({ agentName: 'Scout', signals: { paused: true } });
    expect(id.status).toBe('paused');
  });
});

describe('smart names', () => {
  const id = chatTabIdentity({
    agentName: 'Scout',
    visual: { emoji: '🔍' },
    chatTitle: 'Fix the login bug',
    agentKey: 'scout',
  });

  it('leads with the agent when the tab is the only one with it', () => {
    expect(tabLabel(id)).toEqual({ lead: 'Scout', trail: 'Fix the login bug' });
  });

  it('collapses the agent to its emoji and leads with the chat when another tab shares it', () => {
    expect(tabLabel(id, { collapseAgent: true })).toEqual({ lead: 'Fix the login bug' });
  });

  it('announces what it visibly leads with', () => {
    const working = chatTabIdentity({
      agentName: 'Scout',
      visual: { emoji: '🔍' },
      chatTitle: 'Fix the login bug',
      agentKey: 'scout',
      signals: { working: true },
    });
    expect(tabAccessibleName(working)).toBe('Scout, Fix the login bug, Working');
    expect(tabAccessibleName(working, { collapseAgent: true })).toBe(
      'Fix the login bug, Scout, Working'
    );
  });

  it('keeps the agent when there is no chat title to lead with', () => {
    const untitled = chatTabIdentity({
      agentName: 'Scout',
      visual: { emoji: '🔍' },
      agentKey: 'scout',
    });
    expect(tabLabel(untitled, { collapseAgent: true })).toEqual({ lead: 'Scout' });
  });

  it('never collapses a page that is not a chat', () => {
    expect(tabLabel(settingsTabIdentity('Appearance'), { collapseAgent: true })).toEqual({
      lead: 'Settings',
      trail: 'Appearance',
    });
  });
});

describe('a room tab', () => {
  it('names a channel #slug with its unread count, quietly', () => {
    const id = roomTabIdentity({ kind: 'channel', title: '#general', unreadCount: 4 });
    expect(id).toMatchObject({
      primary: '#general',
      icon: { kind: 'route', Icon: Hash },
      count: 4,
      countEmphasis: false,
      accessibleName: '#general, 4 unread messages',
    });
  });

  it('makes an @mention read as urgent', () => {
    const id = roomTabIdentity({
      kind: 'channel',
      title: '#general',
      unreadCount: 4,
      mentionCount: 1,
    });
    expect(id).toMatchObject({ count: 4, countEmphasis: true, statusSentence: '1 mention of you' });
  });

  it('makes a DM’s count read as urgent, and draws whoever it is with', () => {
    const face = { kind: 'agent' as const, color: '#0a0', emoji: '🔍', fallback: 'S' };
    const id = roomTabIdentity({ kind: 'dm', title: 'Scout', unreadCount: 2, face });
    expect(id).toMatchObject({ count: 2, countEmphasis: true, icon: { kind: 'face', face } });
  });

  it('draws no badge for a read room or a room you are not in', () => {
    expect(roomTabIdentity({ kind: 'channel', title: '#a', unreadCount: 0 }).count).toBeUndefined();
    expect(
      roomTabIdentity({ kind: 'channel', title: '#a', unreadCount: null }).count
    ).toBeUndefined();
    expect(roomTabIdentity({ kind: 'dm', title: 'Scout' }).accessibleName).toBe('Scout');
  });

  it('counts rooms, not messages, on /channels with none picked', () => {
    expect(channelsTabIdentity(3)).toMatchObject({
      primary: 'Channels',
      count: 3,
      statusSentence: '3 rooms have new messages',
    });
    expect(channelsTabIdentity(0).count).toBeUndefined();
  });
});

describe('Home and Team', () => {
  it('counts what is waiting on you on Home', () => {
    expect(homeTabIdentity(2)).toMatchObject({
      primary: 'Home',
      status: 'needs-you',
      count: 2,
      countEmphasis: true,
      accessibleName: 'Home, Needs you: 2 things waiting on you',
    });
    expect(homeTabIdentity(0).status).toBeUndefined();
  });

  it('says how many agents are working on Team, and its hottest status', () => {
    expect(
      teamTabIdentity('/team', { workingCount: 3, signals: { working: true, failed: true } })
    ).toMatchObject({ primary: 'Team', secondary: '3 working', status: 'failed' });
    expect(teamTabIdentity('/agents', { workingCount: 0, signals: {} })).toMatchObject({
      primary: 'Team',
      secondary: undefined,
      status: undefined,
    });
  });
});

describe('overlays', () => {
  it('names the profile open over a page after whose profile it is', () => {
    expect(profileTabIdentity({ name: 'Scout', signals: { working: true } })).toMatchObject({
      primary: 'Scout',
      secondary: 'Profile',
      status: 'working',
    });
    expect(profileTabIdentity({}).primary).toBe('Profile');
  });

  it('names the Settings dialog after its section', () => {
    expect(settingsTabIdentity('Appearance')).toMatchObject({
      primary: 'Settings',
      secondary: 'Appearance',
    });
    expect(settingsTabIdentity(undefined).secondary).toBeUndefined();
  });
});

describe('Marketplace and extension pages', () => {
  it('names what you are looking at in the Marketplace', () => {
    expect(marketplaceTabIdentity({ pathname: '/marketplace/sources' }).secondary).toBe('Sources');
    expect(marketplaceTabIdentity({ pathname: '/marketplace', pkg: 'flow' }).secondary).toBe(
      'flow'
    );
    expect(marketplaceTabIdentity({ pathname: '/marketplace', query: ' notes ' }).secondary).toBe(
      '“notes”'
    );
    expect(marketplaceTabIdentity({ pathname: '/marketplace' }).secondary).toBeUndefined();
  });

  it('names an extension page the way the extension registered it', () => {
    const Icon = () => null;
    expect(extensionTabIdentity({ title: 'Flow', icon: Icon })).toMatchObject({
      primary: 'Flow',
      icon: { kind: 'extension', icon: Icon },
    });
  });

  it('reads "Add-on" with a puzzle piece before the page is registered', () => {
    expect(extensionTabIdentity(null)).toMatchObject({
      primary: 'Add-on',
      icon: { kind: 'extension', icon: Puzzle },
    });
  });

  it('wears the badge a page reports for its own tab', () => {
    expect(
      routeTabIdentity('/tasks', { status: 'failed', count: 2, sentence: '2 runs failed' })
    ).toMatchObject({
      primary: 'Schedules',
      status: 'failed',
      count: 2,
      statusSentence: '2 runs failed',
    });
  });
});

describe('the route map (drift guard)', () => {
  // A new route with no identity would name its tab "DorkOS". This fails the
  // moment the router gains one (DOR-587, DOR-919, DOR-2820).
  it('gives every router route an identity', () => {
    const missing = APP_ROUTE_PATHS.filter((path) => !(path in ROUTE_IDENTITY));
    expect(missing, `ROUTE_IDENTITY is missing: ${missing.join(', ') || '(none)'}`).toEqual([]);
  });

  it('carries no identity for a route the router no longer serves', () => {
    const stale = Object.keys(ROUTE_IDENTITY).filter(
      (path) => !(APP_ROUTE_PATHS as readonly string[]).includes(path)
    );
    expect(stale, `ROUTE_IDENTITY has a stale entry: ${stale.join(', ') || '(none)'}`).toEqual([]);
  });

  it('names each route the way a person would', () => {
    const names = Object.fromEntries(
      APP_ROUTE_PATHS.map((path) => [path, routeTabIdentity(path).primary])
    );
    expect(names).toEqual({
      '/': 'Home',
      '/activity': 'Activity',
      // The alias, named for where it lands: a tab saved before the rename
      // restores as `/agents` and must not read "DorkOS" or "Agents".
      '/agents': 'Team',
      '/channels': 'Channels',
      '/connections': 'Connections',
      // What the help menu calls it (DOR-2232).
      '/feedback-requests': 'Your reports',
      '/marketplace': 'Marketplace',
      '/marketplace/sources': 'Marketplace',
      '/session': 'Chat',
      '/tasks': 'Schedules',
      '/team': 'Team',
      '/workspaces': 'Workspaces',
    });
  });
});

describe('windowTitle', () => {
  const visible = { hidden: false, unseenReply: false, badgeCount: 0 };
  const chat = chatTabIdentity({ agentName: 'Scout', chatTitle: 'Fix the login bug' });

  it('names the page as its tab does', () => {
    expect(windowTitle(chat, visible)).toBe('Scout · Fix the login bug — DorkOS');
    expect(windowTitle(routeTabIdentity('/team'), visible)).toBe('Team — DorkOS');
    expect(windowTitle(roomTabIdentity({ kind: 'channel', title: '#general' }), visible)).toBe(
      '#general — DorkOS'
    );
  });

  it('flags 🔔 when anything needs you, ahead of 🏁', () => {
    expect(windowTitle(chat, { ...visible, needsYou: true, unseenReply: true })).toBe(
      '🔔 Scout · Fix the login bug — DorkOS'
    );
    const blocked = chatTabIdentity({ agentName: 'Scout', signals: { needsYou: true } });
    expect(windowTitle(blocked, visible)).toBe('🔔 Scout — DorkOS');
  });

  it('flags 🏁 for a reply that finished while hidden', () => {
    expect(windowTitle(chat, { ...visible, unseenReply: true })).toBe(
      '🏁 Scout · Fix the login bug — DorkOS'
    );
  });

  it('counts (N) only while the window is hidden', () => {
    expect(windowTitle(chat, { ...visible, hidden: true, badgeCount: 3 })).toBe(
      '(3) Scout · Fix the login bug — DorkOS'
    );
    expect(windowTitle(chat, { ...visible, badgeCount: 3 })).toBe(
      'Scout · Fix the login bug — DorkOS'
    );
    expect(windowTitle(chat, { ...visible, hidden: true, badgeCount: 0 })).toBe(
      'Scout · Fix the login bug — DorkOS'
    );
  });

  it('puts the count before the flag', () => {
    expect(windowTitle(chat, { hidden: true, unseenReply: true, badgeCount: 2 })).toBe(
      '(2) 🏁 Scout · Fix the login bug — DorkOS'
    );
  });

  it('cuts a long chat title short', () => {
    const long = chatTabIdentity({ agentName: 'Scout', chatTitle: 'A'.repeat(60) });
    expect(windowTitle(long, visible)).toBe(`Scout · ${'A'.repeat(40)}… — DorkOS`);
  });
});
