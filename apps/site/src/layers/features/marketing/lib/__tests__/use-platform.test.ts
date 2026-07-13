/**
 * @vitest-environment jsdom
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { detectPlatform } from '../use-platform';

/** Swap in a fake `navigator` shape for the duration of one assertion. */
function stubNavigator(overrides: {
  userAgent?: string;
  platform?: string;
  maxTouchPoints?: number;
}): void {
  vi.stubGlobal('navigator', {
    userAgent: overrides.userAgent ?? '',
    platform: overrides.platform ?? '',
    maxTouchPoints: overrides.maxTouchPoints ?? 0,
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('detectPlatform', () => {
  it('detects an Apple Silicon Mac as "mac"', () => {
    stubNavigator({
      userAgent:
        'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15',
      platform: 'MacIntel',
      maxTouchPoints: 0,
    });
    expect(detectPlatform()).toBe('mac');
  });

  it('detects an Intel Mac as "mac" too (Intel Macs fall back to the terminal, but still see the card)', () => {
    stubNavigator({
      userAgent:
        'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      platform: 'MacIntel',
      maxTouchPoints: 0,
    });
    expect(detectPlatform()).toBe('mac');
  });

  it('treats iPadOS (masquerades as Mac, but is touch) as "other"', () => {
    stubNavigator({
      userAgent:
        'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15',
      platform: 'MacIntel',
      maxTouchPoints: 5,
    });
    expect(detectPlatform()).toBe('other');
  });

  it('treats an iPhone as "other"', () => {
    stubNavigator({
      userAgent:
        'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1',
      platform: 'iPhone',
      maxTouchPoints: 5,
    });
    expect(detectPlatform()).toBe('other');
  });

  it('detects Windows as "windows"', () => {
    stubNavigator({
      userAgent:
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      platform: 'Win32',
      maxTouchPoints: 0,
    });
    expect(detectPlatform()).toBe('windows');
  });

  it('detects Windows from the userAgent even when navigator.platform is empty', () => {
    stubNavigator({
      userAgent:
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      platform: '',
      maxTouchPoints: 0,
    });
    expect(detectPlatform()).toBe('windows');
  });

  it('treats Linux as "other"', () => {
    stubNavigator({
      userAgent:
        'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      platform: 'Linux x86_64',
      maxTouchPoints: 0,
    });
    expect(detectPlatform()).toBe('other');
  });
});
