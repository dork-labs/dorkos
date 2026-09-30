import type { Locator, Page } from '@playwright/test';

/** Contrast ratios for one control as it is painted right now, from its computed colours. */
export interface ControlContrast {
  /** Label text against the control's own painted fill. */
  text: number;
  /** The first icon against the same fill, when the control has one. */
  icon: number | null;
  /** Whether keyboard focus is on the control or on the input it wraps. */
  focusVisible: boolean;
  /** The 3px focus ring against the page right outside the control, when one is drawn. */
  ring: number | null;
}

/**
 * Wait until no CSS transition or animation is running. The shared controls fade their colours
 * over 150ms, so a theme switch sampled (or photographed) straight away catches them half-way —
 * which is how a dark screenshot once showed light buttons on a dark page (DOR-2567).
 */
export async function settle(page: Page): Promise<void> {
  // Bounded: an animation that never ends fails here in seconds instead of hanging the test.
  await page.waitForFunction(
    () => document.getAnimations().every((animation) => animation.playState !== 'running'),
    undefined,
    { timeout: 5_000 }
  );
}

/**
 * Measure a control's WCAG contrast ratios in the page. Every colour is resolved by the browser
 * (a canvas reads back `oklab`, `color-mix` and alpha alike) and translucent fills are composited
 * down through the ancestors onto an opaque base, so the ratios are the ones on screen.
 */
export function measureContrast(control: Locator): Promise<ControlContrast> {
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
    const fill = fillBehind(element);
    const outside = fillBehind(element.parentElement);
    const icon = element.querySelector('svg');
    // The ring is the box-shadow layer with a 3px spread; its colour is the text before it.
    const ringColor =
      /((?:rgba?|oklab|oklch|lab|lch|hsla?|color)\([^)]*\)|#[0-9a-f]+) 0px 0px 0px 3px/iu.exec(
        style.boxShadow
      )?.[1];
    const result = {
      text: ratio(over(rgba(style.color), fill), fill),
      icon: icon ? ratio(over(rgba(getComputedStyle(icon).color), fill), fill) : null,
      focusVisible: element.matches(':focus-visible, :has(:focus-visible)'),
      ring: ringColor ? ratio(over(rgba(ringColor), outside), outside) : null,
    };
    probe.remove();
    return result;
  });
}
