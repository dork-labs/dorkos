// @vitest-environment node
/**
 * The Obsidian embed draws no app banner, and the runtime-sign-in row with it
 * (DOR-1680).
 *
 * The embed is one pane inside somebody else's app: it has no router, and it is
 * not where an operator manages runtime sign-ins — the same boundary
 * `NotificationCenter` keeps for knocks and OS banners. It holds structurally
 * rather than by a condition inside the widget: `AppShell` (the standalone web
 * and desktop cockpit, mounted as the `_shell` route) is the only thing that
 * calls `useAppBanners`, and the embed renders `App` instead.
 *
 * **A grep that finds nothing proves nothing**, so the negative assertion is
 * paired with a positive one over the same matcher and the same file walk: the
 * shell MUST still mount the slot. A wrong path, a typo'd token or an unreadable
 * file turns the control red before the "the embed does not" claim is made.
 *
 * @module widgets/app-banner/__tests__/embed-draws-no-app-banner
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';

/**
 * `apps/client/src`, from this file.
 *
 * Resolved off `import.meta.url` under the `node` environment declared at the
 * top: jsdom hands out an `http:` one, which `fileURLToPath` refuses.
 */
const CLIENT_SRC = resolve(fileURLToPath(new URL('.', import.meta.url)), '../../../..');

/** Read one file under `apps/client/src`, failing loudly if it moved. */
function readClientSource(relativePath: string): string {
  const source = readFileSync(resolve(CLIENT_SRC, relativePath), 'utf8');
  expect(
    source.length,
    `${relativePath} is empty — the guard below would be vacuous`
  ).toBeGreaterThan(0);
  return source;
}

describe('the app banner slot lives in the shell, not the embed', () => {
  it('is mounted by AppShell — the control that proves the matcher and the path', () => {
    const shell = readClientSource('AppShell.tsx');
    expect(shell).toContain('@/layers/widgets/app-banner');
    expect(shell).toContain('<AppBannerSlot');
  });

  it('is not mounted by the embedded App', () => {
    const embedded = readClientSource('App.tsx');
    expect(embedded).not.toContain('@/layers/widgets/app-banner');
    expect(embedded).not.toContain('AppBannerSlot');
  });
});
