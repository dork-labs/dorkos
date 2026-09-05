/**
 * Where "Restart Server" and "Reset All Data" go when the app is the desktop app.
 *
 * Both actions end the server process and count on something starting it again.
 * Over HTTP that something is the server itself, re-execing its own command line
 * — right for the CLI, impossible inside the desktop shell, where the executable
 * is the app rather than Node. So the server answers those two routes with a 409
 * whenever a supervisor owns it (DOR-532), and the shell offers its own pair of
 * calls that ask the supervisor instead (DOR-542).
 *
 * This module is the single place that choice is made, so no surface has to
 * carry its own "am I in the desktop app?" branch.
 *
 * @module shared/lib/desktop-admin
 */

/** The desktop shell's admin calls, once both are known to be there. */
export interface DesktopAdmin {
  /** Restart the server through the shell's supervisor. */
  restartServer(): Promise<DesktopAdminResult>;
  /** Delete the data directory and restart the server on an empty one. */
  resetAllData(): Promise<DesktopAdminResult>;
}

/**
 * The shell's admin bridge, or `null` when there isn't one.
 *
 * Feature-detects the **methods**, not the bridge object, and both together —
 * the rule every other `electronAPI` consumer here follows. A desktop build
 * older than DOR-542 exposes neither and correctly falls back to the HTTP route,
 * where it gets the server's 409 explaining what to do by hand; a hypothetical
 * build carrying only one of them would be a half-working danger zone, so it
 * falls back too.
 */
export function getDesktopAdmin(): DesktopAdmin | null {
  const api = typeof window !== 'undefined' ? window.electronAPI : undefined;
  if (typeof api?.restartServer !== 'function' || typeof api.resetAllData !== 'function') {
    return null;
  }
  const { restartServer, resetAllData } = api;
  return {
    restartServer: () => restartServer(),
    resetAllData: () => resetAllData(),
  };
}

/**
 * Read an admin result, turning a refusal into a throw so callers can keep one
 * `try`/`catch` across both the desktop and the HTTP paths.
 *
 * The message is the shell's own, written for a person, and is passed through
 * untouched — dressing it up here would be a second voice for the same failure.
 *
 * @param result - What the bridge answered.
 * @throws The shell's message, when the action did not happen.
 */
export function unwrapDesktopAdminResult(result: DesktopAdminResult): void {
  if (!result.ok) throw new Error(result.message);
}
