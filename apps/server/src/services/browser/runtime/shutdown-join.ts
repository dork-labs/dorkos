/** Start workspace and browser fences immediately, then join both before other shutdown duties.
 * Every original settles even after failure; the first observed rejection remains authoritative. */
export async function joinBrowserBeforeShutdown(
  browser: () => Promise<void> | undefined,
  remaining: () => Promise<void>,
  workspace?: () => Promise<unknown>
): Promise<void> {
  let first: Readonly<{ reason: unknown }> | undefined;
  const start = (original: () => Promise<unknown> | undefined): Promise<void> => {
    try {
      return Promise.resolve(original()).then(
        () => {},
        (reason) => {
          first ??= { reason };
        }
      );
    } catch (reason) {
      first ??= { reason };
      return Promise.resolve();
    }
  };
  // Calling the actual workspace owner first closes its admission synchronously.
  const workspaceOriginal = workspace ? start(workspace) : Promise.resolve();
  const browserOriginal = start(browser);
  await Promise.all([workspaceOriginal, browserOriginal]);
  try {
    await remaining();
  } catch (reason) {
    first ??= { reason };
  }
  if (first) throw first.reason;
}
