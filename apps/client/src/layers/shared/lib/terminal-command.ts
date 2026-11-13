/**
 * The desktop app's Terminal command (`terminalCommand` in the desktop preload,
 * DOR-3105): `dorkos` in the person's own Terminal. Absent in a browser, which
 * can't write a file on this computer.
 *
 * @module shared/lib/terminal-command
 */

/** The row's state; see `DesktopTerminalCommandStatus`. */
export type TerminalCommandStatus = DesktopTerminalCommandStatus;

/** Reads, installs and removes the Terminal command. Each throws with a plain reason. */
export interface TerminalCommandBridge {
  status: () => Promise<TerminalCommandStatus>;
  install: () => Promise<TerminalCommandStatus>;
  remove: () => Promise<TerminalCommandStatus>;
}

function unwrap(call: () => Promise<DesktopTerminalCommandResult>) {
  return async (): Promise<TerminalCommandStatus> => {
    const result = await call();
    if (!result.ok) throw new Error(result.message);
    return result.status;
  };
}

/**
 * The Terminal command, or `null` outside the desktop app.
 *
 * @returns The bridge, or `null` when there is none.
 */
export function getTerminalCommandBridge(): TerminalCommandBridge | null {
  const api = typeof window !== 'undefined' ? window.electronAPI?.terminalCommand : undefined;
  if (!api || typeof api.status !== 'function') return null;
  return {
    status: unwrap(() => api.status()),
    install: unwrap(() => api.install()),
    remove: unwrap(() => api.remove()),
  };
}
