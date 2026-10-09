import { describe, expect, it } from 'vitest';
import { BROWSER_SETTING_UNAVAILABLE, browserSettingRefusal } from '../browser-setting.js';
describe('browser setting admission', () => {
  it('refuses enabling and permits disabling without claiming readiness', () => {
    expect(browserSettingRefusal('browser', { enabled: true })).toBe(BROWSER_SETTING_UNAVAILABLE);
    expect(browserSettingRefusal('browser.enabled', true)).toBe(BROWSER_SETTING_UNAVAILABLE);
    expect(browserSettingRefusal('browser.enabled', false)).toBeNull();
    expect(browserSettingRefusal('browser', {})).toBeNull();
  });
});

it('generic config writes cannot select another Chrome identity, even while Off', () => {
  expect(browserSettingRefusal('browser.chromeUserAgent', true)).not.toBeNull();
  expect(browserSettingRefusal('browser.chromeUserAgent', false)).not.toBeNull();
  expect(
    browserSettingRefusal('browser', { enabled: false, chromeUserAgent: true }, false)
  ).not.toBeNull();
  expect(
    browserSettingRefusal('browser', { enabled: false, chromeUserAgent: true }, true)
  ).toBeNull();
  expect(browserSettingRefusal('browser.enabled', false)).toBeNull();
});
