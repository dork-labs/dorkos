/**
 * The slim "Restarting DorkOS…" bar the desktop app shows while it restarts a
 * server that stopped on its own (DOR-3229).
 *
 * The main process decides when: it says nothing for the first two seconds,
 * so a quick restart shows no bar at all, and it clears the bar once the server
 * is back or restarting has given up. Text only, no spinner, fixed to the top
 * so it shows over whatever screen the app is on — including the one that says
 * the server cannot be reached. Renders nothing outside the desktop app.
 *
 * @module app/ServerRestartingBar
 */
import { useEffect, useState } from 'react';

/** Mounted once, at the app root. */
export function ServerRestartingBar() {
  const [restarting, setRestarting] = useState(false);

  useEffect(() => {
    if (!window.electronAPI?.onServerRestarting) return;
    return window.electronAPI.onServerRestarting(setRestarting);
  }, []);

  if (!restarting) return null;
  return (
    <div
      role="status"
      className="bg-muted text-muted-foreground fixed inset-x-0 top-0 z-[100] py-1 text-center text-xs"
    >
      Restarting DorkOS…
    </div>
  );
}
