import { describe, it, expect } from 'vitest';
import { parseTabHref, projectName, fallbackTabLabel } from '../lib/tab-target';

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
    expect(parseTabHref('/agents?view=topology&session=abc')).toEqual({
      pathname: '/agents',
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
    expect(fallbackTabLabel(parseTabHref('/'))).toBe('Dashboard');
    expect(fallbackTabLabel(parseTabHref('/agents'))).toBe('Agents');
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
