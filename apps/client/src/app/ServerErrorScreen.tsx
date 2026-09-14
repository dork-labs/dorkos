import { BootBlockedScreen } from './BootBlockedScreen';

interface ServerErrorScreenProps {
  /** The HTTP status the server replied with, as reported on the thrown error. */
  status: number;
}

/**
 * The whole window, when `GET /api/config` was answered and the answer was an
 * error.
 *
 * **The screen that used to be missing, which is why the other one lied.** The
 * shell had one failure state, so every rejection of the config read was shown
 * as "DorkOS can't reach its server. It may still be starting up." A 500 proves
 * the opposite: the server accepted the connection, ran, and replied. The
 * person who reported this (issue #1841) had a server answering 45 of 45 health
 * checks on a stable PID, and spent the evening on ports and server logs
 * looking for a process that was never down (DOR-2035).
 *
 * So this screen claims only what the status proves: something answered, and
 * what it answered with. The number is here because it is the one fact worth
 * repeating to whoever helps next, and it is short enough not to be noise. The
 * cause is not guessed at, and the retry loop is the same one the unreachable
 * screen runs, so a server that recovers hands the window back unaided.
 *
 * A `401 AUTH_REQUIRED` never reaches here: the transport flips the app-wide
 * auth signal on that exact reply, and `AuthGuard` — mounted above the router in
 * `main.tsx` — swaps the whole app for the login screen before this shell
 * renders again.
 */
export function ServerErrorScreen({ status }: ServerErrorScreenProps) {
  return (
    <BootBlockedScreen
      testId="server-error"
      headline="The server answered with an error"
      detail={`DorkOS is running, but it could not load your settings (HTTP ${status}). DorkOS keeps trying, and this screen clears as soon as they load.`}
    />
  );
}
