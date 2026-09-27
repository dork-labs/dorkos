import { createRequire } from 'node:module';
import type { AxeResults, Result } from 'axe-core';
import type { Page } from '@playwright/test';

declare global {
  interface Window {
    /** Injected by {@link runAxe} via `addScriptTag`; absent until then. */
    axe: { run: (context: string, options: Record<string, unknown>) => Promise<AxeResults> };
  }
}

/**
 * axe-core's own bundle, resolved from this package's dependency rather than
 * fetched.
 *
 * `@axe-core/playwright` would be the usual choice; the bare engine is used
 * because it was already in the lockfile (`eslint-plugin-jsx-a11y` depends on
 * it) and injecting one script is the whole of what the wrapper does here.
 */
const AXE_BUNDLE = createRequire(import.meta.url).resolve('axe-core/axe.min.js');

/**
 * Wait for every running animation and transition to reach its end state
 * before a caller samples the page.
 *
 * A caller that just switched theme or colour scheme (`emulateMedia`) queues
 * a CSS transition the browser doesn't create synchronously with that call —
 * it starts on the next style/layout pass. Sampled too early, or sampled
 * before that transition finishes, axe reads a colour mid-fade rather than
 * its settled value: harmless alone, but the frame it lands on depends on
 * how loaded the machine is, which is exactly what made the switcher's
 * dark-mode contrast check read 1.08:1 only inside the full run (DOR-2450).
 * The reduced-motion CSS reset still leaves a real, non-zero
 * `transition-duration: 0.01ms`, so emulating `reducedMotion: 'reduce'`
 * narrows the window without closing it.
 *
 * Two animation frames give a transition queued by the caller's last action
 * a chance to actually start; `document.getAnimations()` then finds it and
 * every other one running, and this waits for each to finish. Animations
 * with no natural end — an infinite "still working" pulse — are left alone,
 * and a two-second cap guards against one that never reaches `finished` for
 * some other reason, so this can't hang a test.
 *
 * {@link runAxe} calls this itself, so a scan never needs it directly — call
 * it before a screenshot or any other sampling that isn't an axe scan
 * instead of writing another locator-scoped copy (`connections.spec.ts` used
 * to keep its own `settleFiniteAnimations(locator)`; this whole-page version
 * is a superset of a subtree-scoped wait, so callers pass `page`, not a
 * `Locator`).
 *
 * @param page - The page whose in-flight animations to wait out.
 */
export async function settleAnimations(page: Page): Promise<void> {
  await page.evaluate(
    () =>
      new Promise<void>((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(() => resolve()))
      )
  );
  await page.evaluate(async () => {
    const animations = document
      .getAnimations()
      .filter((animation) => animation.effect?.getTiming().iterations !== Infinity);
    await Promise.race([
      Promise.all(animations.map((animation) => animation.finished.catch(() => undefined))),
      new Promise((resolve) => setTimeout(resolve, 2_000)),
    ]);
  });
}

/**
 * Run axe-core over one part of the page and hand back everything it found.
 *
 * Settles every running animation and transition first (see
 * {@link settleAnimations}) so a scan taken right after a theme switch or an
 * entrance animation reads settled colours, not a frame mid-fade.
 *
 * @param page - The page under test.
 * @param context - A CSS selector for the subtree axe evaluates.
 * @param rules - Run only these rule ids. Omit to run axe's whole default set —
 *   which is what a page-wide sweep wants, and far more than a spec asking one
 *   question about one widget should pay for.
 */
export async function runAxe(page: Page, context: string, rules?: string[]): Promise<AxeResults> {
  await page.addScriptTag({ path: AXE_BUNDLE });
  await settleAnimations(page);
  return page.evaluate(
    async ([selector, ruleIds]) =>
      window.axe.run(
        selector as string,
        ruleIds === undefined ? {} : { runOnly: { type: 'rule', values: ruleIds } }
      ),
    [context, rules] as [string, string[] | undefined]
  );
}

/**
 * One violation, flattened into something an assertion failure can be read from.
 *
 * @param violation - The axe result to describe.
 */
export function describeViolation(violation: Result): string {
  return `${violation.id} (${violation.impact}): ${violation.nodes
    .map((node) => `${node.target.join(' ')} — ${node.failureSummary?.replace(/\s+/g, ' ')}`)
    .join(' | ')}`;
}
