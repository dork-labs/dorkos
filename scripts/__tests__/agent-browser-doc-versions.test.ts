/**
 * The Agent browser guide names the Playwright and Chromium versions DorkOS ships (DOR-4345).
 * Both come from the installed package, never from memory: the guide drifted once already,
 * naming 1.63.0 / Chromium 153 two bumps after they had gone.
 */
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = join(import.meta.dirname, '../..');
const GUIDE = join(root, 'docs/guides/agent-browser.mdx');
const fromBrowser = createRequire(join(root, 'packages/browser/package.json'));

/** The `playwright-core` version `packages/browser` pins. */
function pinnedPlaywright(): string {
  const manifest = JSON.parse(
    readFileSync(join(root, 'packages/browser/package.json'), 'utf8')
  ) as { dependencies?: Record<string, string> };
  const version = manifest.dependencies?.['playwright-core'];
  if (!version) throw new Error('packages/browser no longer depends on playwright-core');
  return version;
}

/** The Chromium version the installed `playwright-core` downloads. */
function shippedChromium(): string {
  // browsers.json is not in the package's exports map, so read it beside package.json.
  const packageDir = dirname(fromBrowser.resolve('playwright-core/package.json'));
  const { browsers } = JSON.parse(readFileSync(join(packageDir, 'browsers.json'), 'utf8')) as {
    browsers: { name: string; browserVersion?: string }[];
  };
  const chromium = browsers.find((browser) => browser.name === 'chromium')?.browserVersion;
  if (!chromium) throw new Error('playwright-core lists no Chromium version');
  return chromium;
}

describe('the Agent browser guide', () => {
  const guide = readFileSync(GUIDE, 'utf8');
  const playwright = pinnedPlaywright();

  it('names the pinned Playwright version', () => {
    expect(guide).toContain(`pins Playwright to ${playwright}`);
  });

  it('says so when that version is a pre-release', () => {
    expect(guide.includes('pre-release')).toBe(playwright.includes('-'));
  });

  it('names the major version of the Chromium it downloads', () => {
    const major = shippedChromium().split('.')[0];
    expect(guide).toContain(`The Chromium it downloads is version ${major}.`);
  });

  it('reads the version the install actually resolved', () => {
    const installed = (
      JSON.parse(readFileSync(fromBrowser.resolve('playwright-core/package.json'), 'utf8')) as {
        version: string;
      }
    ).version;
    expect(installed).toBe(playwright);
  });
});
