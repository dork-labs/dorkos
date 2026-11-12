/** The sign-in window's command line and profile, checked without ever launching Chrome. */
import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  FORBIDDEN_PLAIN_FLAGS,
  disablePasswordSaving,
  forgetOpenTabs,
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

  // DOR-4178, Security: the person's window reports webdriver=false only because nothing drives
  // it, so both ways to drive Chrome stay on the list every plain launch is checked against.
  it('keeps both debugging channels on the forbidden list', () => {
    expect(FORBIDDEN_PLAIN_FLAGS).toEqual(
      expect.arrayContaining(['--remote-debugging-pipe', '--remote-debugging-port'])
    );
  });

  it('never touches the macOS Keychain and reads the same cookies as the agent window', () => {
    expect(args).toContain('--use-mock-keychain');
    expect(args).toContain('--password-store=basic');
  });

  it('runs no extensions, which could read the page', () => {
    expect(args).toContain('--disable-extensions');
  });

  it('disables both HTTPS upgrade modes with one feature argument', () => {
    expect(args.filter((arg) => arg.startsWith('--disable-features='))).toEqual([
      '--disable-features=HttpsUpgrades,HttpsFirstBalancedModeAutoEnable',
    ]);
  });

  it('uses the profile folder, names the site in the title, and opens the page', () => {
    expect(args).toContain('--user-data-dir=/profiles/default');
    expect(args).toContain('--window-name=Sign in to linear.app');
    // DorkOS's name must not vouch for whatever page opens here.
    expect(args.some((arg) => arg.includes('DorkOS'))).toBe(false);
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

describe('forgetOpenTabs', () => {
  const defaults = () => path.join(folder, 'Default');
  const prefs = () => JSON.parse(readFileSync(path.join(defaults(), 'Preferences'), 'utf8'));

  it('removes the saved tabs and leaves the sign-ins alone', async () => {
    mkdirSync(path.join(defaults(), 'Sessions'), { recursive: true });
    writeFileSync(path.join(defaults(), 'Sessions', 'Session_1'), 'an agent tab');
    writeFileSync(path.join(defaults(), 'Sessions', 'Tabs_1'), 'an agent tab');
    mkdirSync(path.join(defaults(), 'Network'));
    writeFileSync(path.join(defaults(), 'Network', 'Cookies'), 'a sign-in');
    await forgetOpenTabs(folder);
    expect(existsSync(path.join(defaults(), 'Sessions'))).toBe(false);
    expect(readFileSync(path.join(defaults(), 'Network', 'Cookies'), 'utf8')).toBe('a sign-in');
  });

  it('tells Chromium not to restore, keeping the other preferences', async () => {
    mkdirSync(defaults(), { recursive: true });
    writeFileSync(
      path.join(defaults(), 'Preferences'),
      JSON.stringify({ session: { startup_urls: ['https://a.test/'] }, keep: 1 })
    );
    await forgetOpenTabs(folder);
    expect(prefs()).toMatchObject({
      keep: 1,
      session: { startup_urls: ['https://a.test/'], restore_on_startup: 5 },
    });
  });

  it('works on a profile that has never opened', async () => {
    await forgetOpenTabs(folder);
    expect(prefs().session.restore_on_startup).toBe(5);
  });

  it('removes a link in place of the folder, and not what it points to', async () => {
    const elsewhere = path.join(folder, 'elsewhere');
    mkdirSync(elsewhere);
    writeFileSync(path.join(elsewhere, 'keep'), 'x');
    mkdirSync(defaults());
    symlinkSync(elsewhere, path.join(defaults(), 'Sessions'));
    await forgetOpenTabs(folder);
    expect(existsSync(path.join(defaults(), 'Sessions'))).toBe(false);
    expect(readFileSync(path.join(elsewhere, 'keep'), 'utf8')).toBe('x');
  });

  it('keeps password saving off when both run', async () => {
    await disablePasswordSaving(folder);
    await forgetOpenTabs(folder);
    expect(prefs().credentials_enable_service).toBe(false);
    expect(prefs().profile.password_manager_enabled).toBe(false);
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
