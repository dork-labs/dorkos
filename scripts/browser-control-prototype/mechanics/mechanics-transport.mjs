import { delay } from './mechanics-helpers.mjs';
/** Delay both request and response legs; retain primary route failure and deliberately cancel teardown. */
export async function injectRtt(page, rttMs) {
  let closing = false,
    primaryError = null,
    closePromise;
  const active = new Set();
  async function dispatch(route) {
    try {
      if (
        !['/actions', '/frame', '/ack', '/state'].includes(new URL(route.request().url()).pathname)
      )
        return await route.continue();
      await delay(rttMs / 2);
      if (closing) return await route.abort();
      const response = await route.fetch({ timeout: 4000 });
      await delay(rttMs / 2);
      if (closing) return await route.abort();
      await route.fulfill({ response });
    } catch (error) {
      // Cancellation is intentional only after close starts. Other errors remain primary evidence.
      if (!closing) primaryError ??= error;
      try {
        await route.abort();
      } catch {
        if (!closing) primaryError ??= Error('RTT_ABORT_FAILED');
      }
    }
  }
  const handler = (route) => {
    const task = dispatch(route);
    active.add(task);
    return task.finally(() => active.delete(task));
  };
  await page.route('**/*', handler);
  return {
    activeCount: () => active.size,
    error: () => primaryError,
    close() {
      closePromise ??= (async () => {
        closing = true;
        const drained = page.unrouteAll({ behavior: 'wait' });
        let timer;
        let outcome;
        try {
          outcome = await Promise.race([
            drained.then(() => true),
            new Promise((resolve) => {
              timer = setTimeout(() => resolve(false), 2000);
            }),
          ]);
        } finally {
          clearTimeout(timer);
        }
        if (!outcome) {
          await page.close();
          await Promise.allSettled([...active]);
          await drained;
        }
        if (active.size) throw Error('RTT_HANDLERS_NOT_DRAINED');
      })();
      return closePromise;
    },
  };
}
