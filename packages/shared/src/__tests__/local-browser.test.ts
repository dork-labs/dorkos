import { describe, expect, it } from 'vitest';
import {
  LocalBrowserModeSchema,
  LocalBrowserOpenSchema,
  LocalBrowserStateSchema,
  LocalBrowserCapabilitiesSchema,
} from '../local-browser.js';

describe('owned local browser contract', () => {
  it('offers exactly the embedded browser and separate new window', () => {
    expect(LocalBrowserModeSchema.options).toEqual(['embedded', 'new-window']);
    for (const mode of LocalBrowserModeSchema.options)
      expect(
        LocalBrowserOpenSchema.parse({ mode, sessionId: 'chat-one', url: 'https://fixture.test/' })
      ).toEqual({ mode, sessionId: 'chat-one', url: 'https://fixture.test/' });
  });
  it('refuses personal-browser modes and their retired setup fields', () => {
    expect(LocalBrowserOpenSchema.safeParse({ mode: 'existing' }).success).toBe(false);
    for (const field of [{ channel: 'chrome' }, { channel: 'msedge' }, { consent: true }])
      expect(LocalBrowserOpenSchema.safeParse({ mode: 'new-window', ...field }).success).toBe(
        false
      );
  });
  it('exposes no channel, permission guide or existing-version contract', () => {
    for (const field of ['channel', 'browserVersion'])
      expect(LocalBrowserStateSchema.shape).not.toHaveProperty(field);
    for (const field of ['existing', 'existingSetup', 'existingBrowserVersions'])
      expect(LocalBrowserCapabilitiesSchema.shape).not.toHaveProperty(field);
    expect(Object.keys(LocalBrowserCapabilitiesSchema.shape.unavailableReasons.shape)).toEqual([
      'embedded',
      'new-window',
    ]);
  });
});
