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
import { PAGE_WORDED_REFUSALS, browserRefusalSentence } from '../local-browser.js';
import { LocalBrowserError } from '../../services/session/local-browser/service.js';

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

describe('the sentence a person reads for a browser refusal', () => {
  it.each([
    [
      'browser_download',
      'raw installer output',
      'Couldn’t download the browser. Check your connection and try again.',
    ],
    [
      'browser_storage',
      'Free some space, then open the browser again.',
      'Free some space, then open the browser again.',
    ],
    [
      'browser_storage',
      'Check folder permissions, then open the browser again.',
      'Check folder permissions, then open the browser again.',
    ],
    [
      'browser_storage',
      '/private/install/path: secret process output',
      'Couldn’t save the browser. Check free space and folder permissions.',
    ],
    ['cancelled', 'raw cancellation error', 'Browser setup stopped. Open it again to continue.'],
    [
      'busy',
      'The browser is still closing. Wait before opening it again.',
      'The browser is still closing. Wait, then try again.',
    ],
    ['busy', 'private busy details', 'Browser is busy. Wait a moment.'],
    [
      'busy',
      'Restart DorkOS to finish closing this browser.',
      'Restart DorkOS to finish closing this browser.',
    ],
    ['some_new_refusal', 'internal words', 'Couldn’t reach the browser. Try again.'],
  ])('words %s (%s) safely', (code, message, sentence) => {
    expect(browserRefusalSentence(new LocalBrowserError(code, message))).toBe(sentence);
  });
});
