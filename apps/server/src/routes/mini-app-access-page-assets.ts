/**
 * The decide page's HTML, script and styles (DOR-3547). Plain strings, served
 * by DorkOS itself: no app bundle, no extension code, no framework. Its only
 * script is {@link MINI_APP_ACCESS_PAGE_SCRIPT}, a static file at its own path.
 *
 * The script holds Allow and Not now off until the page has been visible and
 * focused for a second, starts over whenever it isn't, and takes only a press
 * that began after that (Security M-B): a click an extension steers onto the
 * page, or a held Enter key, lands on a button that can't fire yet.
 *
 * @module routes/mini-app-access-page-assets
 */
import type { MiniAppAccessRequest } from '../services/connectors/extensions/mini-app-access.js';

/** Escape text for an HTML text node or a quoted attribute. */
function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

/** "linear" → "Linear": the service id as a name, when nothing better is known. */
function serviceName(service: string): string {
  return service.charAt(0).toUpperCase() + service.slice(1).replaceAll(/[-_]/gu, ' ');
}

/** The document shell every state of the page shares. */
function shell(title: string, body: string): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="light dark">
<title>${escapeHtml(title)} · DorkOS</title>
<link rel="stylesheet" href="page.css">
</head>
<body>
<main>
${body}
</main>
</body>
</html>`;
}

/** The page when nothing waits for this mini app and app. */
export function nothingWaitingPage(): string {
  return shell(
    'Nothing waiting',
    `<h1>Nothing is waiting here</h1>
<p class="quiet">It was already decided, or the mini app no longer asks.</p>
<p><a href="/connections">Back to Connections</a></p>`
  );
}

/**
 * The page asking a person to let one mini app read one app.
 *
 * @param request - The waiting read, read fresh from the server.
 * @param token - This page's one-time token, carried in the body.
 */
export function decidePage(request: MiniAppAccessRequest, token: string): string {
  const { waiting } = request;
  const app = escapeHtml(serviceName(waiting.service));
  const name = escapeHtml(waiting.extensionName);
  const origin = [
    request.author ? `Made by ${escapeHtml(request.author)}.` : '',
    request.source ? `From ${escapeHtml(request.source)}.` : '',
  ]
    .filter(Boolean)
    .join(' ');
  const operations = waiting.operations
    .map((operation) => `<li><code>${escapeHtml(operation)}</code></li>`)
    .join('');
  const accounts = request.accounts
    .map(
      (account, index) => `<label class="account">
<input type="radio" name="account" value="${escapeHtml(account.connectionId)}"${index === 0 ? ' checked' : ''}>
<span>${escapeHtml(account.label)}</span>
</label>`
    )
    .join('');
  const choose =
    request.accounts.length === 0
      ? `<p class="notice">Connect a ${app} account first, on the Connections page.</p>`
      : `<fieldset><legend>Account it reads</legend>${accounts}</fieldset>`;
  return shell(
    `Let ${waiting.extensionName} read ${serviceName(waiting.service)}?`,
    `<h1>Let ${name} read ${app}?</h1>
${origin ? `<p class="quiet" data-testid="mini-app-origin">${origin}</p>` : ''}
<p>It could only read. It never sees your password or sign-in.</p>
<section aria-labelledby="reads">
<h2 id="reads">What it could read</h2>
<ul class="operations">${operations}</ul>
</section>
<form id="decide" data-token="${escapeHtml(token)}">
${choose}
<p class="hint" id="hold" aria-live="polite">Buttons turn on in a moment.</p>
<div class="actions">
<button type="button" class="secondary" data-decision="deny" disabled>Not now</button>
<button type="button" class="primary" data-decision="approve" disabled${request.accounts.length === 0 ? ' data-no-account' : ''}>Allow</button>
</div>
<p id="result" role="status"></p>
</form>
<script src="page.js"></script>`
  );
}

/** The page's only script. Static: it reads the token from the page it is on. */
export const MINI_APP_ACCESS_PAGE_SCRIPT = `'use strict';
(function () {
  var form = document.getElementById('decide');
  if (!form) return;
  var token = form.getAttribute('data-token');
  var buttons = Array.prototype.slice.call(form.querySelectorAll('button[data-decision]'));
  var hold = document.getElementById('hold');
  var result = document.getElementById('result');
  var HOLD_MS = 1000;
  var enabledAt = Infinity;
  var timer = null;
  var pressStartedAt = -Infinity;
  var done = false;

  function attentive() {
    return document.visibilityState === 'visible' && document.hasFocus();
  }
  function disable() {
    clearTimeout(timer);
    enabledAt = Infinity;
    buttons.forEach(function (b) { b.disabled = true; });
    if (!done) hold.textContent = 'Buttons turn on in a moment.';
  }
  function arm() {
    disable();
    if (done || !attentive()) return;
    timer = setTimeout(function () {
      if (!attentive()) return;
      enabledAt = performance.now();
      buttons.forEach(function (b) { b.disabled = b.hasAttribute('data-no-account'); });
      hold.textContent = '';
    }, HOLD_MS);
  }
  document.addEventListener('visibilitychange', arm);
  window.addEventListener('focus', arm);
  window.addEventListener('blur', disable);

  buttons.forEach(function (button) {
    button.addEventListener('pointerdown', function () { pressStartedAt = performance.now(); });
    button.addEventListener('keydown', function (event) {
      if (event.key === 'Enter' || event.key === ' ') {
        if (event.repeat) { pressStartedAt = -Infinity; return; }
        pressStartedAt = performance.now();
      }
    });
    button.addEventListener('click', function (event) {
      if (!event.isTrusted || done) return;
      if (!(pressStartedAt >= enabledAt)) return;
      pressStartedAt = -Infinity;
      decide(button.getAttribute('data-decision'));
    });
  });

  function decide(decision) {
    done = true;
    disable();
    hold.textContent = '';
    var picked = form.querySelector('input[name="account"]:checked');
    fetch('decision', {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        token: token,
        decision: decision,
        connectionId: picked ? picked.value : undefined,
      }),
    })
      .then(function (response) {
        return response.json().then(function (body) { return { ok: response.ok, body: body }; });
      })
      .then(function (answer) {
        result.textContent = answer.ok
          ? answer.body.message
          : (answer.body && answer.body.error) || 'Nothing changed. Open the page again.';
        result.setAttribute('data-state', answer.ok ? 'done' : 'refused');
      })
      .catch(function () {
        result.textContent = 'Nothing changed. Open the page again.';
        result.setAttribute('data-state', 'refused');
      });
  }

  arm();
})();
`;

/** The page's styles: system fonts, light and dark, comfortable at 390px wide. */
export const MINI_APP_ACCESS_PAGE_STYLES = `:root {
  color-scheme: light dark;
  --bg: #fafafa; --fg: #171717; --muted: #525252; --line: #e5e5e5;
  --card: #ffffff; --primary: #171717; --primary-fg: #fafafa; --warn: #92400e;
}
@media (prefers-color-scheme: dark) {
  :root {
    --bg: #0a0a0a; --fg: #fafafa; --muted: #a3a3a3; --line: #262626;
    --card: #171717; --primary: #fafafa; --primary-fg: #171717; --warn: #fbbf24;
  }
}
* { box-sizing: border-box; }
body {
  margin: 0; background: var(--bg); color: var(--fg);
  font: 15px/1.5 ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif;
}
main {
  max-width: 34rem; margin: 3rem auto; padding: 1.5rem;
  background: var(--card); border: 1px solid var(--line); border-radius: 12px;
}
h1 { font-size: 1.25rem; margin: 0 0 .5rem; }
h2 { font-size: .8rem; text-transform: uppercase; letter-spacing: .04em; color: var(--muted); margin: 1.25rem 0 .5rem; }
p { margin: .5rem 0; }
.quiet, .hint { color: var(--muted); font-size: .875rem; }
.notice { color: var(--warn); }
.operations { margin: 0; padding-left: 1.1rem; }
.operations code { font: 12px/1.6 ui-monospace, SFMono-Regular, Menlo, monospace; word-break: break-all; }
fieldset { border: 0; padding: 0; margin: 1.25rem 0 0; }
legend { font-size: .8rem; text-transform: uppercase; letter-spacing: .04em; color: var(--muted); margin-bottom: .5rem; }
.account {
  display: flex; align-items: center; gap: .6rem; min-height: 44px;
  padding: .5rem .75rem; border: 1px solid var(--line); border-radius: 8px; margin-bottom: .5rem;
}
.actions { display: flex; gap: .75rem; justify-content: flex-end; margin-top: 1.25rem; flex-wrap: wrap; }
button {
  min-height: 44px; min-width: 7rem; padding: 0 1rem; border-radius: 8px;
  font: inherit; font-weight: 600; cursor: pointer; border: 1px solid var(--line);
  background: transparent; color: var(--fg);
}
button.primary { background: var(--primary); color: var(--primary-fg); border-color: var(--primary); }
button:disabled { opacity: .45; cursor: not-allowed; }
button:focus-visible, a:focus-visible, input:focus-visible { outline: 2px solid var(--fg); outline-offset: 2px; }
a { color: inherit; }
#result:empty { display: none; }
#result { margin-top: 1rem; padding: .75rem; border-radius: 8px; border: 1px solid var(--line); }
@media (max-width: 480px) {
  main { margin: 0; min-height: 100vh; border: 0; border-radius: 0; padding: 1.25rem; }
  .actions button { flex: 1 1 auto; }
}
`;
