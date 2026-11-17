/** The four out-of-turn requests exercised by the real-binary plugin row. */
interface ProjectCalls {
  createSession: () => Promise<unknown>;
  mcpStatus: () => Promise<unknown>;
  getConfig: () => Promise<unknown>;
  listProviders: () => Promise<unknown>;
}

/** Observe only after every request finishes; any rejection fails the row. */
export async function observeAfterProjectCalls(
  calls: ProjectCalls,
  observe: () => void
): Promise<void> {
  await calls.createSession();
  await calls.mcpStatus();
  await calls.getConfig();
  await calls.listProviders();
  observe();
}
