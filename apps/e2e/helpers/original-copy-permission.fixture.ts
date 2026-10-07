import { expect, type Page, type Route, type Response } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import {
  BrowserInputRequestSchema,
  BrowserReferenceSchema,
  BrowserCopySelectionReceiptSchema,
} from '@dorkos/shared/browser-schemas';

/** Install before the original outer app navigation, on a disposable frontend only.
 * This denies clipboard writes in the browser; it never reads the operator clipboard. */
export async function retainOriginalCopyPermissionRefusal(page: Page) {
  const route = page.route.bind(page),
    unroute = page.unroute.bind(page);
  const originals = new Set<Promise<void>>();
  let closed = false;
  let first: { value: unknown } | undefined;
  const requireOriginalFailureFree = () => {
    if (first) throw first.value;
  };
  const handler = (incoming: Route) => {
    const refused = closed || originals.size >= 16;
    const operation = Promise.resolve()
      .then(async () => {
        if (refused) throw new Error('COPY_PERMISSION_FIXTURE_UNAVAILABLE');
        const original = await incoming.fetch();
        if (closed) throw new Error('COPY_PERMISSION_FIXTURE_CLOSED');
        await incoming.fulfill({
          response: original,
          headers: { ...original.headers(), 'permissions-policy': 'clipboard-write=()' },
        });
      })
      .catch(async (value) => {
        const originalFailure = { value };
        try {
          await incoming.abort();
        } catch {
          /* Original handler failure retains precedence. */
        }
        throw originalFailure.value;
      });
    originals.add(operation);
    void operation
      .catch((value) => {
        first ??= { value };
      })
      .finally(() => originals.delete(operation));
    return operation;
  };
  const pattern = (url: URL) => url.pathname === '/browser';
  let originalInput:
    | { controllerId: string; command: ReturnType<typeof BrowserInputRequestSchema.parse> }
    | undefined;
  const observeInput = (response: Response) => {
    if (
      response.status() !== 200 ||
      response.request().method() !== 'POST' ||
      new URL(response.url()).pathname !== '/api/browser/input'
    )
      return;
    try {
      const body: unknown = response.request().postDataJSON();
      if (!body || typeof body !== 'object') throw new Error('COPY_ORIGINAL_INPUT_REQUIRED');
      const value = body as Record<string, unknown>;
      if (Object.keys(value).sort().join(',') !== 'command,controllerId')
        throw new Error('COPY_ORIGINAL_OWNER_INPUT_REQUIRED');
      originalInput = {
        controllerId: BrowserReferenceSchema.parse(value.controllerId),
        command: BrowserInputRequestSchema.parse(value.command),
      };
    } catch (value) {
      first ??= { value };
    }
  };
  page.on('response', observeInput);
  try {
    await route(pattern, handler);
  } catch (value) {
    first ??= { value };
    closed = true;
    page.off('response', observeInput);
    try {
      await unroute(pattern, handler);
    } catch {
      /* Original installation failure retains precedence. */
    }
    await Promise.allSettled([...originals]);
    throw first.value;
  }
  let closing: Promise<void> | undefined;
  return Object.freeze({
    /** Read only the fixture marker through the public owner API; never access the OS clipboard. */
    async verify(expectedText: string, recoverOriginalInput: () => Promise<void>) {
      const recover = recoverOriginalInput.bind(undefined);
      requireOriginalFailureFree();
      if (closed) throw new Error('COPY_PERMISSION_FIXTURE_CLOSED');
      const denied = await page.evaluate(() => {
        const policy = (
          document as Document & { featurePolicy?: { allowsFeature(name: string): boolean } }
        ).featurePolicy;
        return policy?.allowsFeature('clipboard-write') === false;
      });
      if (!denied) throw new Error('COPY_PERMISSION_REFUSAL_UNAVAILABLE');
      if (!originalInput || !expectedText || expectedText.length > 64)
        throw new Error('COPY_ORIGINAL_SELECTION_REQUIRED');
      const input = originalInput;
      const requestId = randomUUID();
      // A genuine authenticated preflight proves selection before the denied gesture can abort its own read.
      const selected = await page.request.post(
        new URL('/api/browser/copy-selection', page.url()).href,
        {
          headers: { Origin: new URL(page.url()).origin },
          data: {
            controllerId: input.controllerId,
            command: { requestId, binding: input.command.binding },
          },
          timeout: 10_000,
        }
      );
      expect(selected.status()).toBe(200);
      const receipt = BrowserCopySelectionReceiptSchema.parse(await selected.json());
      expect(receipt.requestId).toBe(requestId);
      expect(receipt.binding).toEqual(input.command.binding);
      expect(receipt.outcome).toBe('selected');
      if (receipt.outcome !== 'selected')
        throw new Error('COPY_ORIGINAL_NONEMPTY_SELECTION_REQUIRED');
      expect(receipt.text).toBe(expectedText);
      requireOriginalFailureFree();
      const button = page.getByRole('button', { name: 'Copy selected text', exact: true });
      await expect(button).toBeVisible();
      await button.click();
      await expect(
        page.getByRole('status').filter({ hasText: 'Clipboard permission was denied.' })
      ).toHaveCount(1);
      await expect(page.getByRole('img', { name: 'Shared browser', exact: true })).toHaveCount(1);
      await expect(button).toBeEnabled();
      // The surrounding original UI fixture supplies its actual typing/receiver assertion.
      await recover();
      requireOriginalFailureFree();
    },
    close() {
      if (closing) return closing;
      let resolve!: () => void, reject!: (value: unknown) => void;
      closing = new Promise<void>((yes, no) => {
        resolve = yes;
        reject = no;
      });
      void closing.catch(() => undefined);
      closed = true;
      void (async () => {
        let failure = first;
        try {
          page.off('response', observeInput);
        } catch (value) {
          failure ??= { value };
        }
        try {
          await unroute(pattern, handler);
        } catch (value) {
          failure ??= { value };
        }
        for (const result of await Promise.allSettled([...originals]))
          if (result.status === 'rejected') failure ??= { value: result.reason };
        if (failure) reject(failure.value);
        else resolve();
      })();
      return closing;
    },
  });
}
