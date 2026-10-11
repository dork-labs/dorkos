/**
 * Every `--msg-*` variable the message row asks for must be defined.
 *
 * A Tailwind arbitrary value like `font-[var(--msg-x)]` compiles happily when
 * `--msg-x` exists nowhere, and the browser then falls back to the inherited
 * value without a word. That is how assistant replies lost their light weight
 * when `--msg-assistant-font-weight` was renamed in `index.css` but not here
 * (DOR-2130). Both files are read relative to this test file, so the check never
 * depends on which directory the test runner started in. `index.css` is read
 * off disk because Vitest skips CSS, so a `?raw` import of it comes back empty.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import variantsSource from '../ui/message/message-variants.ts?raw';

const indexCss = readFileSync(join(__dirname, '../../../../index.css'), 'utf-8');

describe('message-variants CSS variables', () => {
  it('uses only --msg-* variables that index.css defines', () => {
    const used = new Set([...variantsSource.matchAll(/var\((--msg-[\w-]+)\)/g)].map((m) => m[1]));
    const defined = new Set([...indexCss.matchAll(/^\s*(--msg-[\w-]+)\s*:/gm)].map((m) => m[1]));

    expect(used.size).toBeGreaterThan(0);
    expect([...used].filter((name) => !defined.has(name))).toEqual([]);
  });

  it('gives assistant prose the prose font weight', () => {
    expect(variantsSource).toContain('font-[var(--msg-prose-font-weight)]');
  });
});
