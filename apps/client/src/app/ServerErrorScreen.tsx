import { BootBlockedScreen } from './BootBlockedScreen';

interface ServerErrorScreenProps {
  /** The HTTP status the reply carried, as reported on the thrown error. */
  status: number;
  /** The error's message, shown only where it was written for a person to act on. */
  message?: string;
}

/**
 * The whole window, when the request for `GET /api/config` came back and what
 * came back was an error.
 *
 * **The screen that used to be missing, which is why the other one lied.** The
 * shell had one failure state, so every rejection of the config read was shown
 * as "DorkOS can't reach its server. It may still be starting up." A status is
 * proof that something on the other end replied, which the unreachable screen
 * says did not happen. The person who reported this (issue #1841) had a server
 * answering 45 of 45 health checks on a stable PID, and spent the evening on
 * ports and server logs looking for a process that was never down (DOR-2035).
 *
 * **What a status does NOT prove is that the reply came from DorkOS.** Remote
 * Access runs through an ngrok tunnel, and a tunnel edge whose origin is dead
 * answers 502 itself — on the phone that is a genuinely unreachable server
 * behind a perfectly healthy proxy. So the copy says only what was observed:
 * DorkOS asked, and an error came back with this number on it. Naming the
 * number is the point of the screen, because it is the one fact worth repeating
 * to whoever helps next, and 502 sends someone somewhere quite different from
 * 500.
 *
 * The retry loop is the same one the unreachable screen runs, so a server that
 * recovers hands the window back unaided.
 *
 * A `401 AUTH_REQUIRED` never reaches here: the transport flips the app-wide
 * auth signal on that exact reply, and `AuthGuard` — mounted above the router in
 * `main.tsx` — swaps the whole app for the login screen before this shell
 * renders again.
 */
export function ServerErrorScreen({ status, message }: ServerErrorScreenProps) {
  // **The one refusal whose own words beat anything this file could write.** A
  // 403 from the host guard is not a fault to wait out — it is an address this
  // instance will not answer to, and the server's message names both the
  // address and the two ways out (`DORKOS_TRUSTED_HOSTS`, or turn login on).
  // Without it the screen offers a Try again that can never work and a number
  // that leads nowhere. Raw error text stays off every other status for the
  // reasons the frame gives.
  const detail =
    status === 403 && message
      ? message
      : `DorkOS asked for your settings and got an error back (HTTP ${status}). It keeps trying, and this screen clears as soon as your settings load.`;

  return (
    <BootBlockedScreen
      testId="server-error"
      headline="The server answered with an error"
      detail={detail}
    />
  );
}
