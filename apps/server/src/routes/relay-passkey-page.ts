/**
 * `GET /relay-passkey`: the page the approve page sends the browser back to
 * after it made an approvals passkey (spec `everything-is-a-space` B4c, plan
 * part 1, "Enrolment transport", RFC 8252 style). The enrol statement names
 * it as `returnTo`: `http://127.0.0.1:<port>/relay-passkey`, or `http://[::1]:<port>/…`
 * when `/start` arrived over IPv6. Never `localhost`: a name a hosts file or VPN can
 * point elsewhere, where the IP literal cannot (RFC 8252 §8.3).
 *
 * The approve page navigates here with everything in the fragment, which
 * never reaches any server's logs:
 *
 * - `#statement=<base64url statement>&attestation=<base64url of the UTF-8
 *   JSON of the WebAuthn registration response>` once a passkey was made
 *   (`PublicKeyCredential.toJSON()`, every binary field base64url);
 * - `#error=<reason>` when none was.
 *
 * Its own script (`GET /relay-passkey.js`, same origin, no inline script and
 * nothing from anywhere else) reads the fragment, clears it from the address
 * bar, posts the two to `POST /api/session-relay/passkeys/finish`, and shows
 * what happened. Served only to a request at this computer, only on a
 * computer (never a hub) and only while the experiment is on.
 *
 * @module routes/relay-passkey-page
 */
import { Hono, type Context } from 'hono';
import type { ApiEnv } from '../http/api-chain.js';
import { honoRequestFacts } from '../http/request-facts.js';
import { currentServerRole } from '../lib/server-role.js';
import { isAtThisComputer } from '../services/core/auth/gate-policy.js';
import { sessionRelayEnabled } from '../services/core/session-relay/index.js';
import { RELAY_PASSKEY_RETURN_PATH } from '../services/core/session-relay/passkeys/passkey-enrolment.js';

/** The page's own script, at a path beside it. */
export const RELAY_PASSKEY_SCRIPT_PATH = `${RELAY_PASSKEY_RETURN_PATH}.js`;

/**
 * Nothing loads but the page's own script, and it may only call back to this
 * server. No styles, frames, forms, images or base.
 */
export const RELAY_PASSKEY_CSP =
  "default-src 'none'; script-src 'self'; connect-src 'self'; base-uri 'none'; " +
  "form-action 'none'; frame-ancestors 'none'";

const PAGE = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>DorkOS passkey</title>
<script src="${RELAY_PASSKEY_SCRIPT_PATH}" defer></script>
</head>
<body>
<p id="out" role="status">Adding your passkey…</p>
</body>
</html>
`;

const SCRIPT = `'use strict';
(function () {
  var out = document.getElementById('out');
  function say(text) { out.textContent = text; }
  var params = new URLSearchParams(location.hash.slice(1));
  // Read once, then gone from the address bar and the history entry.
  history.replaceState(null, '', location.pathname);
  if (params.get('error') !== null) { say('No passkey was added. You can close this tab.'); return; }
  var statement = params.get('statement');
  var encoded = params.get('attestation');
  if (!statement || !encoded) { say('Nothing to add here. Start again in Settings.'); return; }
  var attestation;
  try {
    var b64 = encoded.replace(/-/g, '+').replace(/_/g, '/');
    while (b64.length % 4) b64 += '=';
    var binary = atob(b64);
    var bytes = new Uint8Array(binary.length);
    for (var i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
    attestation = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  } catch (e) {
    say('That passkey couldn\\u2019t be read. Start again in Settings.');
    return;
  }
  fetch('/api/session-relay/passkeys/finish', {
    method: 'POST',
    credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ statement: statement, attestation: attestation })
  }).then(function (res) {
    if (res.ok) { say('Passkey added. You can close this tab.'); return; }
    return res.json().then(function (body) {
      say(body && typeof body.error === 'string'
        ? body.error
        : 'The passkey wasn\\u2019t added. Start again in Settings.');
    }, function () { say('The passkey wasn\\u2019t added. Start again in Settings.'); });
  }, function () { say('Couldn\\u2019t reach DorkOS. Start again in Settings.'); });
})();
`;

/** Headers every answer here carries. */
function secure(c: Context<ApiEnv>): void {
  c.header('Content-Security-Policy', RELAY_PASSKEY_CSP);
  c.header('Referrer-Policy', 'no-referrer');
  c.header('Cache-Control', 'no-store');
  c.header('Cross-Origin-Opener-Policy', 'same-origin');
}

/** The refusal for anything but the owner's own browser on this computer, or `undefined`. */
function refuse(c: Context<ApiEnv>): Response | undefined {
  if (currentServerRole() === 'hub' || !sessionRelayEnabled()) {
    return c.text('Not found', 404);
  }
  if (!isAtThisComputer(honoRequestFacts(c))) {
    return c.text('Open this on the computer DorkOS runs on.', 403);
  }
  return undefined;
}

/**
 * Build the return page's two routes, mounted at the root.
 *
 * @returns The routes.
 */
export function createRelayPasskeyPageRoutes(): Hono<ApiEnv> {
  const router = new Hono<ApiEnv>();
  router.get(RELAY_PASSKEY_RETURN_PATH, (c) => {
    secure(c);
    return refuse(c) ?? c.html(PAGE);
  });
  router.get(RELAY_PASSKEY_SCRIPT_PATH, (c) => {
    secure(c);
    const refusal = refuse(c);
    if (refusal) return refusal;
    c.header('Content-Type', 'text/javascript; charset=utf-8');
    return c.body(SCRIPT);
  });
  return router;
}
