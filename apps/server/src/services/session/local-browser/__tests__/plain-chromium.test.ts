/** The sign-in window's command line and profile, checked without ever launching Chrome. */
import { mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  FORBIDDEN_PLAIN_FLAGS,
  disablePasswordSaving,
  plainChromiumArgs,
  profileHeld,
} from '../plain-chromium.js';

let folder: string;
beforeEach(() => {
  folder = mkdtempSync(path.join(tmpdir(), 'plain-chromium-'));
});
afterEach(() => rmSync(folder, { recursive: true, force: true }));

describe('plainChromiumArgs', () => {
  const args = plainChromiumArgs('/profiles/default', 'https://linear.app/', 'linear.app');

  it('opens no debugging or automation channel', () => {
    for (const flag of FORBIDDEN_PLAIN_FLAGS)
      expect(args.some((arg) => arg.startsWith(flag))).toBe(false);
    expect(args.some((arg) => /remote-debugging|automation|headless/.test(arg))).toBe(false);
  });

  it('never touches the macOS Keychain and reads the same cookies as the agent window', () => {
    expect(args).toContain('--use-mock-keychain');
    expect(args).toContain('--password-store=basic');
  });

  it('uses the profile folder, names the site in the title, and opens the page', () => {
    expect(args).toContain('--user-data-dir=/profiles/default');
    expect(args).toContain('--window-name=Sign in to linear.app · DorkOS');
    expect(args.at(-1)).toBe('https://linear.app/');
  });
});

describe('disablePasswordSaving', () => {
  const prefsFile = () => path.join(folder, 'Default', 'Preferences');
  const prefs = () => JSON.parse(readFileSync(prefsFile(), 'utf8'));

  it('turns off password saving in a new profile', async () => {
    await disablePasswordSaving(folder);
    expect(prefs().credentials_enable_service).toBe(false);
    expect(prefs().profile.password_manager_enabled).toBe(false);
  });

  it('keeps the profile’s other preferences', async () => {
    mkdirSync(path.join(folder, 'Default'), { recursive: true });
    writeFileSync(
      prefsFile(),
      JSON.stringify({
        credentials_enable_service: true,
        profile: { name: 'Work', password_manager_enabled: true },
        homepage: 'https://example.test/',
      })
    );
    await disablePasswordSaving(folder);
    expect(prefs()).toEqual({
      credentials_enable_service: false,
      profile: { name: 'Work', password_manager_enabled: false },
      homepage: 'https://example.test/',
    });
  });

  it('replaces unreadable preferences rather than failing open', async () => {
    mkdirSync(path.join(folder, 'Default'), { recursive: true });
    writeFileSync(prefsFile(), '{not json');
    await disablePasswordSaving(folder);
    expect(prefs().credentials_enable_service).toBe(false);
  });
});

describe('profileHeld', () => {
  it('is free with no lock', () => {
    expect(profileHeld(folder, 'darwin')).toBe(false);
  });

  it('is held while the lock names a live process', () => {
    symlinkSync(`host-${process.pid}`, path.join(folder, 'SingletonLock'));
    expect(profileHeld(folder, 'darwin')).toBe(true);
  });

  it('is free when the lock names a process that has gone', () => {
    // The largest pid is never live on macOS or Linux.
    symlinkSync('host-2147483646', path.join(folder, 'SingletonLock'));
    expect(profileHeld(folder, 'linux')).toBe(false);
  });
});
