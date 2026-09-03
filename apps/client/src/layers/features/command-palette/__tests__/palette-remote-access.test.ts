import { describe, it, expect } from 'vitest';
import {
  remoteAccessPaletteItems,
  REMOTE_ACCESS_PALETTE_ACTIONS,
} from '../model/palette-remote-access';

/** The action ids of whatever rows the derivation offers. */
function actionsFor(state: string, url: string | null, tokenConfigured: boolean): string[] {
  return remoteAccessPaletteItems(state, url, tokenConfigured).map((item) => item.action);
}

describe('while remote access is on', () => {
  it('offers the link, the code and the way off', () => {
    expect(actionsFor('connected', 'https://calm-otter.ngrok.app', true)).toEqual([
      REMOTE_ACCESS_PALETTE_ACTIONS.copyLink,
      REMOTE_ACCESS_PALETTE_ACTIONS.showQr,
      REMOTE_ACCESS_PALETTE_ACTIONS.turnOff,
    ]);
  });

  it('offers the same three while ngrok is re-establishing the session', () => {
    // The address is still the one the person copied, and turning it off is
    // still the way out of a reconnect loop.
    expect(actionsFor('reconnecting', 'https://calm-otter.ngrok.app', true)).toEqual([
      REMOTE_ACCESS_PALETTE_ACTIONS.copyLink,
      REMOTE_ACCESS_PALETTE_ACTIONS.showQr,
      REMOTE_ACCESS_PALETTE_ACTIONS.turnOff,
    ]);
  });

  it('reads as a plain, searchable set of rows', () => {
    const items = remoteAccessPaletteItems('connected', 'https://a.app', true);
    expect(items.map((i) => i.label)).toEqual([
      'Copy remote link',
      'Show QR code',
      'Turn remote access off',
    ]);
    for (const item of items) {
      expect(item.category).toBe('quick-action');
      expect(item.keywords).toContain('remote');
    }
  });
});

describe('while it is set up but off', () => {
  it('offers only the way on', () => {
    expect(actionsFor('off', null, true)).toEqual([REMOTE_ACCESS_PALETTE_ACTIONS.turnOn]);
  });

  it('offers the way on after a failed start, which IS the retry', () => {
    expect(actionsFor('error', null, true)).toEqual([REMOTE_ACCESS_PALETTE_ACTIONS.turnOn]);
  });
});

describe('rows that would only disappoint are not offered', () => {
  it('offers nothing before the one-time setup is done', () => {
    // Setting remote access up is a task with its own screen; ⌘K is not where
    // it belongs.
    expect(actionsFor('off', null, false)).toEqual([]);
    expect(actionsFor('error', null, false)).toEqual([]);
  });

  it('offers nothing mid-transition', () => {
    // There is no link to copy yet, and a row that copies `null` is worse than
    // no row.
    expect(actionsFor('starting', null, true)).toEqual([]);
    expect(actionsFor('stopping', 'https://a.app', true)).toEqual([]);
  });

  it('offers no copy for a state that claims to be up but cannot say where', () => {
    expect(actionsFor('connected', null, true)).toEqual([]);
    expect(actionsFor('reconnecting', null, true)).toEqual([]);
  });
});

describe('the ids the dispatcher switches on', () => {
  it('are stable and unique, so a row cannot silently do nothing', () => {
    const ids = Object.values(REMOTE_ACCESS_PALETTE_ACTIONS);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).toEqual([
      'copyRemoteLink',
      'showRemoteQr',
      'turnRemoteAccessOn',
      'turnRemoteAccessOff',
    ]);
  });

  it('never collide with a built-in palette id', () => {
    const rowIds = [
      ...remoteAccessPaletteItems('connected', 'https://a.app', true),
      ...remoteAccessPaletteItems('off', null, true),
    ].map((item) => item.id);
    expect(new Set(rowIds).size).toBe(rowIds.length);
    for (const id of rowIds) expect(id.startsWith('remote-access-')).toBe(true);
  });
});
