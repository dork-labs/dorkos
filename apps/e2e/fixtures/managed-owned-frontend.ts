import { chromium, type BrowserServer } from '@playwright/test';
import { chmod } from 'node:fs/promises';
import type { ChildProcess } from 'node:child_process';

/** Parent-owned original frontend. Caller supplies the SAME native birth observer used by
 * installed composition, retains every role and owns the final process qualification. */
export async function launchOwnedFrontend(
  observeOriginal: (original: ChildProcess) => Promise<void>
): Promise<{
  server: BrowserServer;
  original: ChildProcess;
  wsEndpoint: string;
  close: () => Promise<void>;
}> {
  const server = await chromium.launchServer({ headless: true });
  const original = server.process();
  if (!original) {
    await server.close();
    throw new Error('Original frontend child absent');
  }
  try {
    await observeOriginal(original);
  } catch (first) {
    await Promise.allSettled([server.close()]);
    throw first;
  }
  let closing: Promise<void> | undefined;
  return {
    server,
    original,
    wsEndpoint: server.wsEndpoint(),
    close() {
      closing ??= server.close();
      return closing;
    },
  };
}

/** Real owner sign-in populates original Playwright cookies; no cookie/claim fabrication. */
export async function createOriginalOwnerStorage(
  wsEndpoint: string,
  origin: string,
  credentials: Readonly<{ email: string; password: string }>,
  path: string
) {
  const browser = await chromium.connect(wsEndpoint);
  const closeBrowser = browser.close.bind(browser);
  let closeContext: (() => Promise<void>) | undefined;
  let first: { value: unknown } | undefined;
  try {
    const context = await browser.newContext({ baseURL: origin });
    closeContext = context.close.bind(context);
    const response = await context.request.post('/api/auth/sign-in/email', {
      data: { email: credentials.email, password: credentials.password },
    });
    if (response.status() !== 200) throw new Error('FRAME_ORIGINAL_OWNER_SIGN_IN_REFUSED');
    await context.storageState({ path });
    await chmod(path, 0o600);
    if (!(await context.cookies()).length) throw new Error('FRAME_ORIGINAL_OWNER_COOKIE_REQUIRED');
  } catch (value) {
    first = { value };
  } finally {
    await closeOriginalOwnerStorage(closeContext, closeBrowser, first);
  }
}

/** Context retirement finishes before its connected browser disconnect; both attempts remain owned. */
async function closeOriginalOwnerStorage(
  closeContext: (() => Promise<void>) | undefined,
  closeBrowser: () => Promise<void>,
  primary?: { value: unknown }
): Promise<void> {
  let first = primary;
  if (closeContext) {
    try {
      await closeContext();
    } catch (value) {
      first ??= { value };
    }
  }
  try {
    await closeBrowser();
  } catch (value) {
    first ??= { value };
  }
  if (first) throw first.value;
}
