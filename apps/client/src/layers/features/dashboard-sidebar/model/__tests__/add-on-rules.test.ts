/**
 * Library's Add-ons section — the pages mini apps add (spec
 * `mini-app-placement` Part 2): present only with a page to list, last in
 * Library, foldable under its own stored id, and never something the operator
 * can drag, pin, mute or be badged by.
 *
 * @module features/dashboard-sidebar/model/__tests__/add-on-rules
 */
import { describe, expect, it } from 'vitest';
import {
  buildSidebarModel,
  persistedSectionId,
  SIDEBAR_FOLDING_SECTION_IDS,
  SIDEBAR_LIBRARY_SECTION_IDS,
  type SidebarModel,
  type SidebarSectionModel,
} from '../build-sidebar-model';
import { addOn, busyFixture, emptyState, powerFixture, prefs } from '../fixtures';
import { rowKey } from '../rules/targets';
import type { SidebarState } from '../sidebar-state';

/** The Library sections of one state. */
function library(state: SidebarState): SidebarSectionModel[] {
  return buildSidebarModel(state).zones.find((zone) => zone.id === 'library')?.sections ?? [];
}

/** The Add-ons section of one state, if the model emitted one. */
function addOns(state: SidebarState): SidebarSectionModel | undefined {
  return library(state).find((section) => section.id === 'addons');
}

/** Every row key in one zone of a built model. */
function zoneKeys(model: SidebarModel, zoneId: string): string[] {
  const zone = model.zones.find((entry) => entry.id === zoneId);
  return zone?.sections.flatMap((section) => section.rows.map((row) => rowKey(row.target))) ?? [];
}

const FLOW = addOn('flow', '', 'Flow');
const FLOW_SETTINGS = addOn('flow', 'settings', 'Flow settings');
const SOCIAL = addOn('social-queue', '', 'Social Queue');

describe('the Add-ons section', () => {
  it('is absent when no mini app added a page', () => {
    // Every journey fixture carries no pages, so none of them may grow the
    // section — chrome appears by data volume (BC-32).
    expect(addOns(busyFixture)).toBeUndefined();
    expect(addOns(powerFixture)).toBeUndefined();
  });

  it('is the whole of Library when pages are all there is', () => {
    // A fresh install with one mini app: no rooms, no agents, and still a
    // Library to put the page in.
    const ids = library(emptyState({ addOns: [FLOW] })).map((section) => section.id);
    expect(ids).toEqual(['addons']);
  });

  it('sits last, after Agents and after the operator’s own sections', () => {
    const state: SidebarState = { ...powerFixture, addOns: [FLOW] };
    const ids = library(state).map((section) => section.id);
    expect(ids.at(-1)).toBe('addons');
    expect(ids.indexOf('addons')).toBe(ids.indexOf('agents') + 1);
    expect(SIDEBAR_LIBRARY_SECTION_IDS.at(-1)).toBe('addons');
  });

  it('lists one row per page, by its own title, in the order it was given', () => {
    // The assembly hook hands pages over already sorted by title; Library
    // never reorders what it is given.
    const section = addOns({ ...busyFixture, addOns: [FLOW, FLOW_SETTINGS, SOCIAL] });
    expect(section?.label).toBe('Add-ons');
    expect(section?.reason).toBe('library:addons');
    expect(section?.rows.map((row) => row.primary)).toEqual([
      'Flow',
      'Flow settings',
      'Social Queue',
    ]);
  });

  it('points each row at its page, drawn with the page’s own icon', () => {
    const [row] = addOns({ ...busyFixture, addOns: [FLOW_SETTINGS] })?.rows ?? [];
    expect(row?.target).toEqual({ kind: 'add-on', extensionId: 'flow', path: 'settings' });
    expect(row?.glyph).toEqual({ kind: 'page-icon', pageId: 'flow:settings' });
    expect(row?.key).toBe('add-on:flow:settings');
    expect(row?.reason).toBe('library:add-on');
  });

  it('gives a home page and a page under it two different keys', () => {
    // Two rows may not share a key: React would collide them, and the active
    // tint is found by key.
    const rows = addOns({ ...busyFixture, addOns: [FLOW, FLOW_SETTINGS] })?.rows ?? [];
    expect(new Set(rows.map((row) => rowKey(row.target))).size).toBe(2);
  });

  it('names the extension when two pages share a title, and only then', () => {
    // Two extensions each with a "Settings" page: one row per page still, and
    // each says whose it is, the way a session row says whose chat it is.
    const flowSettings = addOn('flow', 'settings', 'Settings');
    const socialSettings = addOn('social-queue', 'settings', 'Settings');
    const rows = addOns({ ...busyFixture, addOns: [FLOW, flowSettings, socialSettings] })?.rows;
    expect(rows?.map((row) => [row.primary, row.secondary])).toEqual([
      ['Flow', undefined],
      ['flow', 'Settings'],
      ['social-queue', 'Settings'],
    ]);
    expect(new Set(rows?.map((row) => rowKey(row.target))).size).toBe(3);
  });

  it('is never dragged, muted or badged', () => {
    const rows = addOns({ ...busyFixture, addOns: [FLOW, SOCIAL] })?.rows ?? [];
    expect(rows).toHaveLength(2);
    for (const row of rows) {
      expect(row.draggable).toBe(false);
      expect(row.muted).toBe(false);
      expect(row.unread).toEqual({ tier: 'none' });
    }
  });

  it('folds under its own stored id, and says how many pages it holds', () => {
    const open = addOns({ ...busyFixture, addOns: [FLOW, SOCIAL] });
    expect(open?.collapsible).toBe(true);
    expect(open?.collapsed).toBe(false);

    const folded = addOns({
      ...busyFixture,
      addOns: [FLOW, SOCIAL],
      prefs: prefs({ ...busyFixture.prefs, sections: { addons: { collapsed: true } } }),
    });
    expect(folded?.collapsed).toBe(true);
    expect(folded?.rollup).toEqual({ count: 2, unread: { tier: 'none' }, workingCount: 0 });
  });

  it('has somewhere to store its fold', () => {
    // Without it, the header's toggle would return early and the fold would
    // look like a dead control.
    expect(SIDEBAR_FOLDING_SECTION_IDS).toContain('addons');
    expect(persistedSectionId('addons')).toBe('addons');
  });

  it('keeps an open page out of Today', () => {
    // A page is not a conversation: having one open must not pin anything into
    // Today the way an open session or room does.
    const target = { kind: 'add-on', extensionId: 'flow', path: '' } as const;
    const onPage = buildSidebarModel({ ...busyFixture, addOns: [FLOW], activeTarget: target });
    const offPage = buildSidebarModel({ ...busyFixture, addOns: [FLOW], activeTarget: null });
    expect(zoneKeys(onPage, 'today')).not.toContain(rowKey(target));
    expect(zoneKeys(onPage, 'today')).toEqual(zoneKeys(offPage, 'today'));
  });
});
