import { expect, type Page, type Route } from '@playwright/test';

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
  const pattern = '**/browser';
  await route(pattern, handler);
  let closing: Promise<void> | undefined;
  return Object.freeze({
    /** Caller supplies the genuine qualified viewer; no selected text or OS content is read here. */
    async verify(recoverOriginalInput: () => Promise<void>) {
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
      const button = page.getByRole('button', { name: 'Copy selected text', exact: true });
      await expect(button).toBeVisible();
      await button.click();
      await expect(
        page.getByRole('status').filter({ hasText: 'Clipboard permission was denied.' })
      ).toHaveCount(1);
      await expect(page.getByRole('img', { name: 'Browser view', exact: true })).toHaveCount(1);
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
