import { existsSync, readdirSync, readFileSync } from 'node:fs';
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
      const file = ['svg', 'png']
        .map((extension) => `${slug}.${extension}`)
        .find((name) => existsSync(path.join(ICONS_SRC, 'app-logos', name)));
      expect(file, `no mark file for ${slug}`).toBeDefined();
      expect(readFileSync(path.join(ICONS_SRC, 'app-logos.ts'), 'utf8')).toContain(
        `'./app-logos/${file}?url'`
      );
      expect(readFileSync(path.join(ICONS_SRC, 'app-logos', 'README.md'), 'utf8')).toContain(
        `\`${file}\``
      );
    }
  );
});

describe('bundled mark files', () => {
  it('carry no script, event handler or outside reference', () => {
    const dir = path.join(ICONS_SRC, 'app-logos');
    for (const name of readdirSync(dir).filter((entry) => entry.endsWith('.svg'))) {
      const svg = readFileSync(path.join(dir, name), 'utf8');
      expect(svg, name).not.toMatch(/<script|\bon[a-z]+=|href="(?!#)|url\((?!#)/i);
    }
  });
});
