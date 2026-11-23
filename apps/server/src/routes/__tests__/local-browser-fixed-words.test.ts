/**
 * The browser routes forward a `LocalBrowserError`'s words as a problem's
 * `detail`, so every one must be a fixed sentence from DorkOS's own code. A
 * refusal whose words are built from a template (a page's title, a site) must
 * be in `PAGE_WORDED_REFUSALS`, which answers a fixed sentence instead.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { PAGE_WORDED_REFUSALS } from '../local-browser.js';

const SERVER_SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

/** Every non-test `.ts` file under a folder. */
function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) return name === '__tests__' ? [] : sources(full);
    return name.endsWith('.ts') ? [full] : [];
  });
}

describe('browser refusals in a problem’s detail', () => {
  it('builds no refusal’s words from a template unless the route replaces them', () => {
    const construction = /new LocalBrowserError\(\s*'([a-z_]+)',\s*([^,)]+)/g;
    const templated = new Set<string>();
    for (const file of sources(SERVER_SRC)) {
      for (const match of readFileSync(file, 'utf8').matchAll(construction)) {
        const words = match[2]!;
        if (words.includes('`') || /\.message\b|String\(/.test(words)) templated.add(match[1]!);
      }
    }
    expect(templated.size).toBeGreaterThan(0);
    for (const reason of templated) expect(Object.keys(PAGE_WORDED_REFUSALS)).toContain(reason);
  });
});
