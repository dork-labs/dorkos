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
import { messageItem } from '../ui/message/message-variants';
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

  it('applies the line height after text-sm, and lets compact type keep its own', () => {
    const comfortable = messageItem({ density: 'comfortable' }).content();
    expect(comfortable).toContain('leading-[var(--msg-prose-line-height)]');
    // Dropped by tailwind-merge: 22px lines on 12px type would read as double-spaced.
    expect(messageItem({ density: 'compact' }).content()).not.toContain('leading-');
  });

  it('caps the words at the reading measure, and leaves the column whole for code', () => {
    expect(messageItem().content()).not.toContain('max-w-');
    const rule = indexCss.match(/\.msg-prose :is\(([^)]*)\) \{\s*max-width: ([^;]+);/);
    expect(rule?.[2]).toBe('var(--msg-content-max-width)');
    expect(rule?.[1]).toContain('p');
    expect(rule?.[1]).not.toMatch(/\b(pre|table|code)\b/);
  });

  it('washes a room row on hover and leaves a session row still', () => {
    expect(messageItem({ anchor: 'rail' }).root()).toContain('hover:bg-row-hover');
    expect(messageItem({ anchor: 'corner' }).root()).not.toContain('hover:');
  });

  it('never lets a long name squeeze the time', () => {
    const timestamp = messageItem().timestamp();
    expect(timestamp).toContain('shrink-0');
    expect(timestamp).toContain('whitespace-nowrap');
  });

  it("re-declares a phone's values for `.light`, which holds the desktop ones", () => {
    const phone = indexCss.match(/:root,\s*\.light \{\s*--msg-padding-x: ([^;]+);/);
    expect(phone?.[1]).toBe('1rem');
  });
});
