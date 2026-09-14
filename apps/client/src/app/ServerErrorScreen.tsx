import { BootBlockedScreen } from './BootBlockedScreen';

/**
 * The `code` this server's host guard sends with its 403.
 *
 * The literal, not an import: the constant is declared in
 * `apps/server/src/middleware/host-guard.ts`, which no client module may reach.
 * It is a wire contract either way — the code travels in the JSON body, and
 * `http-client.ts` hangs it on the thrown error — and the server's own
 * `host-guard.test.ts` pins the string from the other side.
 */
const HOST_NOT_ALLOWED_CODE = 'HOST_NOT_ALLOWED';

/**
 * The longest server-written line this screen will print.
 *
 * The refusal names a hostname it was handed, and a hostname can be 253
 * characters, so even our own message has no fixed length. A full-window wall
 * of text is not more honest than a clamped one, and the part that says what to
 * do comes first.
 */
const MAX_DETAIL_CHARS = 240;

interface ServerErrorScreenProps {
  /** The HTTP status the reply carried, as reported on the thrown error. */
  status: number;
  /** The reply's message, shown only when {@link ServerErrorScreenProps.code} vouches for it. */
  message?: string;
  /** The reply's `code` — the only evidence that this server, not a middlebox, refused. */
  code?: string;
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
export function ServerErrorScreen({ status, message, code }: ServerErrorScreenProps) {
  // **The one refusal whose own words beat anything this file could write.** The
  // host guard's 403 is not a fault to wait out — it is an address this instance
  // will not answer to, and its message names both the address and the two ways
  // out (`DORKOS_TRUSTED_HOSTS`, or turn login on). Without it the screen offers
  // a Try again that can never work and a number that leads nowhere.
  //
  // **The gate is the CODE, never the status.** A proxy, a captive portal or a
  // CDN can answer 403 with any body it likes, and keying on the number alone
  // would print a stranger's text full-screen inside DorkOS chrome — inert, but
  // a page that looks like it is speaking for the product. Only this server
  // sets `HOST_NOT_ALLOWED`. Raw error text stays off every other failure for
  // the reasons the frame gives, and even this one is clamped.
  const refusal = code === HOST_NOT_ALLOWED_CODE && message ? message : undefined;
  const detail =
    refusal === undefined
      ? `DorkOS asked for your settings and got an error back (HTTP ${status}). It keeps trying, and this screen clears as soon as your settings load.`
      : refusal.length > MAX_DETAIL_CHARS
        ? `${refusal.slice(0, MAX_DETAIL_CHARS).trimEnd()}…`
        : refusal;

  return (
    <BootBlockedScreen
      testId="server-error"
      headline="The server answered with an error"
      detail={detail}
    />
  );
}
