/**
 * The orange frame on a window an agent drives (DOR-3218).
 *
 * The frame comes from a code-free browser theme: colours in a manifest, with no
 * scripts, permissions or host rules, so it can't touch a page. Profile colour
 * settings only reach a dark brown or a pale peach, so they can't say "an agent is
 * driving". DorkOS writes the theme fresh at each launch from the constants here.
 *
 * Chromium keeps a loaded theme in the profile, and the plain sign-in window shares
 * that profile. So a plain launch takes the theme out first, or a person would sign
 * in inside a window that looks agent-driven.
 *
 * The frame is a label, not a boundary. Never say a page can't hide it.
 */
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { BrowserContext } from 'playwright-core';
import { LocalBrowserError } from '../errors.js';

/** The frame's colour, hsl(24 88% 38%): at least 5.2:1 under white text in both themes. */
export const AGENT_FRAME_RGB = [182, 82, 11] as const;
/** The same colour as Chromium's own theme data reports it. */
export const AGENT_FRAME_HEX = '#b6520b';

/** The theme's folder name, beside the profiles, under the one folder agents are denied. */
const THEME_FOLDER = '.agent-window-theme';
const READ_BACK_TIMEOUT_MS = 10_000;

/** The whole of the theme: colours, and nothing that can run. */
export function agentThemeManifest() {
  return {
    manifest_version: 3,
    name: 'DorkOS agent window',
    version: '1',
    theme: {
      colors: {
        frame: [...AGENT_FRAME_RGB],
        frame_inactive: [...AGENT_FRAME_RGB],
        toolbar: [250, 235, 225],
        tab_text: [30, 30, 30],
        tab_background_text: [255, 255, 255],
      },
    },
  };
}

/**
 * Write the theme, replacing whatever is in its folder, right before a launch.
 *
 * @param profileFolder - The agent window's profile, under `browser-profiles/`.
 * @returns The theme's folder.
 */
export async function writeAgentWindowTheme(profileFolder: string): Promise<string> {
  const folder = path.join(path.dirname(profileFolder), THEME_FOLDER);
  await rm(folder, { recursive: true, force: true });
  await mkdir(folder, { recursive: true, mode: 0o700 });
  await writeFile(path.join(folder, 'manifest.json'), JSON.stringify(agentThemeManifest()), {
    mode: 0o600,
  });
  return folder;
}

/**
 * The launch flags that load the theme and nothing else.
 *
 * @param themeFolder - The folder {@link writeAgentWindowTheme} returned.
 */
export function agentWindowThemeArgs(themeFolder: string): string[] {
  return [`--disable-extensions-except=${themeFolder}`, `--load-extension=${themeFolder}`];
}

/**
 * Take the agent window's theme out of a profile before a plain window opens on it.
 * Any other theme stays.
 *
 * @param profileFolder - The profile's folder.
 */
export async function clearAgentWindowTheme(profileFolder: string): Promise<void> {
  const file = path.join(profileFolder, 'Default', 'Preferences');
  let prefs: { extensions?: { theme?: { pack?: unknown } } };
  try {
    prefs = JSON.parse(await readFile(file, 'utf8')) as typeof prefs;
  } catch {
    return; // No preferences yet: no theme to take out.
  }
  const pack = prefs?.extensions?.theme?.pack;
  if (typeof pack !== 'string' || path.basename(pack) !== THEME_FOLDER) return;
  delete prefs.extensions!.theme;
  await writeFile(file, JSON.stringify(prefs), { mode: 0o600 });
}

/**
 * Refuse a window that didn't come up orange. An unlabelled agent window is the
 * unsafe direction, so this reads the colour back from Chromium's own theme data.
 *
 * @param context - The just-launched window.
 */
export async function assertAgentFrame(context: BrowserContext): Promise<void> {
  let frame: string | undefined;
  try {
    const page = await context.newPage();
    try {
      await page.goto('chrome://theme/colors.css?sets=ui,chrome', {
        timeout: READ_BACK_TIMEOUT_MS,
      });
      const css = await page.evaluate(() => document.body.innerText);
      frame = /--color-frame-active:\s*(#[0-9a-f]{6})/i.exec(css)?.[1]?.toLowerCase();
    } finally {
      await page.close();
    }
  } catch {
    frame = undefined;
  }
  if (frame !== AGENT_FRAME_HEX)
    throw new LocalBrowserError(
      'window_unlabelled',
      'Couldn’t open the agent’s window with its orange frame. Try again.'
    );
}
