// @vitest-environment node
/**
 * CountPill lives in `@dork-labs/ui` and draws from its `dui-*` tokens, so a
 * Space can use it. In the app it must look exactly as it did on the app's own
 * `--status-*` tokens. These pin the package's copies to the app's values in
 * both themes, so a later retune of one cannot silently split them (DOR-3635).
 *
 * @module __tests__/count-pill-token-parity
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join, resolve } from 'node:path';

const SRC = resolve(fileURLToPath(new URL('.', import.meta.url)), '..');
const UI_ROOT = resolve(SRC, '../../../packages/ui');
const app = readFileSync(join(SRC, 'index.css'), 'utf8');
const ui = readFileSync(join(UI_ROOT, 'tokens.css'), 'utf8');

/** Every value a stylesheet gives a custom property, in source order. */
function values(css: string, name: string): string[] {
  const re = new RegExp(`^\\s*--${name}:\\s*([^;]+);`, 'gm');
  return [...css.matchAll(re)].map((m) => m[1]!.trim());
}

describe("CountPill's dui status tokens", () => {
  it.each(['warning-bg', 'warning-fg', 'error-bg', 'error-fg'])(
    'status-%s matches the app in light and dark',
    (suffix) => {
      // The app: light (:root, .light), then .dark. The modal's error ink comes after.
      const [appLight, appDark] = values(app, `status-${suffix}`);
      // The package: light, the OS-dark media query, then .dark.
      const [uiLight, uiMediaDark, uiDark] = values(ui, `dui-status-${suffix}`);
      expect(appLight).toBeDefined();
      expect(uiLight).toBe(appLight);
      expect(uiMediaDark).toBe(appDark);
      expect(uiDark).toBe(appDark);
    }
  );

  // A dark dialog raises the app's error ink; the pill's copy has to follow it there.
  it('follows the app when a dark modal raises the error ink', () => {
    expect(values(app, 'dui-status-error-fg')).toEqual(['var(--status-error-fg)']);
  });

  it('sizes the figures on the app text dial, as text-2xs and text-3xs are', () => {
    expect(values(app, 'dui-text-2xs')).toEqual(values(app, 'text-2xs'));
    expect(values(app, 'dui-text-3xs')).toEqual(values(app, 'text-3xs'));
  });
});
