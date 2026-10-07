/** Join original session input/native cleanup before publishing registry retirement.
 * Session close fences admission synchronously. A failed original closure remains
 * refused; metadata is never a substitute for its native cleanup proof. */
export async function joinProductionBrowserClose(
  closeOriginal: () => Promise<void>,
  stopOriginal: () => void
): Promise<void> {
  await closeOriginal();
  stopOriginal();
}
