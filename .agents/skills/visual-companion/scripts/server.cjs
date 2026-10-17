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

function boot(screen, screens, raw) {
  const index = screen ? screens.findIndex((s) => s.name === screen.name) : -1;
  return {
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
  const tail = '<script>\n' + helperScript + '\n</script>';

  if (isFullDocument(raw)) {
    // Full documents keep control of the page; the frame adds only its chrome.
    let html = raw;
    html = html.includes('</head>') ? html.replace('</head>', head + '\n</head>') : head + html;
    html = html.includes('</body>') ? html.replace('</body>', tail + '\n</body>') : html + tail;
    return html;
  }
  return frameTemplate
    .replace('<!-- HEAD -->', head)
    .replace('<!-- TITLE -->', escapeHtml(data.title))
    .replace('<!-- CONTENT -->', raw)
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

// The screen decides, not the page: read its meta from disk.
function screenWakes(name) {
  const f = screenFile(name);
  return !!f && readMeta(read(f), 'wake') === 'on';
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

function enqueueRoute(event) {
  if (event.channel) return false; // already delivered over window.dorkos.channel
  if (event.type !== 'send' && event.type !== 'pin') return false;
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
  return f ? titleFor(name, read(f)) : name;
}

function buildPayload(batch) {
  const groups = new Map();
  for (const e of batch) {
    const k = e.screen || '';
    if (!groups.has(k))
      groups.set(k, { selection: [], newPins: [], trigger: 'pin', message: null });
    const g = groups.get(k);
    if (Array.isArray(e.selection)) g.selection = e.selection;
    if (e.type === 'pin') g.newPins.push(e.n);
    if (e.type === 'send') g.trigger = 'send';
    if (e.message) g.message = clip(e.message, 500);
  }
  const screens = [];
  const lines = [];
  for (const [name, g] of groups) {
    const pins = pinsFor(name)
      .slice(-15)
      .map((p) => ({
        n: p.n,
        note: clip(p.note, 300),
        selector: p.selector,
        target: clip(p.target, 80),
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
    if (g.message) parts.push('said "' + g.message + '"');
    lines.push(title + ': ' + (parts.join('; ') || 'sent with nothing selected'));
  }
  return { summary: lines, screens, events_file: EVENTS_FILE };
}

async function deliverRoute() {
  if (!routeQueue.length) return;
  const r = readRoute(routeQueue[0].screen);
  if (!r) {
    // Its chat is gone or routing is off: drop it and move on to the rest.
    routeQueue.shift();
    return void scheduleRoute(0);
  }
  const now = Date.now();
  while (routeSent.length && now - routeSent[0] > 3600e3) routeSent.shift();
  if (routeSent.length >= 20) {
    routeLog({ status: 'rate-limited', pending: routeQueue.length });
    return scheduleRoute(60e3);
  }
  // One delivery per chat: take the queued events that belong to this one.
  const batch = routeQueue.filter((e) => readRoute(e.screen)?.session === r.session);
  const payload = buildPayload(batch);
  while (JSON.stringify(payload).length > 7500 && payload.screens.some((x) => x.pins.length)) {
    for (const x of payload.screens) x.pins.shift();
  }
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
    if (routeQueue.length) scheduleRoute(1000);
  } else if (status === 409 || status === -1 || status >= 500) {
    // Busy (the agent is mid-turn) or DorkOS is unreachable: keep the batch and retry.
    routeLog({
      status: status === 409 ? 'busy' : 'unreachable',
      http: status,
      pending: routeQueue.length,
    });
    const wait = routeRetry;
    routeRetry = Math.min(routeRetry * 1.5, 30e3);
    if (Date.now() - batch[0].timestamp < 30 * 60e3) scheduleRoute(wait);
    else {
      routeLog({
        status: 'dropped',
        reason: 'undelivered for 30 minutes',
        events: routeQueue.length,
      });
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
    for (const e of batch) routeQueue.splice(routeQueue.indexOf(e), 1);
  }
}

function recordEvent(event) {
  const clean = { ...event };
  if (!clean.timestamp) clean.timestamp = Date.now();
  if (!clean.type) clean.type = 'event';
  fs.appendFileSync(EVENTS_FILE, JSON.stringify(clean) + '\n');
  console.log(JSON.stringify({ source: 'user-event', ...clean }));
  touchActivity();
  clean.routed = enqueueRoute(clean);
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

// Pins still standing on a screen: every pin minus the ones deleted since.
function pinsFor(screen) {
  const pins = new Map();
  for (const e of readEvents()) {
    if (e.screen !== screen) continue;
    if (e.type === 'pin') pins.set(e.n, e);
    if (e.type === 'pin-delete') pins.delete(e.n);
  }
  return [...pins.values()];
}

// ========== HTTP ==========

function send(res, status, body, type) {
  res.writeHead(status, {
    'Content-Type': type || 'application/json',
    'Cache-Control': 'no-store',
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
  const tail = p.replace(/^.*\/(vc\/[^/]+|files\/[^/]+)$/, '$1');
  // Polls and health checks are not activity: an open tab shouldn't keep the server up forever.
  const passive = tail === 'vc/state' || tail === 'vc/health';
  if (!passive) touchActivity();

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
      const saved = recordEvent(event);
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
          handleMessage(result.payload.toString());
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
    fs.writeFileSync(
      path.join(STATE_DIR, 'server-stopped'),
      JSON.stringify({ reason, timestamp: Date.now(), pid: process.pid, port: PORT }) + '\n'
    );
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
