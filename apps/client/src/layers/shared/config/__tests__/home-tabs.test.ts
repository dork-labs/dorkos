import { describe, it, expect } from 'vitest';
import { HOME_TABS, resolveHomeTabId, type HomeTabId } from '../home-tabs';

describe('HOME_TABS', () => {
  it('lists the four home surfaces in bar order', () => {
    expect(HOME_TABS.map((tab) => [tab.label, tab.path])).toEqual([
      ['Home', '/'],
      ['Activity', '/activity'],
      ['Schedules', '/tasks'],
      ['Workspaces', '/workspaces'],
    ]);
  });
});

describe('resolveHomeTabId', () => {
  const cases: Array<[string, HomeTabId | null]> = [
    ['/', 'home'],
    ['/activity', 'activity'],
    ['/tasks', 'scheduled'],
    ['/workspaces', 'workspaces'],
    // The spellings the router also serves and reports back verbatim: a
    // trailing slash, several of them, and any casing. Each one renders the
    // page, so each one has to light the tab.
    ['/activity/', 'activity'],
    ['/tasks//', 'scheduled'],
    ['/Activity', 'activity'],
    ['/WORKSPACES/', 'workspaces'],
    ['//', 'home'],
    // Outside the home surface: no tab reads active. `/team` is the case that
    // matters — it is one keystroke from `/tasks` in the sidebar and would be
    // the first thing a prefix match got wrong.
    ['/team', null],
    ['/session', null],
    ['/marketplace/sources', null],
    ['/tasks/new', null],
  ];

  it.each(cases)('maps %s to %s', (pathname, expected) => {
    expect(resolveHomeTabId(pathname)).toBe(expected);
  });

  it('does not make Home active on every path', () => {
    // A prefix match against `/` would light Home up everywhere, which is the
    // one mistake this function exists to avoid.
    const everywhere = ['/activity', '/tasks', '/team', '/channels'];
    expect(everywhere.map(resolveHomeTabId)).not.toContain('home');
  });
});
