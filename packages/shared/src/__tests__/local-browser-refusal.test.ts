import { describe, expect, it } from 'vitest';
import { classifyRefusal } from '../local-browser-refusal.js';

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

  it.each([
    [{ url: 'https://shop.example/', title: 'Just a moment...' }],
    [{ url: 'https://shop.example/', title: 'Attention Required! | Cloudflare' }],
    [{ url: 'https://shop.example/cdn-cgi/challenge-platform/h/b/x' }],
    [{ url: 'https://shop.example/', title: 'Access Denied' }],
    [{ url: 'https://shop.example/', text: 'Reference #18.1 https://errors.edgesuite.net/18.1' }],
    [{ url: 'https://shop.example/', text: 'Press & Hold to confirm you are a human' }],
    [{ url: 'https://geo.captcha-delivery.com/captcha/?x=1' }],
  ])('reads a bot check or block: %j', (page) => {
    expect(classifyRefusal(page)?.kind).toBe('blocked');
  });

  it('names the host from the address, never from the page text', () => {
    expect(
      classifyRefusal({
        url: 'https://shop.example:8443/x',
        title: 'Access Denied',
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
