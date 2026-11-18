import { describe, expect, it } from 'vitest';
import { refusalNotice } from '../lib/refusal-notice';

// DOR-4097: the in-app page notice for a site that refuses this browser. Made-up hosts.
const page = 'https://accounts.example.com/signin/rejected?x=1';
const signInRefusal = { kind: 'sign-in' as const, host: 'accounts.example.com' };
const block = { kind: 'blocked' as const, host: 'shop.northwind.example' };

describe('refusalNotice', () => {
  it('names the site by its registrable name and offers the sign-in window', () => {
    expect(refusalNotice({ refusal: signInRefusal, url: page })).toEqual({
      key: `sign-in:${page}`,
      text: 'example.com won’t let you sign in here.',
      action: { label: 'Open sign-in window', kind: 'sign-in' },
    });
  });

  it('says a blocked site won’t open here, and offers its own window by the same path', () => {
    expect(
      refusalNotice({ refusal: block, url: 'https://shop.northwind.example/cart' })
    ).toMatchObject({
      text: 'northwind.example won’t open here.',
      action: { label: 'Open in its own window', kind: 'sign-in' },
    });
  });

  it('gives way to a real load failure', () => {
    expect(
      refusalNotice({
        refusal: signInRefusal,
        url: page,
        failure: { code: 'ERR_TIMED_OUT', host: 'accounts.example.com', url: page },
      })
    ).toBeNull();
  });

  it('stays dismissed for the same page, and comes back on the next one', () => {
    const shown = refusalNotice({ refusal: signInRefusal, url: page })!;
    expect(refusalNotice({ refusal: signInRefusal, url: page, dismissed: shown.key })).toBeNull();
    expect(
      refusalNotice({
        refusal: signInRefusal,
        url: 'https://accounts.example.com/signin/rejected?x=2',
        dismissed: shown.key,
      })
    ).not.toBeNull();
  });

  it('after a saved sign-in for this site, offers its own window and waits for the click', () => {
    const signIn = {
      profileId: null,
      site: 'accounts.example.com',
      status: 'saved' as const,
      startedAt: '2026-11-17T20:00:00.000Z',
    };
    expect(refusalNotice({ refusal: signInRefusal, url: page, signIn })).toEqual({
      key: `saved:${signIn.startedAt}`,
      text: 'Signed in to example.com. It works in its own window, not here.',
      action: { label: 'Open in its own window', kind: 'own-window' },
    });
  });

  it('ignores a sign-in for another site, or one not saved yet', () => {
    const base = { profileId: null, startedAt: '2026-11-17T20:00:00.000Z' };
    for (const signIn of [
      { ...base, site: 'elsewhere.example', status: 'saved' as const },
      { ...base, site: 'accounts.example.com', status: 'open' as const },
    ])
      expect(refusalNotice({ refusal: signInRefusal, url: page, signIn })?.action.kind).toBe(
        'sign-in'
      );
  });

  it('says nothing on an ordinary page', () => {
    expect(refusalNotice({ refusal: null, url: 'https://example.com/' })).toBeNull();
  });
});
