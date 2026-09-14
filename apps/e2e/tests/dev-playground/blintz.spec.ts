import type { Locator, Page } from '@playwright/test';
import { test, expect } from '../../fixtures';

/** Resolve a host token to a real browser color, independent of the editor CSS. */
async function hostColor(page: Page, token: string): Promise<string> {
  return page.evaluate((name) => {
    const probe = document.createElement('span');
    probe.style.color = `hsl(var(--${name}))`;
    document.body.append(probe);
    const color = getComputedStyle(probe).color;
    probe.remove();
    return color;
  }, token);
}

async function expectDocumentColors(page: Page, reading: Locator): Promise<void> {
  const foreground = await hostColor(page, 'foreground');
  const background = await hostColor(page, 'background');
  const muted = await hostColor(page, 'muted');
  await expect
    .poll(() =>
      page
        .locator('#markdown-empty-document .crepe-placeholder')
        .evaluate((node) => getComputedStyle(node, '::before').color)
    )
    .toBe(await hostColor(page, 'muted-foreground'));
  await expect(reading.locator('.milkdown')).toHaveCSS('background-color', background);
  for (const selector of [
    '.ProseMirror',
    'h1',
    'h2',
    'h3',
    'h4',
    'h5',
    'h6',
    'strong',
    'em',
    'td',
    'th',
  ]) {
    await expect(reading.locator(selector).first(), selector).toHaveCSS('color', foreground);
  }
  await expect(reading.locator('p code').first()).toHaveCSS('color', foreground);
  await expect(reading.locator('p code').first()).toHaveCSS('background-color', muted);
  await expect(reading.locator('a').first()).toHaveCSS(
    'color',
    await hostColor(page, 'status-info-fg')
  );
  await expect(reading.locator('.milkdown-code-block').first()).toHaveCSS(
    'background-color',
    muted
  );
  await expect(reading.locator('.cm-content').first()).toHaveCSS('color', foreground);
  const keyword = reading
    .locator('.cm-line')
    .filter({ hasText: 'export function' })
    .locator('span')
    .filter({ hasText: /^export$/ });
  await expect(keyword).toHaveCSS('color', await hostColor(page, 'status-info-fg'));
  const contrast = await reading
    .locator('.cm-content')
    .first()
    .evaluate((code) => {
      const canvas = document.createElement('canvas');
      canvas.width = canvas.height = 1;
      const context = canvas.getContext('2d')!;
      const luminance = (color: string) => {
        context.fillStyle = color;
        context.fillRect(0, 0, 1, 1);
        const rgb = Array.from(context.getImageData(0, 0, 1, 1).data)
          .slice(0, 3)
          .map((channel) => {
            const value = channel / 255;
            return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
          });
        return rgb[0]! * 0.2126 + rgb[1]! * 0.7152 + rgb[2]! * 0.0722;
      };
      const background = luminance(
        getComputedStyle(code.closest('.milkdown-code-block')!).backgroundColor
      );
      return [...code.querySelectorAll('.cm-line span')].map((span) => {
        const foreground = luminance(getComputedStyle(span).color);
        return {
          text: span.textContent,
          ratio:
            (Math.max(background, foreground) + 0.05) / (Math.min(background, foreground) + 0.05),
        };
      });
    });
  expect(contrast.length).toBeGreaterThan(5);
  for (const token of contrast)
    expect(token.ratio, `code token ${token.text}`).toBeGreaterThanOrEqual(4.5);
}

test.describe('Dev Playground — Blintz canvas typography and themes @smoke', () => {
  let pageErrors: string[] = [];

  test.afterEach(() => {
    expect(
      pageErrors,
      'editor interactions must not throw or leave the document state disconnected'
    ).toEqual([]);
  });
  test.beforeEach(async ({ page }) => {
    pageErrors = [];
    page.on('pageerror', (error) => pageErrors.push(error.message));
    await page.setViewportSize({ width: 1440, height: 1000 });
    await page.goto('/dev/markdown');
    await expect(
      page.getByTestId('markdown-reading-surface').locator('.ProseMirror')
    ).toBeVisible();
  });

  test('the open document follows app and system themes without replacing its content', async ({
    page,
  }, testInfo) => {
    const reading = page.getByTestId('markdown-reading-surface');
    const editor = reading.locator('.ProseMirror');
    await editor.evaluate((node) => node.setAttribute('data-original-editor', 'true'));
    const text = await editor.innerText();
    for (const theme of ['light', 'dark', 'light'] as const) {
      await page.emulateMedia({ colorScheme: theme === 'light' ? 'dark' : 'light' });
      await page
        .getByRole('button', { name: `${theme === 'light' ? 'Light' : 'Dark'} theme`, exact: true })
        .click();
      await expectDocumentColors(page, reading);
      await expectDocumentColors(page, page.getByTestId('markdown-canvas-surface'));
      await expect(editor).toHaveAttribute('data-original-editor', 'true');
      expect(await editor.innerText()).toBe(text);
      for (const [part, selector] of [
        ['typography', 'h1'],
        ['code', '.milkdown-code-block'],
      ] as const) {
        await reading.locator(selector).first().scrollIntoViewIfNeeded();
        await testInfo.attach(`markdown-${theme}-${part}`, {
          body: await page.screenshot(),
          contentType: 'image/png',
        });
      }
    }
    await page.getByRole('button', { name: 'System theme', exact: true }).click();
    for (const colorScheme of ['dark', 'light'] as const) {
      await page.emulateMedia({ colorScheme });
      await expect(page.locator('html')).toHaveClass(
        colorScheme === 'dark' ? /dark/ : /^(?!.*\bdark\b)/
      );
      await expectDocumentColors(page, reading);
      await expect(editor).toHaveAttribute('data-original-editor', 'true');
    }
  });

  test('lists have one aligned marker, correct nesting, and deliberate paragraph rhythm', async ({
    page,
  }) => {
    const reading = page.getByTestId('markdown-reading-surface');
    const list = reading.locator('.ProseMirror > ul').first();
    await expect(list.locator(':scope > li')).toHaveCount(3);
    await expect(list.locator(':scope > div')).toHaveCount(0);
    const item = list.locator(':scope > li').first();
    await expect(item).toHaveCSS('list-style-type', 'none');
    await expect(item.locator('.label-wrapper')).toHaveCount(1);
    const label = await item.locator('.label-wrapper').boundingBox();
    const paragraph = await item.locator('p').boundingBox();
    expect(label).not.toBeNull();
    expect(paragraph).not.toBeNull();
    expect(Math.abs(label!.y - paragraph!.y)).toBeLessThanOrEqual(4);
    expect(paragraph!.x).toBeGreaterThan(label!.x);
    const nested = list.locator('ul').first();
    expect((await nested.boundingBox())!.x).toBeGreaterThan((await list.boundingBox())!.x);
    const ordered = reading.locator('.ProseMirror > ol');
    await expect(ordered).toHaveAttribute('start', '3');
    await expect(ordered.locator('.label').first()).toHaveText('3.');
    const heading = await reading.locator('h2').first().boundingBox();
    expect((await list.boundingBox())!.y - (heading!.y + heading!.height)).toBeGreaterThanOrEqual(
      8
    );
    const loose = reading
      .locator('.ProseMirror > ul')
      .filter({ hasText: 'A list item can have two paragraphs.' });
    const paragraphs = loose.locator(':scope > li').first().locator('p');
    const first = await paragraphs.nth(0).boundingBox();
    const second = await paragraphs.nth(1).boundingBox();
    expect(second!.y - (first!.y + first!.height)).toBeGreaterThanOrEqual(8);
  });

  test('narrow documents keep overflow within code and tables', async ({ page }, testInfo) => {
    const narrow = page.getByTestId('markdown-narrow-surface');
    for (const width of [360, 280]) {
      await narrow.evaluate((node, size) => {
        node.style.width = `${size}px`;
      }, width);
      await narrow.scrollIntoViewIfNeeded();
      const dimensions = await narrow.evaluate((node) => ({
        width: node.clientWidth,
        scroll: node.scrollWidth,
      }));
      expect(dimensions.scroll).toBeLessThanOrEqual(dimensions.width + 1);
      await expect(narrow.locator('.cm-scroller')).toHaveCSS('overflow-x', 'auto');
      for (const selector of ['.table-wrapper', '.cm-scroller']) {
        const scroller = narrow.locator(selector);
        const overflow = await scroller.evaluate((node) => ({
          width: node.clientWidth,
          scroll: node.scrollWidth,
        }));
        expect(overflow.scroll, selector).toBeGreaterThan(overflow.width);
        await scroller.evaluate((node) => {
          node.scrollLeft = 80;
        });
        await expect.poll(() => scroller.evaluate((node) => node.scrollLeft)).toBeGreaterThan(0);
      }
      await testInfo.attach(`markdown-narrow-${width}`, {
        body: await page.screenshot(),
        contentType: 'image/png',
      });
    }
  });

  test('the formatting toolbar stays readable and applies a mark in the live draft', async ({
    page,
  }) => {
    const surface = page.getByTestId('markdown-editing-surface');
    const paragraph = surface.locator('.ProseMirror p').first();
    for (const theme of ['Light', 'Dark']) {
      await page.getByRole('button', { name: `${theme} theme`, exact: true }).click();
      await paragraph.scrollIntoViewIfNeeded();
      await paragraph.evaluate((node) => {
        const range = document.createRange();
        range.setStart(node.firstChild!, 0);
        range.setEnd(node.firstChild!, 6);
        const selection = window.getSelection()!;
        selection.removeAllRanges();
        selection.addRange(range);
        (node.closest('.ProseMirror') as HTMLElement).focus();
        document.dispatchEvent(new Event('selectionchange'));
      });
      const italic = surface.getByRole('button', { name: 'Italic', exact: true });
      await expect(italic).toBeVisible();
      await expect(italic.locator('svg')).toHaveCSS(
        'color',
        await hostColor(page, 'muted-foreground')
      );
    }
    await surface.getByRole('button', { name: 'Bold', exact: true }).click();
    await expect(paragraph.locator('strong')).toHaveText('Select');
    await expect(page.getByTestId('markdown-source')).toContainText('**Select**');
  });

  test('local images and editable captions follow the host theme and preserve their text', async ({
    page,
  }) => {
    const reading = page.getByTestId('markdown-reading-surface');
    const editing = page.getByTestId('markdown-editing-surface');
    for (const theme of ['Light', 'Dark']) {
      await page.getByRole('button', { name: `${theme} theme`, exact: true }).click();
      const image = reading.getByRole('img', { name: 'A quiet landscape, with room to think.' });
      await expect(image).toBeVisible();
      await expect
        .poll(() => image.evaluate((node) => (node as HTMLImageElement).naturalWidth))
        .toBe(960);
      await expect(reading.locator('.caption-input')).toHaveText(
        'A quiet landscape, with room to think.'
      );
      await expect(reading.locator('.caption-input')).toHaveCSS(
        'color',
        await hostColor(page, 'foreground')
      );
      await expect(editing.getByRole('textbox', { name: 'Image caption', exact: true })).toHaveCSS(
        'color',
        await hostColor(page, 'foreground')
      );
    }
    const caption = editing.getByRole('textbox', { name: 'Image caption', exact: true });
    await caption.fill('A landscape worth keeping.');
    await caption.press('Tab');
    await expect(page.getByTestId('markdown-source')).toContainText('A landscape worth keeping.');
    await page.getByRole('button', { name: 'Read document', exact: true }).click();
    await expect(editing.locator('.caption-input')).toHaveText('A landscape worth keeping.');
    await expect(editing.getByRole('textbox', { name: 'Image caption', exact: true })).toHaveCount(
      0
    );
    await page.getByRole('button', { name: 'Edit document', exact: true }).click();
    await expect(editing.getByRole('textbox', { name: 'Image caption', exact: true })).toHaveValue(
      'A landscape worth keeping.'
    );
  });

  test('editing keeps its selection and undo history through a complete theme cycle', async ({
    page,
  }) => {
    const editor = page.getByTestId('markdown-editing-surface').locator('.ProseMirror');
    const paragraph = editor.locator('p').first();
    const originalText = await editor.innerText();
    await editor.evaluate((node) => node.setAttribute('data-original-editor', 'true'));
    await paragraph.click();
    await paragraph.evaluate((node) => {
      const range = document.createRange();
      range.selectNodeContents(node);
      range.collapse(false);
      const selection = window.getSelection()!;
      selection.removeAllRanges();
      selection.addRange(range);
    });
    const addition = ' A thought worth keeping.';
    await page.keyboard.type(addition);
    await expect(page.getByTestId('markdown-source')).toContainText(addition);
    for (let index = 0; index < addition.length; index++) {
      await page.keyboard.press('Shift+ArrowLeft');
    }
    await expect.poll(() => page.evaluate(() => window.getSelection()?.toString())).toBe(addition);

    for (const theme of ['Light', 'Dark', 'Light']) {
      await page.getByRole('button', { name: `${theme} theme`, exact: true }).click();
      await expect(editor).toHaveAttribute('data-original-editor', 'true');
      await expect(editor).toHaveAttribute('contenteditable', 'true');
      await expect(paragraph).toContainText(addition);
      // Theme controls legitimately take focus. Return it without clicking a
      // new caret position, so the retained editor selection is what we check.
      await editor.focus();
      await expect
        .poll(() => page.evaluate(() => window.getSelection()?.toString()))
        .toBe(addition);
    }

    await page.keyboard.press('ControlOrMeta+z');
    await expect.poll(() => editor.innerText()).toBe(originalText);
    await expect(page.getByTestId('markdown-source')).not.toContainText(addition);
  });

  test('a draft survives mode and theme changes and produces markdown', async ({ page }) => {
    const surface = page.getByTestId('markdown-editing-surface');
    const editor = surface.locator('.ProseMirror');
    await editor.click();
    await page.keyboard.press('ControlOrMeta+End');
    await page.keyboard.press('Enter');
    await page.keyboard.type('A thought worth keeping');
    await expect(page.getByTestId('markdown-source')).toContainText('A thought worth keeping');
    await page.getByRole('button', { name: 'Read document', exact: true }).click();
    await expect(editor).toHaveAttribute('contenteditable', 'false');
    await page.getByRole('button', { name: 'Dark theme', exact: true }).click();
    await expect(editor).toContainText('A thought worth keeping');
    await page.getByRole('button', { name: 'Edit document', exact: true }).click();
    await expect(editor).toHaveAttribute('contenteditable', 'true');
    await expect(editor).toContainText('A thought worth keeping');
  });
});
