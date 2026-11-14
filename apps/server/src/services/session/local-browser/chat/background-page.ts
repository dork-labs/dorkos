import type { BrowserContext, Page } from 'playwright-core';

/** A waiting chat must not become the selected tab when its slot is assigned. */
export async function createBackgroundPage(context: BrowserContext, parent?: Page): Promise<Page> {
  const owner = parent
    ? await context.newCDPSession(parent)
    : await context.browser()?.newBrowserCDPSession();
  if (!owner) throw new Error('The browser closed before a background tab could open.');
  try {
    const targetInfo = parent ? (await owner.send('Target.getTargetInfo')).targetInfo : undefined;
    // Start listening before creating the target. Match only target identity, never page content.
    let identify!: (targetId: string) => void;
    let fail!: (reason: unknown) => void;
    const identity = new Promise<string>((resolve, reject) => {
      identify = resolve;
      fail = reject;
    });
    void identity.catch(() => undefined);
    const page = context.waitForEvent('page', {
      timeout: 15_000,
      predicate: async (candidate) => {
        const targetId = await identity;
        const session = await context.newCDPSession(candidate);
        try {
          return (await session.send('Target.getTargetInfo')).targetInfo.targetId === targetId;
        } finally {
          await session.detach();
        }
      },
    });
    void page.catch(() => undefined);
    let created: string | undefined;
    try {
      const { targetId } = await owner.send('Target.createTarget', {
        url: 'about:blank',
        background: true,
        ...(targetInfo?.browserContextId ? { browserContextId: targetInfo.browserContextId } : {}),
      });
      created = targetId;
      identify(targetId);
      return await page;
    } catch (error) {
      fail(error);
      if (created)
        await owner.send('Target.closeTarget', { targetId: created }).catch(() => undefined);
      await page.catch(() => undefined);
      throw error;
    }
  } finally {
    await owner.detach();
  }
}
