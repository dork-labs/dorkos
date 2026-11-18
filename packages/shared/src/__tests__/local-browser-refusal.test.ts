import { describe, expect, it } from 'vitest';
import { classifyRefusal, localBrowserRefusalNext } from '../local-browser-refusal.js';

describe('classifyRefusal', () => {
  it.each([
    ['https://accounts.google.com/v3/signin/rejected?continue=x', ''],
    ['https://accounts.google.com/signin/rejected', ''],
    ['https://accounts.google.com/v3/signin/identifier', 'Couldn’t sign you in'],
    ['https://accounts.google.com/v3/signin/identifier', "Couldn't sign you in"],
  ])('reads a Google sign-in refusal at %s', (url, title) => {
    expect(classifyRefusal({ url, title })).toEqual({
      kind: 'sign-in',
      host: 'accounts.google.com',
    });
  });

  it('reads the refusal from page text when the title says nothing', () => {
    expect(
      classifyRefusal({
        url: 'https://accounts.google.com/v3/signin/identifier',
        title: 'Sign in - Google Accounts',
        text: 'This browser or app may not be secure. Learn more',
      })
    ).toEqual({ kind: 'sign-in', host: 'accounts.google.com' });
  });

  it('leaves an ordinary Google sign-in page alone', () => {
    expect(
      classifyRefusal({
        url: 'https://accounts.google.com/v3/signin/identifier',
        title: 'Sign in - Google Accounts',
        text: 'Email or phone',
      })
    ).toBeNull();
  });

  // A vendor's own block page: a block signal alone, or a phrase beside its block title.
  it.each([
    ['Cloudflare by title', { url: 'https://shop.example/', title: 'Just a moment...' }],
    [
      'Cloudflare by its other title',
      { url: 'https://shop.example/', title: 'Attention Required! | Cloudflare' },
    ],
    [
      'Cloudflare by its challenge path',
      { url: 'https://shop.example/cdn-cgi/challenge-platform/h/b/x' },
    ],
    [
      'Cloudflare by title and words',
      {
        url: 'https://shop.example/',
        title: 'Just a moment...',
        text: 'Verify you are human by completing the action below.',
      },
    ],
    [
      'Akamai by title and its reference',
      {
        url: 'https://www.godaddy.example/',
        title: 'Access Denied',
        text: 'You don’t have permission to access this. Reference #18.1 https://errors.edgesuite.net/18.1',
      },
    ],
    [
      'Akamai by title and the desktop’s reference check',
      { url: 'https://www.godaddy.example/', title: 'Access Denied', akamaiReference: true },
    ],
    [
      'PerimeterX by title and words',
      {
        url: 'https://shop.example/',
        title: 'Access to this page has been denied',
        text: 'Press & Hold to confirm you are a human (and not a bot).',
      },
    ],
    ['DataDome by host', { url: 'https://geo.captcha-delivery.com/captcha/?x=1' }],
  ])('reads a block page: %s', (_label, page) => {
    expect(classifyRefusal(page)?.kind).toBe('blocked');
  });

  // DOR-4662: a phrase or a generic title alone is an ordinary page, never a refusal.
  it.each([
    [
      'a help page that says press and hold',
      {
        url: 'https://support.apple.example/en-us/HT201559',
        title: 'Force restart iPhone - Support',
        text: 'Press and hold the side button until the Apple logo appears.',
      },
    ],
    [
      'a plain site 403 titled Access denied',
      {
        url: 'https://intranet.northwind.example/payroll',
        title: 'Access denied',
        text: 'Access denied. You do not have permission to view this page.',
      },
    ],
    ['a bare Access denied title', { url: 'https://shop.example/', title: 'Access Denied' }],
    [
      'an article that quotes a bot check',
      {
        url: 'https://blog.example/captchas',
        title: 'Why sites ask you to verify you are human',
        text: 'The box says "Verify you are human". Then press & hold.',
      },
    ],
    [
      'a support note naming the Akamai reference host',
      {
        url: 'https://docs.example/akamai',
        title: 'Reading an Akamai error',
        text: 'The reference points at errors.edgesuite.net.',
      },
    ],
    [
      'a page that names px-captcha',
      { url: 'https://docs.example/px', title: 'Bot tools', text: 'The px-captcha element is…' },
    ],
    [
      'the PerimeterX title with no words',
      { url: 'https://shop.example/', title: 'Access to this page has been denied' },
    ],
  ])('leaves %s alone', (_label, page) => {
    expect(classifyRefusal(page)).toBeNull();
  });

  it('names the host from the address, never from the page text', () => {
    expect(
      classifyRefusal({
        url: 'https://shop.example:8443/x',
        title: 'Just a moment...',
        text: 'Sign in at attacker.example',
      })
    ).toEqual({ kind: 'blocked', host: 'shop.example:8443' });
  });

  it.each(['about:blank', 'file:///tmp/a.html', 'not a url', 'chrome://settings'])(
    'ignores %s',
    (url) => {
      expect(classifyRefusal({ url, title: 'Access Denied' })).toBeNull();
    }
  );

  it('ignores a page that only mentions access in passing', () => {
    expect(
      classifyRefusal({
        url: 'https://docs.example/',
        title: 'Access denied errors: a guide',
        text: 'How to fix an access denied error',
      })
    ).toBeNull();
  });
});

// DOR-4662: what the agent hears matches what its handoff tool allows.
describe('localBrowserRefusalNext', () => {
  it.each([
    ['sign-in', 'password'],
    ['blocked', 'wall'],
  ] as const)('a %s refusal hands the site to the person with reason %s', (kind, reason) => {
    const next = localBrowserRefusalNext(kind);
    expect(next).toContain('local_browser_ask_person');
    expect(next).toContain(`reason: ${reason}`);
    expect(next).toMatch(/\bStop\b/);
    expect(next).not.toMatch(/user.?agent|try again|instead use/i);
  });
});
