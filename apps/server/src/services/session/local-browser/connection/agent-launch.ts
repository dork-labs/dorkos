import type { BrowserContext, Page } from 'playwright-core';

/** Install launch-local page preparation before publishing the context. */
export async function prepareAgentLaunch(
  context: BrowserContext,
  admit: () => void,
  prepare?: (context: BrowserContext) => Promise<void>
): Promise<void> {
  admit();
  // This snapshot belongs to this physical launch, before any chat or theme probe.
  // The record stays in this closure; neither the pool nor a viewer can look it up.
  const initial = context.pages();
  let candidate: Page | undefined;
  if (initial.length === 1) {
    const page = initial[0]!;
    if (!page.isClosed() && page.url() === 'about:blank' && !(await page.opener())) {
      const current = context.pages();
      if (current.length === 1 && current[0] === page) candidate = page;
    }
  }
  await prepare?.(context);
  const newPage = context.newPage.bind(context);
  context.newPage = async () => {
    // Reserve once before awaiting: concurrent opens cannot consume the same record.
    const startup = candidate;
    candidate = undefined;
    context.newPage = newPage;
    const page = await newPage();
    try {
      admit();
      if (
        startup &&
        startup !== page &&
        startup.context() === context &&
        context.pages().includes(startup) &&
        !startup.isClosed() &&
        startup.url() === 'about:blank'
      ) {
        // No await between the custody/generation check and physical close dispatch.
        admit();
        await startup.close();
      }
      return page;
    } catch (error) {
      await page.close().catch(() => undefined);
      throw error;
    }
  };
}
