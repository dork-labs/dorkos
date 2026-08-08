import { describe, it, expect } from 'vitest';
import {
  parseTabHref,
  projectName,
  fallbackTabLabel,
  ROUTE_LABELS,
  ROUTE_ICONS,
} from '../lib/tab-target';
import { APP_ROUTE_PATHS } from '@/layers/shared/lib';

describe('parseTabHref', () => {
  it('reads the session and project off a chat tab', () => {
    expect(parseTabHref('/session?session=abc&dir=%2FUsers%2Fkai%2Fapi')).toEqual({
      pathname: '/session',
      sessionId: 'abc',
      dir: '/Users/kai/api',
    });
  });

  it('leaves session fields empty for a chat tab that has not resolved yet', () => {
    expect(parseTabHref('/session?dir=%2Ftmp')).toEqual({
      pathname: '/session',
      sessionId: null,
      dir: '/tmp',
    });
  });

  it('ignores session params on other routes', () => {
    expect(parseTabHref('/team?view=topology&session=abc')).toEqual({
      pathname: '/team',
      sessionId: null,
      dir: null,
    });
  });

  it('normalizes a trailing slash', () => {
    expect(parseTabHref('/marketplace/sources/').pathname).toBe('/marketplace/sources');
  });

  it('treats the root as the dashboard', () => {
    expect(parseTabHref('/').pathname).toBe('/');
    expect(parseTabHref('/?detail=failed-run').pathname).toBe('/');
  });

  it('degrades to the dashboard rather than throwing on nonsense', () => {
    expect(parseTabHref('')).toEqual({ pathname: '/', sessionId: null, dir: null });
  });
});

describe('projectName', () => {
  it('uses the last path segment', () => {
    expect(projectName('/Users/kai/code/api')).toBe('api');
  });

  it('tolerates a trailing slash', () => {
    expect(projectName('/Users/kai/code/api/')).toBe('api');
  });

  it('has no answer for a blank path', () => {
    expect(projectName(null)).toBeUndefined();
    expect(projectName('')).toBeUndefined();
  });
});

describe('fallbackTabLabel', () => {
  it('names each route the way a person would', () => {
    expect(fallbackTabLabel(parseTabHref('/'))).toBe('Home');
    expect(fallbackTabLabel(parseTabHref('/team'))).toBe('Team');
    // The `/agents` alias, labelled for where it lands. This is the whole
    // justification for keeping the alias, made checkable: the Electron shell
    // persists raw pathnames, so a tab saved before the rename restores as
    // `/agents` and must not come back reading "DorkOS" or "Agents".
    expect(fallbackTabLabel(parseTabHref('/agents'))).toBe('Team');
    expect(fallbackTabLabel(parseTabHref('/activity'))).toBe('Activity');
    // Before this, a channel or DM tab fell through to the unknown-route label
    // ("DorkOS") — the same class of defect DOR-587 fixes for the header, one
    // surface over.
    expect(fallbackTabLabel(parseTabHref('/channels?id=room_1'))).toBe('Channels');
    expect(fallbackTabLabel(parseTabHref('/tasks'))).toBe('Tasks');
    expect(fallbackTabLabel(parseTabHref('/workspaces'))).toBe('Workspaces');
    expect(fallbackTabLabel(parseTabHref('/marketplace'))).toBe('Marketplace');
    expect(fallbackTabLabel(parseTabHref('/marketplace/sources'))).toBe('Marketplace sources');
  });

  it('names a chat tab after its project', () => {
    expect(fallbackTabLabel(parseTabHref('/session?dir=%2FUsers%2Fkai%2Fapi'))).toBe('api');
  });

  it('always produces something, even with no project', () => {
    expect(fallbackTabLabel(parseTabHref('/session'))).toBe('Session');
    expect(fallbackTabLabel(parseTabHref('/somewhere-new'))).toBe('DorkOS');
  });
});

describe('route map key parity (drift guard)', () => {
  // Routes deliberately absent from one map or the other. An addition here
  // needs a matching "on purpose" comment on the map itself in tab-target.ts
  // (that's what makes the absence a decision, not a gap) — see DOR-587
  // (both maps missed `/channels`) and DOR-919 (`ROUTE_ICONS` missed two more
  // routes), because nothing checked them against the real router.
  const LABEL_EXCLUSIONS = ['/session']; // a chat tab is named after its agent, not the route
  const ICON_EXCLUSIONS: string[] = []; // every route — including /session — names its own icon

  it('gives every router route a ROUTE_LABELS entry, except the documented exclusions', () => {
    const missing = APP_ROUTE_PATHS.filter(
      (path) => !(path in ROUTE_LABELS) && !LABEL_EXCLUSIONS.includes(path)
    );
    expect(missing, `ROUTE_LABELS is missing: ${missing.join(', ') || '(none)'}`).toEqual([]);
  });

  it('gives every router route a ROUTE_ICONS entry, except the documented exclusions', () => {
    const missing = APP_ROUTE_PATHS.filter(
      (path) => !(path in ROUTE_ICONS) && !ICON_EXCLUSIONS.includes(path)
    );
    expect(missing, `ROUTE_ICONS is missing: ${missing.join(', ') || '(none)'}`).toEqual([]);
  });

  it('carries no stale ROUTE_LABELS entry for a route the router no longer serves', () => {
    const stale = Object.keys(ROUTE_LABELS).filter(
      (path) => !(APP_ROUTE_PATHS as readonly string[]).includes(path)
    );
    expect(stale, `ROUTE_LABELS has a stale entry: ${stale.join(', ') || '(none)'}`).toEqual([]);
  });

  it('carries no stale ROUTE_ICONS entry for a route the router no longer serves', () => {
    // /session IS in APP_ROUTE_PATHS (it's a real route), so it's a valid
    // ROUTE_ICONS key even though ROUTE_LABELS excludes it by name — the two
    // maps' exclusion lists differ, not the route list they're checked against.
    const stale = Object.keys(ROUTE_ICONS).filter(
      (path) => !(APP_ROUTE_PATHS as readonly string[]).includes(path)
    );
    expect(stale, `ROUTE_ICONS has a stale entry: ${stale.join(', ') || '(none)'}`).toEqual([]);
  });
});
