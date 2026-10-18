/**
 * The keyboard half of the measure script: walks the first N tab stops and checks each one paints
 * the system focus ring.
 *
 * @module auditing-ui/measure/focus-walk
 */

/* global document, getComputedStyle, innerHeight, innerWidth -- this code runs in the page, not in Node */
import { join } from 'node:path';

// Focus walk: press Tab and read the focus indicator of each stop. A ring counts when an
// outline, a box-shadow layer, or a ::before/::after outline/shadow actually paints (Tailwind
// leaves transparent 0px shadow layers on everything, which are not a ring). A stop with none
// is flagged with a crop of the element, because a background change can still be a real (if
// weaker) indicator, and only the picture can say.
/**
 * Press Tab N times and flag every stop with no painted ring, or one that lands off screen.
 *
 * @param {import('playwright-core').Page} page - The page, already loaded.
 * @param {number} n - How many tab stops to walk.
 * @param {number} minRing - The ring width that counts, in px.
 * @param {boolean} isPhone - Whether this viewport is a phone.
 * @param {string | null} ignore - A selector whose descendants are skipped.
 * @param {string} shotDir - Where to save a crop of each flagged stop.
 * @param {string} prefix - The crop file name prefix.
 * @returns {Promise<object[]>} One flag per stop that fails.
 */
export async function focusWalkPage(page, n, minRing, isPhone, ignore, shotDir, prefix) {
  const res = [];
  for (let i = 0; i < n; i++) {
    await page.keyboard.press('Tab');
    await page.waitForTimeout(250); // rings usually transition in; read the settled state
    const f = await page.evaluate(
      ({ ignore }) => {
        const el = document.activeElement;
        if (!el || el === document.body) return null;
        if (ignore && el.closest(ignore)) return null;
        const painted = (cs) => {
          const ow =
            cs.outlineStyle !== 'none' && !/rgba\([^)]*,\s*0\)/.test(cs.outlineColor)
              ? parseFloat(cs.outlineWidth)
              : 0;
          let sw = 0;
          if (cs.boxShadow && cs.boxShadow !== 'none') {
            for (const layer of cs.boxShadow.split(/,(?![^(]*\))/)) {
              if (/rgba\([^)]*,\s*0\)/.test(layer)) continue; // transparent
              const nums = (
                layer
                  .replace(/rgba?\([^)]*\)|hsla?\([^)]*\)|oklch\([^)]*\)|color\([^)]*\)/g, '')
                  .match(/-?[\d.]+px/g) || []
              ).map(parseFloat);
              const spread = nums[3] || 0,
                blur = nums[2] || 0;
              sw = Math.max(sw, spread, blur / 2);
            }
          }
          return Math.max(ow, sw);
        };
        const cs = getComputedStyle(el);
        const w = Math.max(
          painted(cs),
          painted(getComputedStyle(el, '::after')),
          painted(getComputedStyle(el, '::before'))
        );
        const r = el.getBoundingClientRect();
        const name = (
          el.getAttribute('aria-label') ||
          el.textContent ||
          el.getAttribute('placeholder') ||
          ''
        )
          .replace(/\s+/g, ' ')
          .trim()
          .slice(0, 50);
        const offscreen = r.bottom < 0 || r.top > innerHeight || r.right < 0 || r.left > innerWidth;
        return {
          tag: el.tagName.toLowerCase(),
          name,
          w,
          uaRing: cs.outlineStyle === 'auto',
          offscreen,
          box: { x: r.left, y: r.top, width: r.width, height: r.height },
        };
      },
      { ignore }
    );
    if (!f || (f.w >= minRing && !f.offscreen)) continue;
    let crop;
    if (!f.offscreen && shotDir) {
      crop = `${prefix}-focus-${i + 1}.png`;
      const pad = 12;
      const clip = {
        x: Math.max(0, f.box.x - pad),
        y: Math.max(0, f.box.y - pad),
        width: f.box.width + pad * 2,
        height: f.box.height + pad * 2,
      };
      await page.screenshot({ path: join(shotDir, crop), clip }).catch(() => (crop = undefined));
    }
    res.push({ ...f, crop });
  }
  return res.map((f) => ({
    device: isPhone ? 'phone' : 'desktop',
    rule: '7.1',
    kind: f.offscreen ? 'focus-offscreen' : 'focus-ring',
    severity: f.offscreen ? 'Blocker' : 'Should',
    sel: f.tag,
    text: f.name,
    value: f.offscreen
      ? 'focused but off screen'
      : f.uaRing
        ? 'browser default ring, not the system ring'
        : `${f.w}px painted ring`,
    floor: `${minRing}px ring`,
    detail: f.crop ? `crop: ${f.crop}` : undefined,
  }));
}
