import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { expect, test, type Locator, type Page } from '@playwright/test';

// Purpose (DOR-2609, UI overhaul Phase 2): every shared form control's keyboard focus ring is the
// one outline recipe (2px wide, 2px off) and at least 3:1 against the ground it sits on, in light
// and dark, measured as painted. A pointer click on a checkbox, a radio, a switch, a select or a
// slider thumb shows no ring; a text box shows one on a click too, which is the browser's own rule
// for text entry. The ring must also survive forced colours, which erase a box-shadow.
//
// DORKOS_CATALOG_FOCUS_SHOTS optionally names a directory for reviewable screenshots.

// eslint-disable-next-line no-restricted-syntax -- the catalog has no env.ts; a spec is not a config file, so it cannot lean on the repo-wide `**/*.config.ts` carve-out
const shots = process.env.DORKOS_CATALOG_FOCUS_SHOTS;

/** A ring as painted: its colour's contrast against the page and against the control's fill. */
interface RingMeasure {
  focusVisible: boolean;
  /** The ring colour as `r,g,b`, to tell the destructive ring from the normal one. */
  color: string | null;
  /** Ring width in px; null when no ring is drawn. */
  width: number | null;
  /** The gap between the control and the ring, in px; negative when inset. */
  offset: number | null;
  /** The ring against the ground it actually sits on, past the transparent gap. */
  page: number | null;
  /**
   * The ring against the control's own fill. Reported, not asserted: WCAG 1.4.11 asks the
   * indicator to stand out from what surrounds it, which is the ground, and a checked box or white
   * slider thumb in dark is lighter than the ring by design.
   */
  fill: number | null;
}

/**
 * Wait until no CSS transition or animation is running, bounded so a stuck one fails the test
 * instead of hanging it (the same rule as apps/space/browser-tests/contrast.ts).
 */
async function settle(page: Page) {
  await page.waitForFunction(
    () => document.getAnimations().every((animation) => animation.playState !== 'running'),
    undefined,
    { timeout: 5_000 }
  );
}

/**
 * Measure a control's focus ring from its computed colours. The canvas read-back and the
 * compositing are the ones apps/space/browser-tests/contrast.ts uses (DOR-2567); the ring itself
 * is the element's computed outline. An outline with no style or no width is no ring, and a
 * browser's own default (`auto`) is not the recipe either.
 */
function measureRing(control: Locator): Promise<RingMeasure> {
  return control.evaluate((element) => {
    const context = document.createElement('canvas').getContext('2d', {
      willReadFrequently: true,
    })!;
    const probe = document.createElement('span');
    document.body.append(probe);
    const rgba = (color: string): number[] => {
      probe.style.color = 'transparent';
      probe.style.color = color;
      context.clearRect(0, 0, 1, 1);
      context.fillStyle = getComputedStyle(probe).color;
      context.fillRect(0, 0, 1, 1);
      const [r, g, b, a] = context.getImageData(0, 0, 1, 1).data;
      return [r, g, b, a / 255];
    };
    const over = (top: number[], bottom: number[]) =>
      [0, 1, 2].map((i) => top[i] * top[3] + bottom[i] * (1 - top[3])).concat(1);
    const fillBehind = (node: Element | null) => {
      const chain: Element[] = [];
      for (let current = node; current; current = current.parentElement) chain.unshift(current);
      return chain.reduce(
        (below, current) => over(rgba(getComputedStyle(current).backgroundColor), below),
        [255, 255, 255, 1]
      );
    };
    const luminance = (color: number[]) => {
      const [r, g, b] = color.slice(0, 3).map((value) => {
        const channel = value / 255;
        return channel <= 0.03928 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
      });
      return 0.2126 * r + 0.7152 * g + 0.0722 * b;
    };
    const ratio = (a: number[], b: number[]) => {
      const [light, dark] = [luminance(a), luminance(b)].sort((x, y) => y - x);
      return Math.round(((light + 0.05) / (dark + 0.05)) * 100) / 100;
    };

    const style = getComputedStyle(element);
    const width = Number.parseFloat(style.outlineWidth);
    const drawn = style.outlineStyle === 'solid' && width > 0;
    const color = drawn ? rgba(style.outlineColor) : null;
    const ring = color && color[3] > 0 ? color : null;
    const offset = Number.parseFloat(style.outlineOffset);
    // Past a transparent gap the ring sits on the parent's ground; inset, on the element's own.
    const ground = fillBehind(offset < 0 ? element : element.parentElement);
    const fill = fillBehind(element);
    const result = {
      focusVisible: element.matches(':focus-visible'),
      color: ring ? ring.slice(0, 3).join(',') : null,
      width: ring ? width : null,
      offset: ring ? offset : null,
      page: ring ? ratio(over(ring, ground), ground) : null,
      fill: ring ? ratio(over(ring, fill), fill) : null,
    };
    probe.remove();
    return result;
  });
}

/** Give a control keyboard focus, so `:focus-visible` matches as it does for a Tab user. */
async function keyboardFocus(page: Page, target: Locator) {
  await target.focus();
  await page.keyboard.press('Tab');
  await page.keyboard.press('Shift+Tab');
  await expect(target).toBeFocused();
}

async function shot(page: Page, target: Locator, name: string) {
  if (!shots) return;
  await mkdir(shots, { recursive: true });
  const box = await target.boundingBox();
  if (!box) throw new Error(`${name} has no box to photograph`);
  const pad = 24;
  const x = Math.max(0, box.x - pad);
  const y = Math.max(0, box.y - pad);
  const viewport = page.viewportSize()!;
  await page.screenshot({
    path: join(shots, `${name}.png`),
    animations: 'disabled',
    clip: {
      x,
      y,
      width: Math.min(viewport.width - x, box.width + pad * 2),
      height: box.height + pad * 2,
    },
  });
}

function controls(page: Page): { name: string; control: Locator }[] {
  return [
    { name: 'input', control: page.locator('#catalog-long') },
    { name: 'input-invalid', control: page.getByRole('textbox', { name: 'Email address' }) },
    { name: 'textarea', control: page.getByPlaceholder('Write a message…') },
    { name: 'checkbox', control: page.locator('#demo-check-b') },
    { name: 'checkbox-checked', control: page.locator('#demo-check-a') },
    { name: 'radio', control: page.locator('#demo-radio-cc') },
    { name: 'switch', control: page.locator('#demo-switch-on') },
    { name: 'select', control: page.locator('#select [data-slot="select-trigger"]').first() },
    {
      name: 'slider',
      control: page
        .getByRole('region', { name: 'Slider', exact: true })
        .getByRole('slider')
        .first(),
    },
    {
      name: 'scroll-area',
      control: page.locator('#scroll-area [data-slot="scroll-area-viewport"]').first(),
    },
  ];
}

test.describe('keyboard focus rings', () => {
  for (const [width, height] of [
    [1280, 800],
    [390, 844],
  ] as const) {
    test(`clear 3:1 against the page in light and dark at ${width}px`, async ({ page }) => {
      await page.setViewportSize({ width, height });
      await page.emulateMedia({ reducedMotion: 'reduce' });
      await page.goto('/');
      await page.getByRole('textbox', { name: 'Email address' }).fill('not an address');
      const measured: Record<string, RingMeasure> = {};
      for (const scheme of ['light', 'dark'] as const) {
        await page.emulateMedia({ colorScheme: scheme, reducedMotion: 'reduce' });
        for (const { name, control } of controls(page)) {
          await control.scrollIntoViewIfNeeded();
          await page.mouse.move(0, 0);
          await keyboardFocus(page, control);
          await settle(page);
          const ring = await measureRing(control);
          measured[`${scheme} ${name}`] = ring;
          expect.soft(ring.focusVisible, `${scheme} ${name}: keyboard focus`).toBe(true);
          expect.soft(ring.width, `${scheme} ${name}: ring width`).toBe(2);
          expect
            .soft(ring.offset, `${scheme} ${name}: ring offset`)
            .toBe(name === 'scroll-area' ? -2 : 2);
          expect.soft(ring.page ?? 0, `${scheme} ${name}: ring vs page`).toBeGreaterThanOrEqual(3);
          await shot(page, control, `focus-${name}-${scheme}-${width}`);
          await control.blur();
        }
        // An invalid box must ring in the destructive colour, not the normal one: both clear 3:1,
        // so contrast alone would not catch the red being lost to the orange.
        expect
          .soft(
            measured[`${scheme} input-invalid`]?.color,
            `${scheme}: invalid ring is its own colour`
          )
          .not.toBe(measured[`${scheme} input`]?.color);
      }
      await test.info().attach(`focus-rings-${width}.json`, {
        body: JSON.stringify(measured, null, 2),
        contentType: 'application/json',
      });
      if (shots) console.log(`focus rings ${width}px: ${JSON.stringify(measured)}`);
    });
  }

  // A box-shadow ring disappeared here; an outline is repainted in a system colour and stays.
  test('survive forced colours', async ({ page }) => {
    await page.emulateMedia({ forcedColors: 'active', reducedMotion: 'reduce' });
    await page.goto('/');
    for (const { name, control } of controls(page)) {
      await control.scrollIntoViewIfNeeded();
      await page.mouse.move(0, 0);
      await keyboardFocus(page, control);
      await settle(page);
      const ring = await measureRing(control);
      expect.soft(ring.width, `${name}: ring in forced colours`).toBe(2);
      await control.blur();
    }
  });

  test('show no ring when a pointer picks a checkbox, a radio, a switch, a select or a slider thumb', async ({
    page,
  }) => {
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await page.goto('/');
    const slider = page
      .getByRole('region', { name: 'Slider', exact: true })
      .getByRole('slider')
      .first();
    for (const [name, control] of [
      ['checkbox', page.locator('#demo-check-b')],
      ['radio', page.locator('#demo-radio-codex')],
      ['switch', page.locator('#demo-switch-on')],
      ['select', page.locator('#select [data-slot="select-trigger"]').first()],
      ['slider', slider],
    ] as const) {
      await control.scrollIntoViewIfNeeded();
      if (name === 'select') {
        await control.click();
        // By pointer all the way: closing with Escape is keyboard use, and rightly shows the ring.
        await page.getByRole('option').first().click();
      } else if (name === 'slider') {
        const box = (await control.boundingBox())!;
        await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
        await page.mouse.down();
        await page.mouse.move(box.x + box.width / 2 + 30, box.y + box.height / 2);
        await page.mouse.up();
      } else {
        await control.click();
      }
      await expect(control, name).toBeFocused();
      // Off the control, so the slider's hover glow is not mistaken for a ring.
      await page.mouse.move(0, 0);
      await settle(page);
      const ring = await measureRing(control);
      expect.soft(ring.focusVisible, `${name}: pointer focus is not keyboard focus`).toBe(false);
      expect.soft(ring.width, `${name}: no ring after a pointer`).toBeNull();
    }
    // A text box is the browser's exception: a click puts the caret there, and it shows focus.
    const input = page.locator('#catalog-long');
    await input.click();
    expect((await measureRing(input)).focusVisible).toBe(true);
  });
});
