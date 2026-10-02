/** Invalidate displayed coordinates and any still-running dispatch from the previous input generation. */
export function clearManagedPointer(tab) {
  if (!tab) return;
  tab.pointer = null;
  tab.pointerGeneration = (tab.pointerGeneration ?? 0) + 1;
}

/** Return an immutable copy bound to the current canonical tab, navigation and viewport. */
export function snapshotManagedPointer(tab) {
  const pointer = tab.pointer;
  if (
    !pointer ||
    tab.closed ||
    pointer.navigationGeneration !== tab.navigationGeneration ||
    pointer.viewportVersion !== tab.viewportVersion
  )
    return null;
  return Object.freeze({ ...pointer });
}

/** Track only completed mouse moves/clicks; reset or identity changes fence late completions. */
export async function dispatchWithManagedPointer(tab, action, dispatch) {
  const tracked = ['mouseMove', 'click'].includes(action?.type);
  const generation = tab.pointerGeneration;
  const navigationGeneration = tab.navigationGeneration;
  const viewportVersion = tab.viewportVersion;
  try {
    const result = await dispatch();
    if (
      tracked &&
      !tab.closed &&
      generation === tab.pointerGeneration &&
      navigationGeneration === tab.navigationGeneration &&
      viewportVersion === tab.viewportVersion
    ) {
      clearManagedPointer(tab);
      tab.pointer = {
        tabId: tab.tabId,
        navigationGeneration,
        viewportVersion,
        x: action.x,
        y: action.y,
      };
    }
    return result;
  } catch (error) {
    if (tracked && generation === tab.pointerGeneration) clearManagedPointer(tab);
    throw error;
  }
}
