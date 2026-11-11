/** The orange frame's theme, with fakes. Nothing here launches a browser. */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { BrowserContext } from 'playwright-core';
import {
  AGENT_FRAME_HEX,
  agentThemeManifest,
  agentWindowThemeArgs,
  assertAgentFrame,
  clearAgentWindowTheme,
  writeAgentWindowTheme,
} from '../theme.js';
import {
  AGENT_CHROME_COLOR,
  writeAgentChromeProfile,
  clearAgentChromeProfile,
} from '../chrome-profile.js';
import { plainChromiumArgs } from '../../plain-chromium.js';

let root: string;
let profile: string;
beforeEach(() => {
  root = mkdtempSync(path.join(tmpdir(), 'agent-theme-'));
  profile = path.join(root, 'browser-profiles', 'default');
  mkdirSync(path.join(profile, 'Default'), { recursive: true });
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

const prefsFile = () => path.join(profile, 'Default', 'Preferences');
const readPrefs = () => JSON.parse(readFileSync(prefsFile(), 'utf8'));

function fakeContext(evaluate: () => Promise<string>) {
  const page = { goto: vi.fn(async () => null), evaluate: vi.fn(evaluate), close: vi.fn() };
  return {
    context: { newPage: vi.fn(async () => page) } as unknown as BrowserContext,
    page,
  };
}

describe('the theme', () => {
  it('has only a theme: no scripts, permissions or host rules', () => {
    const manifest = agentThemeManifest();
    expect(Object.keys(manifest).sort()).toEqual(['manifest_version', 'name', 'theme', 'version']);
    expect(Object.keys(manifest.theme)).toEqual(['colors']);
  });

  it('is written from the server’s constants, over whatever is there', async () => {
    const planted = path.join(root, 'browser-profiles', '.agent-window-theme');
    mkdirSync(planted, { recursive: true });
    writeFileSync(path.join(planted, 'manifest.json'), '{"content_scripts":[{}]}');
    writeFileSync(path.join(planted, 'evil.js'), 'alert(1)');
    const folder = await writeAgentWindowTheme(profile);
    expect(folder).toBe(planted);
    expect(JSON.parse(readFileSync(path.join(folder, 'manifest.json'), 'utf8'))).toEqual(
      agentThemeManifest()
    );
    expect(() => readFileSync(path.join(folder, 'evil.js'))).toThrow();
  });

  it('loads that folder and nothing else', () => {
    expect(agentWindowThemeArgs('/data/theme')).toEqual([
      '--disable-extensions-except=/data/theme',
      '--load-extension=/data/theme',
    ]);
  });

  it('never reaches the plain sign-in window', () => {
    const args = plainChromiumArgs(profile, 'https://example.com/', 'example.com');
    expect(args).toContain('--disable-extensions');
    expect(args.join(' ')).not.toMatch(/load-extension|disable-extensions-except/);
  });
});

describe('taking the theme out for a plain window', () => {
  it('removes our theme and leaves the other preferences', async () => {
    writeFileSync(
      prefsFile(),
      JSON.stringify({
        credentials_enable_service: false,
        extensions: {
          theme: { id: 'abc', pack: '/data/browser-profiles/.agent-window-theme' },
          other: 1,
        },
      })
    );
    await clearAgentWindowTheme(profile);
    expect(readPrefs()).toEqual({ credentials_enable_service: false, extensions: { other: 1 } });
  });

  it('removes it when the saved path is a file inside our folder', async () => {
    writeFileSync(
      prefsFile(),
      JSON.stringify({
        extensions: {
          theme: { pack: '/data/browser-profiles/.agent-window-theme/Cached Theme.pak' },
        },
      })
    );
    await clearAgentWindowTheme(profile);
    expect(readPrefs()).toEqual({ extensions: {} });
  });

  it('leaves any other theme alone', async () => {
    const prefs = { extensions: { theme: { id: 'abc', pack: '/somewhere/a-persons-theme' } } };
    writeFileSync(prefsFile(), JSON.stringify(prefs));
    await clearAgentWindowTheme(profile);
    expect(readPrefs()).toEqual(prefs);
  });

  it('is fine with no preferences yet', async () => {
    await expect(clearAgentWindowTheme(profile)).resolves.toBeUndefined();
  });
});

describe('reading the colour back', () => {
  it('passes an orange frame and closes its page', async () => {
    const { context, page } = fakeContext(
      async () => `:root { --color-frame-active:${AGENT_FRAME_HEX}ff; }`
    );
    await expect(assertAgentFrame(context)).resolves.toBeUndefined();
    expect(page.close).toHaveBeenCalled();
  });

  it('refuses any other colour', async () => {
    const { context, page } = fakeContext(async () => '--color-frame-active:#1f2020ff;');
    await expect(assertAgentFrame(context)).rejects.toMatchObject({ code: 'window_unlabelled' });
    expect(page.close).toHaveBeenCalled();
  });

  it('refuses when the colour can’t be read', async () => {
    const { context } = fakeContext(async () => {
      throw new Error('no page');
    });
    await expect(assertAgentFrame(context)).rejects.toMatchObject({ code: 'window_unlabelled' });
    const none = fakeContext(async () => 'nothing here');
    await expect(assertAgentFrame(none.context)).rejects.toMatchObject({
      code: 'window_unlabelled',
    });
  });
});

describe('installed Chrome profile labels', () => {
  it('preserves unrelated profile data and removes the agent label for a plain handoff', async () => {
    writeFileSync(
      prefsFile(),
      JSON.stringify({
        credentials_enable_service: false,
        profile: { password_manager_enabled: false },
        unrelated: { keep: true },
      })
    );
    const localFile = path.join(profile, 'Local State');
    writeFileSync(
      localFile,
      JSON.stringify({
        browser: { keep: true },
        profile: { info_cache: { Other: { name: 'Other' } } },
      })
    );
    await writeAgentChromeProfile(profile, 'Atlas');
    expect(readPrefs()).toMatchObject({
      credentials_enable_service: false,
      unrelated: { keep: true },
      profile: { name: 'Atlas · DorkOS', password_manager_enabled: false },
      autogenerated: { theme: { color: AGENT_CHROME_COLOR } },
    });
    await clearAgentChromeProfile(profile);
    expect(readPrefs()).toMatchObject({
      credentials_enable_service: false,
      unrelated: { keep: true },
      profile: { name: 'You · DorkOS', password_manager_enabled: false, avatar_index: 0 },
    });
    expect(readPrefs().extensions.theme).toBeUndefined();
    expect(readPrefs().autogenerated.theme).toBeUndefined();
    const local = JSON.parse(readFileSync(localFile, 'utf8'));
    expect(local).toMatchObject({
      browser: { keep: true },
      profile: {
        info_cache: {
          Default: { name: 'You · DorkOS', avatar_icon: 'chrome://theme/IDR_PROFILE_AVATAR_0' },
          Other: { name: 'Other' },
        },
      },
    });
  });
});
