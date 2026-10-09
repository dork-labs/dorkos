import { test as original, expect } from './managed-browser-receiver';
import { retainOriginalCopyPermissionRefusal } from '../helpers/original-copy-permission.fixture';

/** Disposable authenticated frontend policy only; no OS permission or clipboard access. */
export const test = original.extend<{
  copyPermissionRefusal: Awaited<ReturnType<typeof retainOriginalCopyPermissionRefusal>>;
}>({
  copyPermissionRefusal: async ({ page }, use) => {
    const owner = await retainOriginalCopyPermissionRefusal(page);
    let first: { value: unknown } | undefined;
    try {
      await use(owner);
    } catch (value) {
      first ??= { value };
    } finally {
      try {
        await owner.close();
      } catch (value) {
        first ??= { value };
      }
    }
    if (first) throw first.value;
  },
});
export { expect };
