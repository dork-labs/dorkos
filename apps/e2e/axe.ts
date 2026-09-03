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
 * Run axe-core over one part of the page and hand back everything it found.
 *
 * @param page - The page under test.
 * @param context - A CSS selector for the subtree axe evaluates.
 * @param rules - Run only these rule ids. Omit to run axe's whole default set —
 *   which is what a page-wide sweep wants, and far more than a spec asking one
 *   question about one widget should pay for.
 */
export async function runAxe(page: Page, context: string, rules?: string[]): Promise<AxeResults> {
  await page.addScriptTag({ path: AXE_BUNDLE });
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
