import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { BUILT_IN_APPS } from '../resources/built-in-apps.js';

const ICONS_SRC = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../../../../../packages/icons/src'
);

describe('built-in app marks', () => {
  // The webhook is a way to send messages, not a brand; it keeps its glyph.
  const branded = BUILT_IN_APPS.filter((app) => app.serviceSlug !== 'webhook');

  it.each(branded.map((app) => [app.serviceSlug]))(
    '%s ships its mark in @dorkos/icons, recorded in the sources README',
    (slug) => {
      const file = `${slug}.svg`;
      expect(existsSync(path.join(ICONS_SRC, 'app-logos', file))).toBe(true);
      expect(readFileSync(path.join(ICONS_SRC, 'app-logos.ts'), 'utf8')).toContain(
        `'./app-logos/${file}?url'`
      );
      expect(readFileSync(path.join(ICONS_SRC, 'app-logos', 'README.md'), 'utf8')).toContain(
        `\`${file}\``
      );
    }
  );
});
