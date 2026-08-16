/**
 * The push-in stack's reducers (spec `profile-unification` §1.3).
 *
 * Both homes drive these — the sheet from the URL, the docked panel (W2.3) from
 * a store — so what push and pop MEAN is pinned here rather than twice.
 */
import { describe, it, expect } from 'vitest';
import {
  asProfilePageId,
  currentPage,
  popEntry,
  profileStack,
  pushEntry,
  stackMemberId,
} from '../model/profile-stack';

describe('reading a page id off a link', () => {
  it('accepts the pages that exist', () => {
    expect(asProfilePageId('manages')).toBe('manages');
    expect(asProfilePageId('sessions')).toBe('sessions');
  });

  it('lands on the root rather than nothing when a link names no page', () => {
    // A bookmark from a future build, a typo, an empty param. The profile is
    // still the address; the page is the part that can be wrong.
    expect(asProfilePageId('nonsense')).toBeNull();
    expect(asProfilePageId(undefined)).toBeNull();
    expect(asProfilePageId('')).toBeNull();
  });
});

describe('pushing and popping', () => {
  const root = profileStack('person-dorian');

  it('starts on a profile with nothing on top of it', () => {
    expect(currentPage(root)).toBeNull();
    expect(stackMemberId(root)).toBe('person-dorian');
  });

  it('shows the page that was pushed', () => {
    const withPage = pushEntry(root, { kind: 'page', page: 'manages' });
    expect(currentPage(withPage)).toBe('manages');
  });

  it('pops back to where it came from', () => {
    const withPage = pushEntry(root, { kind: 'page', page: 'manages' });
    expect(currentPage(popEntry(withPage))).toBeNull();
  });

  it('pops the root to itself rather than into nothing', () => {
    expect(popEntry(root)).toEqual(root);
  });

  it('follows a chained profile, and drops the page it was pushed from', () => {
    // Pushing an agent from inside Manages means you are looking at the agent —
    // not at the agent's copy of a page that belonged to its owner.
    const chained = pushEntry(pushEntry(root, { kind: 'page', page: 'manages' }), {
      kind: 'profile',
      memberId: 'agent-warden',
    });

    expect(stackMemberId(chained)).toBe('agent-warden');
    expect(currentPage(chained)).toBeNull();
  });

  it('reads the page of the profile that is actually on top', () => {
    const deep = pushEntry(pushEntry(root, { kind: 'profile', memberId: 'agent-warden' }), {
      kind: 'page',
      page: 'sessions',
    });

    expect(stackMemberId(deep)).toBe('agent-warden');
    expect(currentPage(deep)).toBe('sessions');
  });

  it('never mutates the stack it was given', () => {
    const pushed = pushEntry(root, { kind: 'page', page: 'manages' });
    expect(root.entries).toHaveLength(0);
    expect(pushed).not.toBe(root);
  });
});
