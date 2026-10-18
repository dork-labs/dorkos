// Visual companion server, v2.
//
// Serves the screens an agent writes into <session>/content as pages wrapped in
// the DorkOS frame, tells open pages to reload (WebSocket, with a polling
// fallback for proxies that drop upgrades), and records what the person does
// in the page to <session>/state/events as JSONL.
//
// Zero dependencies. Configuration is all environment:
//   BRAINSTORM_DIR       session directory (content/, state/, shots/)
//   BRAINSTORM_PORT      port (vc passes one; random if unset)
//   BRAINSTORM_HOST      bind host (127.0.0.1)
//   BRAINSTORM_URL_HOST  host printed in URLs (localhost)
//   BRAINSTORM_IDLE_MS   idle shutdown, ms (4h; 0 disables)
//   BRAINSTORM_THEME     default theme for screens with no ?theme= or meta (light)
//   BRAINSTORM_SHOTS     "0" disables auto-screenshots of new screens
//   BRAINSTORM_OWNER_PID exit when this process dies (legacy start-server.sh)

const crypto = require('crypto');
const http = require('http');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const VERSION = 2;

// ========== WebSocket Protocol (RFC 6455) ==========

const OPCODES = { TEXT: 0x01, CLOSE: 0x08, PING: 0x09, PONG: 0x0a };
const WS_MAGIC = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

function computeAcceptKey(clientKey) {
  return crypto
    .createHash('sha1')
    .update(clientKey + WS_MAGIC)
    .digest('base64');
}

function encodeFrame(opcode, payload) {
  const fin = 0x80;
  const len = payload.length;
  let header;

  if (len < 126) {
    header = Buffer.alloc(2);
    header[0] = fin | opcode;
    header[1] = len;
  } else if (len < 65536) {
    header = Buffer.alloc(4);
    header[0] = fin | opcode;
    header[1] = 126;
    header.writeUInt16BE(len, 2);
  } else {
    header = Buffer.alloc(10);
    header[0] = fin | opcode;
    header[1] = 127;
    header.writeBigUInt64BE(BigInt(len), 2);
  }

  return Buffer.concat([header, payload]);
}

function decodeFrame(buffer) {
  if (buffer.length < 2) return null;

  const secondByte = buffer[1];
  const opcode = buffer[0] & 0x0f;
  const masked = (secondByte & 0x80) !== 0;
  let payloadLen = secondByte & 0x7f;
  let offset = 2;

  if (!masked) throw new Error('Client frames must be masked');

  if (payloadLen === 126) {
    if (buffer.length < 4) return null;
    payloadLen = buffer.readUInt16BE(2);
    offset = 4;
  } else if (payloadLen === 127) {
    if (buffer.length < 10) return null;
    payloadLen = Number(buffer.readBigUInt64BE(2));
    offset = 10;
  }

  const maskOffset = offset;
  const dataOffset = offset + 4;
  const totalLen = dataOffset + payloadLen;
  if (buffer.length < totalLen) return null;

  const mask = buffer.slice(maskOffset, dataOffset);
  const data = Buffer.alloc(payloadLen);
  for (let i = 0; i < payloadLen; i++) {
    data[i] = buffer[dataOffset + i] ^ mask[i % 4];
  }

  return { opcode, payload: data, bytesConsumed: totalLen };
}

// ========== Configuration ==========

const PORT = Number(process.env.BRAINSTORM_PORT || 49152 + Math.floor(Math.random() * 16383));
const HOST = process.env.BRAINSTORM_HOST || '127.0.0.1';
const URL_HOST = process.env.BRAINSTORM_URL_HOST || (HOST === '127.0.0.1' ? 'localhost' : HOST);
const SESSION_DIR = process.env.BRAINSTORM_DIR || '/tmp/brainstorm';
const CONTENT_DIR = path.join(SESSION_DIR, 'content');
const STATE_DIR = path.join(SESSION_DIR, 'state');
const SHOTS_DIR = path.join(SESSION_DIR, 'shots');
const EVENTS_FILE = path.join(STATE_DIR, 'events');
const SESSION_ID = path.basename(SESSION_DIR);
const IDLE_TIMEOUT_MS =
  process.env.BRAINSTORM_IDLE_MS !== undefined
    ? Number(process.env.BRAINSTORM_IDLE_MS)
    : 4 * 60 * 60 * 1000;
const ENV_THEME = process.env.BRAINSTORM_THEME === 'dark' ? 'dark' : 'light';
// `vc theme dark` writes state/config.json; read fresh so it applies without a restart.
function defaultTheme() {
  try {
    const t = JSON.parse(fs.readFileSync(path.join(STATE_DIR, 'config.json'), 'utf-8')).theme;
    return t === 'dark' || t === 'light' ? t : ENV_THEME;
  } catch {
    return ENV_THEME;
  }
}
const SHOTS_ENABLED = process.env.BRAINSTORM_SHOTS !== '0';
let ownerPid = process.env.BRAINSTORM_OWNER_PID ? Number(process.env.BRAINSTORM_OWNER_PID) : null;

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.woff2': 'font/woff2',
};

// ========== Templates and Assets ==========

const ASSETS = path.join(__dirname, 'assets');
const read = (f) => fs.readFileSync(f, 'utf-8');
const frameTemplate = read(path.join(__dirname, 'frame-template.html'));
const frameCss = read(path.join(__dirname, 'frame.css'));
const helperScript = read(path.join(__dirname, 'helper.js'));
// The review layer (pins, notes, Send) and the director kit, read fresh on every
// request so a page always gets the version on disk.
const REVIEW_JS = path.join(__dirname, 'review.js');
const DIRECTOR_JS = path.join(__dirname, 'director.js');
const store = require('./review-store.cjs');
const { isLocalPage } = require('./crop.cjs');
// Exact source for fragments: every tag gets data-src="content/<screen>.html:line".
let stampHtml = null;
try {
  stampHtml = require('./stamp-src.cjs').stampHtml;
} catch {
  // Best effort: nothing to do if this fails.
}
const bootScript = read(path.join(__dirname, 'boot.js'));
const tokensCss = fs.existsSync(path.join(ASSETS, 'tokens.css'))
  ? read(path.join(ASSETS, 'tokens.css'))
  : '';
const APP_CSS_FILE = path.join(ASSETS, 'app.css');

// ========== Screens ==========

function isFullDocument(html) {
  const trimmed = html.trimStart().toLowerCase();
  return trimmed.startsWith('<!doctype') || trimmed.startsWith('<html');
}

// <meta name="vc-theme" content="dark"> and friends, anywhere in a screen.
function readMeta(html, name) {
  const re = new RegExp('<meta\\s+[^>]*name=["\']vc-' + name + '["\'][^>]*>', 'i');
  const tag = html.match(re);
  if (!tag) return null;
  const content = tag[0].match(/content=["']([^"']*)["']/i);
  return content ? content[1] : '';
}

function birth(stat) {
  // birthtime survives in-place rewrites, so editing a screen keeps its place in history.
  const b = stat.birthtimeMs;
  return b && b > 0 ? b : stat.mtimeMs;
}

function listScreens() {
  if (!fs.existsSync(CONTENT_DIR)) return [];
  return fs
    .readdirSync(CONTENT_DIR)
    .filter((f) => f.endsWith('.html') && !f.startsWith('.'))
    .map((f) => {
      const st = fs.statSync(path.join(CONTENT_DIR, f));
      return { name: f.replace(/\.html$/, ''), file: f, born: birth(st), mtime: st.mtimeMs };
    })
    .sort((a, b) => a.born - b.born || a.file.localeCompare(b.file));
}

function escapeHtml(s) {
  return String(s).replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]
  );
}

// <meta name="vc-title">, else the screen's first heading, else its filename.
function titleFor(name, raw) {
  const meta = readMeta(raw, 'title');
  if (meta) return meta;
  const hd = raw.match(/<h[12][^>]*>([\s\S]*?)<\/h[12]>/i);
  const text =
    hd &&
    hd[1]
      .replace(/<[^>]+>/g, '')
      .replace(/&amp;/g, '&')
      .replace(/\s+/g, ' ')
      .trim();
  if (text) return text.length > 60 ? text.slice(0, 59) + '…' : text;
  return name.replace(/[-_]+/g, ' ').replace(/^\w/, (c) => c.toUpperCase());
}

// What the jump list and auto-advance need: every screen's title, whether a
// Send went out from it, and whether it has a thumbnail.
function screenIndex(screens, events) {
  const sent = new Set(events.filter((e) => e.type === 'send').map((e) => e.screen));
  return screens.map((s) => ({
    name: s.name,
    title: titleFor(s.name, read(path.join(CONTENT_DIR, s.file))),
    sent: sent.has(s.name),
    shot: fs.existsSync(path.join(SHOTS_DIR, s.name + '.light.png')),
  }));
}

// A screen's saved picks (the last `select` event) and what was last sent from
// it, so navigating away and back restores the page as the person left it.
function savedFor(name, events) {
  let choices = null;
  let sent = null;
  let sentAt = null;
  let sentLabels = null;
  let sentMessage = null;
  for (const e of events) {
    if (e.screen !== name) continue;
    if (e.type === 'select' && Array.isArray(e.choices)) choices = e.choices;
    if (e.type === 'send') {
      const sel = Array.isArray(e.selection) ? e.selection : [];
      sent = sel.map((x) => x.choice);
      sentLabels = sel.map((x) => x.label || x.choice);
      sentAt = e.timestamp || null;
      sentMessage = e.message || null;
    }
  }
  return { choices, sent, sentAt, sentLabels, sentMessage };
}

function boot(screen, screens, raw) {
  const index = screen ? screens.findIndex((s) => s.name === screen.name) : -1;
  const events = readEvents();
  return {
    screens: screenIndex(screens, events),
    saved: screen ? savedFor(screen.name, events) : savedFor(null, []),
    v: VERSION,
    session: SESSION_ID,
    screen: screen ? screen.name : null,
    mtime: screen ? Math.round(screen.mtime) : null,
    title: screen ? titleFor(screen.name, raw) : 'Visual companion',
    index,
    total: screens.length,
    latest: screens.length ? screens[screens.length - 1].name : null,
    prev: index > 0 ? screens[index - 1].name : null,
    next: index >= 0 && index < screens.length - 1 ? screens[index + 1].name : null,
    version: stateVersion,
    theme: readMeta(raw, 'theme') || defaultTheme(),
    route: routeInfo(raw),
  };
}

const WAITING = `<div class="vc-empty"><p class="subtitle">Waiting for the first screen…</p></div>`;

function renderScreen(name, opts) {
  const screens = listScreens();
  let screen = name
    ? screens.find((s) => s.name === name || s.file === name)
    : screens[screens.length - 1];
  if (name && !screen) return null;
  const raw = screen ? read(path.join(CONTENT_DIR, screen.file)) : WAITING;
  // Stamped for the review layer; meta, titles and the original stay as written.
  let body = raw;
  if (screen && stampHtml && !opts.shot) {
    try {
      body = stampHtml(raw, 'content/' + screen.file);
    } catch {
      // Best effort: nothing to do if this fails.
    }
  }
  const data = boot(screen, screens, raw);
  if (opts.shot) data.shot = true;
  const useApp = readMeta(raw, 'css') === 'app' && fs.existsSync(APP_CSS_FILE);
  const bootTag =
    '<script>window.__VC__ = ' +
    JSON.stringify(data).replace(/</g, '\\u003c') +
    ';\n' +
    bootScript +
    '</script>';
  // An empty icon, so a full Chrome doesn't ask for /favicon.ico and log a 404.
  const head =
    '<link rel="icon" href="data:," />\n' +
    bootTag +
    '\n' +
    '<style>' +
    tokensCss +
    '\n</style>\n' +
    (useApp ? '<link rel="stylesheet" href="vc/app.css" />\n' : '') +
    '<style>' +
    frameCss +
    '\n</style>';
  const tail =
    '<script>\n' + helperScript + '\n</script>\n<script>\n' + read(REVIEW_JS) + '\n</script>';

  if (isFullDocument(raw)) {
    // Full documents keep control of the page; the frame adds only its chrome.
    let html = body;
    html = html.includes('</head>') ? html.replace('</head>', head + '\n</head>') : head + html;
    html = html.includes('</body>') ? html.replace('</body>', tail + '\n</body>') : html + tail;
    return html;
  }
  return frameTemplate
    .replace('<!-- HEAD -->', head)
    .replace('<!-- TITLE -->', escapeHtml(data.title))
    .replace('<!-- CONTENT -->', () => body)
    .replace('<!-- SCRIPTS -->', tail);
}

// ========== State version (what polling clients watch) ==========

let stateVersion = 1;
function bump() {
  stateVersion++;
}

function statePayload() {
  const screens = listScreens();
  return {
    v: VERSION,
    session: SESSION_ID,
    version: stateVersion,
    latest: screens.length ? screens[screens.length - 1].name : null,
    screens: screens.map((s) => ({ name: s.name, mtime: Math.round(s.mtime) })),
    clients: clients.size,
  };
}

// ========== Events ==========

// ========== Waking the agent ==========
//
// DorkOS can't take an event straight from a preview page yet (the canvas host
// never completes the doc-frame handshake; see FINDINGS-events.md). What does
// work is this server calling DorkOS's HTTP API from Node: no Origin header, so
// CORS doesn't apply, and loopback needs no credential by default.
//
// Only explicit intent wakes the agent, and only on screens that opt in with
// <meta name="vc-wake" content="on">:
//   - a "send" event (the Send button in the frame's send bar, or ⌘↵)
//   - a submitted pin note
// Exploration (toggling options, the slider, theme, history) stays in
// state/events. Pending intent is batched (800ms) into one call carrying the
// screen's full selection and every pin on it.
//
// The target is the chat that ran `vc show` (its session id, or --session),
// kept in state/route.json:
//   { mode: 'ui-action' | 'message' | 'off', session, dorkos, label }
//   ui-action: POST /api/sessions/:id/ui-action → a <ui_action> turn. Refused
//              (409) while the agent is mid-turn, so the batch waits and retries.
//   message:   POST /api/sessions/:id/messages with X-DorkOS-Agent (env
//              DORKOS_AGENT_TOKEN, never written to disk) → DorkOS queues it.
// At most 20 deliveries an hour; state/route.log records each attempt.
const ROUTE_FILE = path.join(STATE_DIR, 'route.json');
const ROUTE_LOG = path.join(STATE_DIR, 'route.log');

const SCREEN_ROUTES = path.join(STATE_DIR, 'screen-routes.json');
// Prototypes reviewed through the companion (`vc review open`): not files in
// content/, but screens all the same: a title, the chat to wake, and whether to.
const REVIEWS = path.join(STATE_DIR, 'reviews.json');
function reviewTarget(name) {
  try {
    return JSON.parse(read(REVIEWS))[String(name)] || null;
  } catch {
    return null;
  }
}

// The chat that showed a screen, if `vc show` recorded one.
function screenOwner(name) {
  if (!name) return null;
  try {
    return JSON.parse(read(SCREEN_ROUTES))[path.basename(String(name))] || null;
  } catch {
    return null;
  }
}

// With a screen, its own chat wins over the session-wide default.
function readRoute(screen) {
  let r = null;
  try {
    r = JSON.parse(read(ROUTE_FILE));
  } catch {
    // Best effort: nothing to do if this fails.
  }
  const session = screenOwner(screen) || (r && r.session) || process.env.VC_AGENT_SESSION;
  const mode = (r && r.mode) || 'ui-action';
  if (!session || (mode !== 'ui-action' && mode !== 'message')) return null;
  return {
    mode,
    session: String(session),
    dorkos: ((r && r.dorkos) || 'http://localhost:' + (process.env.DORKOS_PORT || 4242)).replace(
      /\/$/,
      ''
    ),
    label: (r && r.label) || process.env.VC_AGENT_LABEL || null,
  };
}

function screenFile(name) {
  if (!name) return null;
  const f = path.join(CONTENT_DIR, path.basename(String(name)) + '.html');
  return fs.existsSync(f) ? f : null;
}

// The screen decides, not the page: read its meta from disk (or its review entry).
function screenWakes(name) {
  const f = screenFile(name);
  if (f) return readMeta(read(f), 'wake') === 'on';
  const t = reviewTarget(name);
  return !!(t && t.wake);
}

function routeInfo(raw) {
  const r = readRoute();
  const wake = raw !== undefined ? readMeta(raw, 'wake') === 'on' : false;
  return r ? { mode: r.mode, label: r.label, wake } : { mode: 'none', label: null, wake: false };
}

function routeLog(entry) {
  try {
    fs.appendFileSync(ROUTE_LOG, JSON.stringify({ at: Date.now(), ...entry }) + '\n');
  } catch {
    // Best effort: nothing to do if this fails.
  }
}

const routeQueue = [];
let routeTimer = null;
let routeRetry = 3000;
const routeSent = [];

// ========== Delivery ==========
//
// Where each Send is, written to the events log so a reload (or another tab) reads
// the truth: queued (the companion holds it), delivering (written just before the
// POST, so a crash mid-request is visible), delivered (DorkOS took it, which starts
// the agent's turn), failed or unrouted (with why). Only state changes are written,
// never every retry.
const sendNotes = (e) =>
  e.review && Array.isArray(e.review.notes)
    ? e.review.notes.map((x) => x.n).filter((n) => n != null)
    : [];
function markDelivery(sends, state, reason) {
  for (const e of sends) {
    if (e.type !== 'send') continue;
    const key = state + '|' + (reason || '');
    if (e._delivery === key) continue;
    e._delivery = key;
    const d = {
      type: 'delivery',
      screen: e.screen,
      notes: sendNotes(e),
      message: !!e.message,
      state,
      reason: reason || undefined,
      send: e.timestamp,
      timestamp: Date.now(),
    };
    try {
      fs.appendFileSync(EVENTS_FILE, JSON.stringify(d) + '\n');
    } catch {
      // Best effort: nothing to do if this fails.
    }
    broadcast({ type: 'review', screen: e.screen });
  }
}
function lastDelivery(screen) {
  let last = null;
  for (const e of readEvents()) if (e.type === 'delivery' && e.screen === screen) last = e;
  return last;
}

// What the agent's chat is doing right now, read from DorkOS (cached briefly).
// DorkOS's SessionLifecycle enum, matched exactly: anything else reads as unknown.
const LIFECYCLES = new Set(['idle', 'streaming', 'blocked', 'error', 'interrupted']);
const lifeCache = new Map();
async function chatLifecycle(r) {
  if (!r || !r.session) return null;
  const k = r.dorkos + '|' + r.session;
  const c = lifeCache.get(k);
  if (c && Date.now() - c.at < 2000) return c.v;
  let v = null;
  try {
    const res = await fetch(r.dorkos + '/api/sessions/' + encodeURIComponent(r.session), {
      signal: AbortSignal.timeout(1500),
    });
    if (res.ok) {
      const got = (await res.json())?.status?.lifecycle;
      v = LIFECYCLES.has(got) ? got : null;
    }
  } catch {
    // Unreachable or not JSON: the lifecycle is unknown, and the page says "with".
  }
  lifeCache.set(k, { at: Date.now(), v });
  return v;
}
async function reviewStatus(screen) {
  const r = readRoute(screen);
  const routed = !!r && screenWakes(screen);
  const last = lastDelivery(screen);
  const open = pinsFor(screen).some(
    (p) => p.status === 'open' && p.delivery && p.delivery.state === 'delivered'
  );
  const lifecycle =
    routed && (open || (last && last.state === 'delivered')) ? await chatLifecycle(r) : null;
  return {
    routed,
    agent: (r && r.label) || null,
    mode: r ? r.mode : null,
    session: r ? r.session : null,
    chat: r ? r.dorkos + '/session?session=' + encodeURIComponent(r.session) : null,
    lifecycle,
    // streaming: on it. blocked: waiting on the person. idle, error, interrupted:
    // the turn is over. null: unknown (not delivered yet, or DorkOS didn't say).
    working: lifecycle ? lifecycle === 'streaming' : null,
    last: last
      ? {
          state: last.state,
          reason: last.reason || null,
          at: last.timestamp,
          notes: last.notes || [],
          message: !!last.message,
        }
      : null,
    queued: routeQueue.filter((e) => e.screen === screen && e.type === 'send').length,
  };
}

function enqueueRoute(event) {
  if (event.channel) return false; // already delivered over window.dorkos.channel
  if (event.type !== 'send' && event.type !== 'pin') return false;
  // A private note never wakes anyone, and pins posted as part of a Send ride on the send.
  if (event.type === 'pin' && (event.kind === 'note' || event.quiet)) return false;
  if (!screenWakes(event.screen) || !readRoute(event.screen)) return false;
  routeQueue.push(event);
  scheduleRoute(800);
  return true;
}

function scheduleRoute(ms) {
  if (routeTimer) return;
  routeTimer = setTimeout(() => {
    routeTimer = null;
    deliverRoute();
  }, ms);
  routeTimer.unref();
}

const clip = (s, n) => (typeof s === 'string' && s.length > n ? s.slice(0, n) + '…' : s);

function screenTitle(name) {
  const f = screenFile(name);
  if (f) return titleFor(name, read(f));
  const t = reviewTarget(name);
  return (t && t.title) || name;
}

// Each delivery spends a size budget (fitPayload, below) on what the person
// wrote, and a reply that fits is never cut.
// DorkOS refuses a ui-action whose serialized payload passes 8,192 characters
// (UI_ACTION_PAYLOAD_MAX_LENGTH), so that path stays under it with room for
// the envelope. A plain message has no length cap of its own, only the
// server's 1 MB request limit, so that path gets a budget no typed reply meets.
const PAYLOAD_BUDGET = { 'ui-action': 7500, message: 100000 };
// The summary line only quotes the reply; the screen carries it in full.
const SUMMARY_QUOTE = 140;

function buildPayload(batch) {
  const groups = new Map();
  for (const e of batch) {
    const k = e.screen || '';
    if (!groups.has(k))
      groups.set(k, { selection: [], newPins: [], trigger: 'pin', message: null, messageAt: null });
    const g = groups.get(k);
    if (Array.isArray(e.selection)) g.selection = e.selection;
    if (e.type === 'pin' && !e.quiet) g.newPins.push(e.n);
    if (e.type === 'send' && e.review && Array.isArray(e.review.notes))
      g.newPins.push(...e.review.notes.map((n) => n.n));
    if (e.type === 'send') g.trigger = 'send';
    // The whole reply; deliverRoute trims to DorkOS's budget, and only if it must.
    if (e.message) {
      g.message = e.message;
      g.messageAt = e.timestamp;
    }
  }
  const screens = [];
  const lines = [];
  for (const [name, g] of groups) {
    // Only open requests: private notes stay with the person, answered ones are done.
    const pins = pinsFor(name)
      .filter((p) => p.kind !== 'note' && p.status === 'open')
      .slice(-15)
      .map((p) => ({
        n: p.n,
        note: clip(p.note, 300),
        intent: p.intent,
        ref: clip(p.ref, 240),
        selector: p.selector,
        target: clip(p.target, 80),
        source: p.source,
        state: p.state,
        crop: p.crop,
        x: p.x,
        y: p.y,
      }));
    const selection = g.selection
      .slice(0, 20)
      .map((c) => ({ choice: c.choice, label: clip(c.label, 120) }));
    const title = screenTitle(name);
    screens.push({
      screen: name,
      title,
      trigger: g.trigger,
      selection,
      pins,
      new_pins: g.newPins,
      message: g.message,
      message_at: g.messageAt,
      url: '/?screen=' + encodeURIComponent(name),
    });
    const parts = [];
    if (selection.length)
      parts.push('chose ' + selection.map((c) => c.label || c.choice).join(', '));
    if (pins.length)
      parts.push(
        pins.length +
          (pins.length === 1 ? ' note' : ' notes') +
          (g.newPins.length ? ' (' + g.newPins.length + ' new)' : '')
      );
    // A short quote: the full text lives once, in screens[].message.
    if (g.message) parts.push('said "' + clip(g.message.replace(/\s+/g, ' '), SUMMARY_QUOTE) + '"');
    lines.push(title + ': ' + (parts.join('; ') || 'sent with nothing selected'));
  }
  return {
    summary: lines,
    screens,
    events_file: EVENTS_FILE,
    answer:
      'vc review resolve <screen>#<n> "what you did"  ·  vc review dismiss <screen>#<n> "why"',
  };
}

// Never clip a reply that fits. Over budget, trim what the agent can read back
// elsewhere first: pin metadata (`vc review list` has it), then the oldest pins,
// and only then the person's words, pointing at the events file for the rest.
function fitPayload(payload, budget) {
  const size = () => JSON.stringify(payload).length;
  for (const key of ['state', 'source', 'target', 'selector']) {
    if (size() <= budget) return payload;
    for (const x of payload.screens) for (const p of x.pins) delete p[key];
  }
  while (size() > budget && payload.screens.some((x) => x.pins.length > 1))
    for (const x of payload.screens) if (x.pins.length > 1) x.pins.shift();
  for (const x of payload.screens) {
    if (size() <= budget || !x.message) continue;
    // Mark it first, so the cut also pays for the marks (and the ellipsis).
    x.message_truncated = true;
    x.message_full_at = EVENTS_FILE + '#' + x.message_at;
    const over = size() - budget;
    const keep = Math.max(200, x.message.length - over - 1);
    x.message = x.message.slice(0, keep) + '…';
  }
  while (size() > budget && payload.screens.some((x) => x.pins.length))
    for (const x of payload.screens) x.pins.shift();
  return payload;
}

async function deliverRoute() {
  if (!routeQueue.length) return;
  // A Send's crops are part of what it carries: give them a few seconds to land.
  const pending = [...new Set(routeQueue.map((e) => e.screen))]
    .map((s) => cropJobs.get(s))
    .filter(Boolean);
  if (pending.length)
    await Promise.race([Promise.all(pending), new Promise((r) => setTimeout(r, 8000))]);
  const r = readRoute(routeQueue[0].screen);
  if (!r) {
    // Its chat is gone or routing is off: drop it and move on to the rest.
    markDelivery([routeQueue[0]], 'failed', 'no-chat');
    routeQueue.shift();
    return void scheduleRoute(0);
  }
  const now = Date.now();
  while (routeSent.length && now - routeSent[0] > 3600e3) routeSent.shift();
  if (routeSent.length >= 20) {
    routeLog({ status: 'rate-limited', pending: routeQueue.length });
    markDelivery(routeQueue, 'queued', 'rate');
    return scheduleRoute(60e3);
  }
  // One delivery per chat: take the queued events that belong to this one.
  const batch = routeQueue.filter((e) => readRoute(e.screen)?.session === r.session);
  const payload = fitPayload(buildPayload(batch), PAYLOAD_BUDGET[r.mode]);
  const headers = { 'Content-Type': 'application/json' };
  const names = payload.screens.map((x) => x.title).join(', ');
  let url, body;
  if (r.mode === 'ui-action') {
    url = r.dorkos + '/api/sessions/' + encodeURIComponent(r.session) + '/ui-action';
    headers['X-Client-Id'] = 'visual-companion-' + SESSION_ID;
    body = {
      actionId: 'visual-companion.' + (batch.some((e) => e.type === 'send') ? 'send' : 'pin'),
      widgetTitle: 'Visual companion · ' + names,
      payload,
    };
  } else {
    url = r.dorkos + '/api/sessions/' + encodeURIComponent(r.session) + '/messages';
    if (process.env.DORKOS_AGENT_TOKEN) headers['X-DorkOS-Agent'] = process.env.DORKOS_AGENT_TOKEN;
    body = {
      content:
        'From the visual companion:\n' +
        payload.summary.map((l) => '- ' + l).join('\n') +
        '\n\n<visual_companion>\n' +
        JSON.stringify(payload) +
        '\n</visual_companion>',
    };
  }
  let status;
  // On disk before the request leaves: if the server dies before `delivered` is
  // written, the restart sees `delivering` and never replays it blind.
  markDelivery(batch, 'delivering');
  try {
    const res = await fetch(url, { method: 'POST', headers, body: JSON.stringify(body) });
    status = res.status;
  } catch {
    status = -1;
  }
  if (status >= 200 && status < 300) {
    for (const e of batch) routeQueue.splice(routeQueue.indexOf(e), 1);
    routeSent.push(Date.now());
    routeRetry = 3000;
    routeLog({
      status: 'delivered',
      http: status,
      mode: r.mode,
      events: batch.length,
      summary: payload.summary,
    });
    markDelivery(batch, 'delivered');
    lifeCache.clear();
    if (routeQueue.length) scheduleRoute(1000);
  } else if (status === 409 || status === -1 || status >= 500) {
    // Busy (the agent is mid-turn) or DorkOS is unreachable: keep the batch and retry.
    routeLog({
      status: status === 409 ? 'busy' : 'unreachable',
      http: status,
      pending: routeQueue.length,
    });
    markDelivery(batch, 'queued', status === 409 ? 'busy' : 'unreachable');
    const wait = routeRetry;
    routeRetry = Math.min(routeRetry * 1.5, 30e3);
    if (Date.now() - batch[0].timestamp < 30 * 60e3) scheduleRoute(wait);
    else {
      routeLog({
        status: 'dropped',
        reason: 'undelivered for 30 minutes',
        events: routeQueue.length,
      });
      markDelivery(routeQueue, 'failed', 'timeout');
      routeQueue.splice(0);
    }
  } else {
    // 401/403: DorkOS login is on. The companion carries no credential, so it
    // can't wake anyone; the events stay in state/events for the agent to read.
    const loginOn = status === 401 || status === 403;
    routeLog({
      status: 'refused',
      http: status,
      events: batch.length,
      ...(loginOn ? { reason: 'DorkOS login is on; read vc events instead' } : {}),
    });
    markDelivery(batch, 'failed', loginOn ? 'login-on' : 'refused-' + status);
    for (const e of batch) routeQueue.splice(routeQueue.indexOf(e), 1);
  }
}

// A review link carries its token (`vt`), and pages report their own URL in
// notes and Sends. The token never goes into the log: GET vc/pins is readable by
// any loopback origin, and a token read there would let that page post.
function scrubToken(v, depth = 0) {
  if (typeof v === 'string') {
    if (!/[?&]vt=/.test(v)) return v;
    try {
      const u = new URL(v);
      u.searchParams.delete('vt');
      return u.href;
    } catch {
      return v.replace(/([?&])vt=[^&#\s]*&?/g, '$1');
    }
  }
  if (!v || typeof v !== 'object' || depth > 6) return v;
  if (Array.isArray(v)) return v.map((x) => scrubToken(x, depth + 1));
  const out = {};
  for (const [k, x] of Object.entries(v)) out[k] = scrubToken(x, depth + 1);
  return out;
}

function recordEvent(event) {
  const clean = scrubToken({ ...event });
  if (!clean.timestamp) clean.timestamp = Date.now();
  if (!clean.type) clean.type = 'event';
  fs.appendFileSync(EVENTS_FILE, JSON.stringify(clean) + '\n');
  console.log(JSON.stringify({ source: 'user-event', ...clean }));
  touchActivity();
  if (clean.type === 'send') cropNotes(clean.screen);
  clean.routed = enqueueRoute(clean);
  if (clean.type === 'send') {
    if (clean.channel) markDelivery([clean], 'delivered', 'channel');
    else if (clean.routed) markDelivery([clean], 'queued', 'sending');
    else markDelivery([clean], 'unrouted', !readRoute(clean.screen) ? 'no-chat' : 'no-wake');
  }
  // Other tabs on this screen (and the page itself, after an answer) re-read its notes.
  if (/^pin/.test(clean.type)) broadcast({ type: 'review', screen: clean.screen, n: clean.n });
  return clean;
}

function readEvents() {
  if (!fs.existsSync(EVENTS_FILE)) return [];
  return read(EVENTS_FILE)
    .split('\n')
    .filter(Boolean)
    .map((l) => {
      try {
        return JSON.parse(l);
      } catch {
        return null;
      }
    })
    .filter(Boolean);
}

// Notes still standing on a screen, with the agent's answers and crops merged in.
function pinsFor(screen) {
  return store.notes(readEvents(), screen, SHOTS_DIR);
}

// ========== Crops ==========
//
// At Send, each open request is replayed headless in the state it was made in
// (director.go) and its element cropped into shots/notes/<screen>-<n>.png. The
// crop travels to the agent by path. Delivery waits for it (up to 8s).
const cropJobs = new Map();
function cropNotes(screen) {
  if (!SHOTS_ENABLED || !screen) return;
  const own = screenFile(screen);
  const jobs = pinsFor(screen)
    .filter((p) => p.kind !== 'note' && p.status === 'open' && p.selector)
    .map((p) => ({
      url: own
        ? 'http://127.0.0.1:' +
          PORT +
          '/?shot&screen=' +
          encodeURIComponent(screen) +
          '&theme=' +
          (p.theme === 'dark' ? 'dark' : 'light')
        : p.page,
      frame: own ? undefined : p.frame,
      selector: p.selector,
      state: own ? null : p.state,
      viewport: p.viewport,
      out: store.cropPath(SHOTS_DIR, screen, p.n),
    }))
    .filter((j) => j.url && isLocalPage(j.url));
  if (!jobs.length) return;
  const file = path.join(STATE_DIR, '.crop-' + store.slug(screen) + '.json');
  fs.writeFileSync(file, JSON.stringify(jobs));
  const job = new Promise((resolve) => {
    const child = spawn(process.execPath, [path.join(__dirname, 'crop.cjs'), file], {
      stdio: 'ignore',
    });
    const kill = setTimeout(() => child.kill(), 30000);
    child.on('error', () => resolve());
    child.on('exit', () => {
      clearTimeout(kill);
      cropJobs.delete(screen);
      broadcast({ type: 'review', screen });
      resolve();
    });
  });
  cropJobs.set(screen, job);
}

// ========== HTTP ==========

// Prototypes served from another localhost port read their notes here (CORS for
// loopback origins). Writing is narrower: see crossOrigin() and tokenOk().
const LOCAL_ORIGIN = /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/;

// Whether a request comes from a page on another origin. Browsers say so in
// Sec-Fetch-Site; a page this server rendered says same-origin, even through
// DorkOS's preview proxy (which rewrites Host, so Origin and Host disagree there).
// Without the header, compare Origin with Host. No Origin at all is a local
// tool (vc, curl), not a page.
function crossOrigin(req) {
  const site = req.headers['sec-fetch-site'];
  if (site) return site !== 'same-origin' && site !== 'none';
  const origin = req.headers.origin;
  if (!origin) return false;
  try {
    return new URL(origin).host !== req.headers.host;
  } catch {
    return true;
  }
}

// A cross-origin write must carry the token `vc review open` minted for that
// review (the `vt` in its link). Without it any local page could post a Send
// that wakes the agent.
function tokenOk(screen, vt) {
  const t = reviewTarget(screen);
  if (!t || typeof t.token !== 'string' || typeof vt !== 'string') return false;
  const want = Buffer.from(t.token);
  const got = Buffer.from(vt);
  return want.length === got.length && crypto.timingSafeEqual(want, got);
}
function send(res, status, body, type) {
  res.writeHead(status, {
    'Content-Type': type || 'application/json',
    'Cache-Control': 'no-store',
    ...(res.corsOrigin ? { 'Access-Control-Allow-Origin': res.corsOrigin, Vary: 'Origin' } : {}),
  });
  res.end(typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body));
}

function readBody(req, cb) {
  let data = '';
  req.on('data', (c) => {
    data += c;
    if (data.length > 1e6) req.destroy();
  });
  req.on('end', () => cb(data));
}

// The page may be served under a proxy prefix (/…/preview/abc/), so every
// route is matched on the path's tail and the page uses relative URLs.
function handleRequest(req, res) {
  const url = new URL(req.url, 'http://x');
  const p = url.pathname;
  const tail = p.replace(/^.*\/(vc\/shot\/[^/]+|vc\/[^/]+|files\/[^/]+)$/, '$1');
  // Polls and health checks are not activity: an open tab shouldn't keep the server up forever.
  const passive =
    tail === 'vc/state' ||
    tail === 'vc/health' ||
    tail === 'vc/review-status' ||
    (tail === 'vc/pins' && url.searchParams.has('poll'));
  if (!passive) touchActivity();
  const corsOrigin = (res.corsOrigin = LOCAL_ORIGIN.test(req.headers.origin || '')
    ? req.headers.origin
    : null);
  if (req.method === 'OPTIONS') {
    res.writeHead(
      204,
      corsOrigin
        ? {
            'Access-Control-Allow-Origin': corsOrigin,
            'Access-Control-Allow-Methods': 'GET, POST',
            'Access-Control-Allow-Headers': 'Content-Type',
            Vary: 'Origin',
          }
        : {}
    );
    return res.end();
  }
  if (req.method === 'GET' && (tail === 'vc/review.js' || tail === 'vc/director.js')) {
    const f = tail === 'vc/review.js' ? REVIEW_JS : DIRECTOR_JS;
    if (!fs.existsSync(f)) return send(res, 404, 'Not found', 'text/plain');
    return send(res, 200, read(f), MIME_TYPES['.js']);
  }
  if (req.method === 'GET' && tail === 'vc/review') {
    const scr = url.searchParams.get('screen');
    return send(res, 200, pinsFor(scr === null ? null : scr));
  }

  if (req.method === 'GET' && tail === 'vc/health') {
    return send(res, 200, {
      ok: true,
      app: 'visual-companion',
      v: VERSION,
      session: SESSION_ID,
      session_dir: SESSION_DIR,
      pid: process.pid,
      port: PORT,
      clients: clients.size,
      idle_ms: IDLE_TIMEOUT_MS,
      idle_left_ms:
        IDLE_TIMEOUT_MS > 0 ? Math.max(0, IDLE_TIMEOUT_MS - (Date.now() - lastActivity)) : null,
    });
  }
  if (req.method === 'GET' && tail === 'vc/state') return send(res, 200, statePayload());
  if (req.method === 'GET' && tail === 'vc/pins')
    return send(res, 200, pinsFor(url.searchParams.get('screen')));
  if (req.method === 'GET' && tail === 'vc/review-status') {
    reviewStatus(url.searchParams.get('screen')).then(
      (st) => send(res, 200, st),
      () => send(res, 200, { routed: false })
    );
    return;
  }
  if (req.method === 'GET' && tail.startsWith('vc/shot/')) {
    const f = path.join(SHOTS_DIR, path.basename(decodeURIComponent(tail.slice(8))));
    if (!f.endsWith('.png') || !fs.existsSync(f)) return send(res, 404, 'Not found', 'text/plain');
    res.writeHead(200, { 'Content-Type': 'image/png', 'Cache-Control': 'no-cache' });
    return fs.createReadStream(f).pipe(res);
  }
  if (req.method === 'GET' && tail === 'vc/app.css') {
    if (!fs.existsSync(APP_CSS_FILE))
      return send(res, 404, 'app.css is not built yet: run scripts/vc build', 'text/plain');
    res.writeHead(200, { 'Content-Type': MIME_TYPES['.css'], 'Cache-Control': 'max-age=300' });
    return fs.createReadStream(APP_CSS_FILE).pipe(res);
  }
  if (req.method === 'POST' && tail === 'vc/event') {
    return readBody(req, (body) => {
      let event;
      try {
        event = JSON.parse(body);
      } catch {
        return send(res, 400, { ok: false, error: 'bad json' });
      }
      if (!event || typeof event !== 'object' || Array.isArray(event))
        return send(res, 400, { ok: false, error: 'bad event' });
      const { vt, ...rest } = event;
      if (crossOrigin(req) && !tokenOk(rest.screen, vt))
        return send(res, 403, {
          ok: false,
          error: 'stale-link',
          message: 'This page needs the link from `vc review open` (its vt token).',
        });
      const saved = recordEvent(rest);
      send(res, 200, { ok: true, routed: saved.routed, timestamp: saved.timestamp });
    });
  }
  if (req.method === 'GET' && tail.startsWith('files/')) {
    const filePath = path.join(CONTENT_DIR, path.basename(decodeURIComponent(tail.slice(6))));
    if (!fs.existsSync(filePath)) return send(res, 404, 'Not found', 'text/plain');
    const ext = path.extname(filePath).toLowerCase();
    res.writeHead(200, { 'Content-Type': MIME_TYPES[ext] || 'application/octet-stream' });
    return fs.createReadStream(filePath).pipe(res);
  }
  if (req.method === 'GET' && (p.endsWith('/') || p.endsWith('.html') || !p.includes('.'))) {
    const html = renderScreen(url.searchParams.get('screen'), {
      shot: url.searchParams.has('shot'),
    });
    if (html === null) return send(res, 404, 'No such screen', 'text/plain');
    return send(res, 200, html, 'text/html; charset=utf-8');
  }
  send(res, 404, 'Not found', 'text/plain');
}

// ========== WebSocket ==========

const clients = new Set();

function handleUpgrade(req, socket) {
  const key = req.headers['sec-websocket-key'];
  if (!key) {
    socket.destroy();
    return;
  }

  socket.write(
    'HTTP/1.1 101 Switching Protocols\r\n' +
      'Upgrade: websocket\r\n' +
      'Connection: Upgrade\r\n' +
      'Sec-WebSocket-Accept: ' +
      computeAcceptKey(key) +
      '\r\n\r\n'
  );

  let buffer = Buffer.alloc(0);
  // A socket from another origin only listens: events from pages arrive by POST,
  // where cross-origin writes need a token. (v1 pages, same-origin, still send here.)
  const readOnly = crossOrigin(req);
  clients.add(socket);
  socket.write(
    encodeFrame(OPCODES.TEXT, Buffer.from(JSON.stringify({ type: 'hello', version: stateVersion })))
  );

  socket.on('data', (chunk) => {
    buffer = Buffer.concat([buffer, chunk]);
    while (buffer.length > 0) {
      let result;
      try {
        result = decodeFrame(buffer);
      } catch {
        socket.end(encodeFrame(OPCODES.CLOSE, Buffer.alloc(0)));
        clients.delete(socket);
        return;
      }
      if (!result) break;
      buffer = buffer.slice(result.bytesConsumed);

      switch (result.opcode) {
        case OPCODES.TEXT:
          if (!readOnly) handleMessage(result.payload.toString());
          break;
        case OPCODES.CLOSE:
          socket.end(encodeFrame(OPCODES.CLOSE, Buffer.alloc(0)));
          clients.delete(socket);
          return;
        case OPCODES.PING:
          socket.write(encodeFrame(OPCODES.PONG, result.payload));
          break;
        case OPCODES.PONG:
          break;
        default: {
          const closeBuf = Buffer.alloc(2);
          closeBuf.writeUInt16BE(1003);
          socket.end(encodeFrame(OPCODES.CLOSE, closeBuf));
          clients.delete(socket);
          return;
        }
      }
    }
  });

  socket.on('close', () => clients.delete(socket));
  socket.on('error', () => clients.delete(socket));
}

// v1 pages send events over the socket; v2 pages POST them. Accept both.
function handleMessage(text) {
  let event;
  try {
    event = JSON.parse(text);
  } catch (e) {
    console.error('Failed to parse WebSocket message:', e.message);
    return;
  }
  if (event.type === 'ping') return;
  recordEvent(event);
}

function broadcast(msg) {
  const frame = encodeFrame(OPCODES.TEXT, Buffer.from(JSON.stringify(msg)));
  for (const socket of clients) {
    try {
      socket.write(frame);
    } catch {
      clients.delete(socket);
    }
  }
}

// ========== Activity ==========

let lastActivity = Date.now();

function touchActivity() {
  lastActivity = Date.now();
}

// ========== Auto-screenshots ==========

// Every new screen is shot headless in light and dark into <session>/shots/.
// shoot.cjs writes <name>.light.png, <name>.dark.png and <name>.json (status).
function shoot(name) {
  if (!SHOTS_ENABLED) return;
  fs.mkdirSync(SHOTS_DIR, { recursive: true });
  const url = 'http://127.0.0.1:' + PORT + '/?shot&screen=' + encodeURIComponent(name);
  const child = spawn(process.execPath, [path.join(__dirname, 'shoot.cjs'), url, SHOTS_DIR, name], {
    stdio: 'ignore',
    detached: true,
  });
  child.on('error', () => {});
  child.unref();
}

// ========== Server Startup ==========

function startServer() {
  for (const d of [CONTENT_DIR, STATE_DIR]) fs.mkdirSync(d, { recursive: true });

  // macOS fs.watch reports 'rename' for both new files and overwrites, so new
  // vs updated is decided against the set of files already seen.
  const knownFiles = new Set(fs.readdirSync(CONTENT_DIR).filter((f) => f.endsWith('.html')));
  const debounceTimers = new Map();

  const server = http.createServer(handleRequest);
  server.on('upgrade', handleUpgrade);

  const watcher = fs.watch(CONTENT_DIR, (eventType, filename) => {
    if (!filename || !filename.endsWith('.html') || filename.startsWith('.')) return;

    if (debounceTimers.has(filename)) clearTimeout(debounceTimers.get(filename));
    debounceTimers.set(
      filename,
      setTimeout(() => {
        debounceTimers.delete(filename);
        const filePath = path.join(CONTENT_DIR, filename);
        const name = filename.replace(/\.html$/, '');
        if (!fs.existsSync(filePath)) {
          knownFiles.delete(filename);
          bump();
          broadcast({ type: 'screens', version: stateVersion });
          return;
        }
        touchActivity();
        bump();
        const mtime = Math.round(fs.statSync(filePath).mtimeMs);

        if (!knownFiles.has(filename)) {
          knownFiles.add(filename);
          console.log(JSON.stringify({ type: 'screen-added', file: filePath }));
          broadcast({
            type: 'reload',
            reason: 'screen-added',
            screen: name,
            mtime,
            version: stateVersion,
          });
        } else {
          console.log(JSON.stringify({ type: 'screen-updated', file: filePath }));
          broadcast({
            type: 'reload',
            reason: 'screen-updated',
            screen: name,
            mtime,
            version: stateVersion,
          });
        }
        shoot(name);
      }, 100)
    );
  });
  watcher.on('error', (err) => console.error('fs.watch error:', err.message));

  function shutdown(reason) {
    console.log(JSON.stringify({ type: 'server-stopped', reason }));
    const infoFile = path.join(STATE_DIR, 'server-info');
    try {
      const info = JSON.parse(read(infoFile));
      if (info.pid === process.pid) fs.unlinkSync(infoFile);
    } catch {
      // Best effort: nothing to do if this fails.
    }
    // Atomic, so a reader never sees the file half-written.
    const stoppedTmp = path.join(STATE_DIR, '.server-stopped.tmp');
    fs.writeFileSync(
      stoppedTmp,
      JSON.stringify({ reason, timestamp: Date.now(), pid: process.pid, port: PORT }) + '\n'
    );
    fs.renameSync(stoppedTmp, path.join(STATE_DIR, 'server-stopped'));
    watcher.close();
    clearInterval(lifecycleCheck);
    broadcast({ type: 'bye', reason });
    for (const s of clients) s.destroy();
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 500).unref();
  }

  function ownerAlive() {
    if (!ownerPid) return true;
    try {
      process.kill(ownerPid, 0);
      return true;
    } catch (e) {
      return e.code === 'EPERM';
    }
  }

  const checkEvery =
    IDLE_TIMEOUT_MS > 0 ? Math.max(250, Math.min(60 * 1000, IDLE_TIMEOUT_MS / 4)) : 60 * 1000;
  const lifecycleCheck = setInterval(() => {
    if (!ownerAlive()) shutdown('owner process exited');
    else if (IDLE_TIMEOUT_MS > 0 && Date.now() - lastActivity > IDLE_TIMEOUT_MS)
      shutdown('idle timeout');
  }, checkEvery);
  lifecycleCheck.unref();

  // An owner PID that is already dead was resolved wrongly (WSL, SSH, cross-user).
  // Drop it and rely on the idle timeout.
  if (ownerPid) {
    try {
      process.kill(ownerPid, 0);
    } catch (e) {
      if (e.code !== 'EPERM') {
        console.log(
          JSON.stringify({ type: 'owner-pid-invalid', pid: ownerPid, reason: 'dead at startup' })
        );
        ownerPid = null;
      }
    }
  }

  process.on('SIGTERM', () => shutdown('stopped'));
  process.on('SIGINT', () => shutdown('stopped'));

  server.on('error', (err) => {
    // vc reads this and tries the next port. Never fight another process for one.
    console.log(
      JSON.stringify({ type: 'server-error', code: err.code, port: PORT, message: err.message })
    );
    process.exit(err.code === 'EADDRINUSE' ? 3 : 1);
  });

  // A Send still waiting when the server stopped goes back in line: the person was
  // told "queued", so a restart must not quietly drop it. One that DorkOS already
  // took is never sent again, whatever was written after its `delivered` line. One
  // caught mid-request (`delivering`) may or may not have landed, so it is never
  // replayed: it is marked failed/unsure and the person decides to send it again.
  function replayQueued() {
    const evs = readEvents();
    const sends = new Map();
    for (const e of evs) if (e.type === 'send') sends.set(e.timestamp + '|' + e.screen, e);
    const lastBySend = new Map();
    const landed = new Set();
    for (const e of evs) {
      if (e.type !== 'delivery' || !e.send) continue;
      const k = e.send + '|' + e.screen;
      lastBySend.set(k, e);
      if (e.state === 'delivered') landed.add(k);
    }
    for (const [k, d] of lastBySend) {
      const e = sends.get(k);
      if (!e || landed.has(k)) continue;
      if (d.state === 'delivering') {
        markDelivery([e], 'failed', 'unsure');
        continue;
      }
      if (d.state !== 'queued') continue;
      if (Date.now() - e.timestamp > 30 * 60e3) continue;
      if (!screenWakes(e.screen) || !readRoute(e.screen)) continue;
      e._delivery = d.state + '|' + (d.reason || '');
      routeQueue.push(e);
    }
    if (routeQueue.length) scheduleRoute(1500);
  }
  replayQueued();

  server.listen(PORT, HOST, () => {
    const info = JSON.stringify({
      type: 'server-started',
      v: VERSION,
      pid: process.pid,
      port: PORT,
      host: HOST,
      url_host: URL_HOST,
      url: 'http://' + URL_HOST + ':' + PORT,
      session: SESSION_ID,
      agent_session: process.env.VC_AGENT_SESSION || null,
      session_dir: SESSION_DIR,
      screen_dir: CONTENT_DIR,
      state_dir: STATE_DIR,
      shots_dir: SHOTS_DIR,
      idle_ms: IDLE_TIMEOUT_MS,
      theme: defaultTheme(),
      started: Date.now(),
    });
    try {
      fs.unlinkSync(path.join(STATE_DIR, 'server-stopped'));
    } catch {
      // Best effort: nothing to do if this fails.
    }
    console.log(info);
    fs.writeFileSync(path.join(STATE_DIR, 'server-info'), info + '\n');
  });
}

if (require.main === module) {
  startServer();
}

module.exports = { computeAcceptKey, encodeFrame, decodeFrame, OPCODES, readMeta, isFullDocument };
