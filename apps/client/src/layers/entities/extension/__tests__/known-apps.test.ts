// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';
import { forgetUninstalledApps, readKnownApps, rememberApps } from '../model/known-apps';

afterEach(() => localStorage.clear());

describe('known apps', () => {
  it('remembers an app across a reload, so a held one keeps its tile', () => {
    rememberApps({}, { radar: { name: 'Release Radar', path: 'feed' } });
    expect(readKnownApps()).toEqual({ radar: { name: 'Release Radar', path: 'feed' } });
  });

  it('returns the same object when nothing changed, so readers do not re-render', () => {
    const known = { radar: { name: 'Release Radar', path: '' } };
    expect(rememberApps(known, { radar: { name: 'Release Radar', path: '' } })).toBe(known);
  });

  it('forgets an app that is no longer installed', () => {
    const known = rememberApps({}, { a: { name: 'A', path: '' }, b: { name: 'B', path: '' } });
    expect(forgetUninstalledApps(known, new Set(['a']))).toEqual({ a: { name: 'A', path: '' } });
    expect(readKnownApps()).toEqual({ a: { name: 'A', path: '' } });
  });

  it('reads a damaged entry as nothing remembered', () => {
    localStorage.setItem('dorkos:apps:known', '{"x": 1, "y": {"name": "Y", "path": ""}');
    expect(readKnownApps()).toEqual({});
    localStorage.setItem('dorkos:apps:known', '{"x": 1, "y": {"name": "Y", "path": ""}}');
    expect(readKnownApps()).toEqual({ y: { name: 'Y', path: '' } });
  });
});
