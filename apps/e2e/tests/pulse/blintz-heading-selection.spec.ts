import { expect, test } from '@playwright/test';

interface BlintzHeadingProbe {
  mount(text: string): void;
  snapshot(): unknown;
  selection(): unknown;
  bindSame(): unknown;
  nativeRangeRects(): Array<{ width: number; height: number }>;
  changeCount(): number;
  dispose(): unknown;
}

declare global {
  interface Window {
    __blintzHeadingProbe: BlintzHeadingProbe;
  }
}

for (const { text, end } of [
  { text: '# raw', end: 5 },
  { text: '# raw 😀', end: 8 },
]) {
  test(`maps genuine heading source selection and preserves focus for ${text}`, async ({
    page,
  }) => {
    const errors: string[] = [];
    page.on('pageerror', (error) => errors.push(error.message));
    await page.goto('/e2e-fixtures/blintz-heading.html');
    await page.waitForFunction(() => Boolean(window.__blintzHeadingProbe));
    await page.evaluate((value) => window.__blintzHeadingProbe.mount(value), text);
    await expect
      .poll(() => page.evaluate(() => window.__blintzHeadingProbe.snapshot()))
      .toMatchObject({
        kind: 'mapped',
        value: { text },
      });
    const editor = page.locator('.ProseMirror[contenteditable="true"]');
    await editor.click();
    await editor.press('ControlOrMeta+A');
    // The expected UTF-16 source coordinates come from the public port,
    // never inferred from DOM text positions or ProseMirror internals.
    await expect
      .poll(() => page.evaluate(() => window.__blintzHeadingProbe.selection()))
      .toMatchObject({
        kind: 'mapped',
        value: { ranges: [{ start: 2, end }] },
      });
    const bound = await page.evaluate(() => window.__blintzHeadingProbe.bindSame());
    expect(bound).toMatchObject({
      bound: { kind: 'mapped', value: { text } },
      selection: { kind: 'mapped', value: { ranges: [{ start: 2, end }] } },
      staleSelection: { kind: 'unavailable', reason: 'stale' },
      focusedBefore: true,
      focusedAfter: true,
      sameEditor: true,
      sameRenderedText: true,
    });
    // Real Chromium supplies layout here; no Range/DOM geometry shim is loaded.
    // This proves usable native rectangles, not virtual-caret pixel alignment.
    const rects = await page.evaluate(() => window.__blintzHeadingProbe.nativeRangeRects());
    expect(rects.some(({ width, height }) => width > 0 && height > 0)).toBe(true);
    expect(await page.evaluate(() => window.__blintzHeadingProbe.changeCount())).toBe(0);
    expect(await page.evaluate(() => window.__blintzHeadingProbe.dispose())).toMatchObject({
      kind: 'unavailable',
      reason: 'disposed',
    });
    expect(errors).toEqual([]);
  });
}
