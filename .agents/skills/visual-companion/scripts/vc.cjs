#!/usr/bin/env node
// vc — the visual companion in one command.
//
//   vc show <file|-> [--name N] [--title T] [--app-css] [--wake] [--theme light|dark]
//                    [--session ID] [--no-wait]
//   vc start [--new] [--port N] [--idle 4h] [--theme light|dark]
//   vc status | url | stop
//   vc build [--dorkos <repo>] [--tokens-only]   rebuild assets/ from the DorkOS repo
//   vc events [--all] [--peek]          new events since the last read (JSONL)
//   vc route [status] | off | on [--via ui-action|message] [--label NAME] [--session ID]
//   vc theme light|dark                 default theme for screens without their own
//   vc review list [--screen S] [--all]  the notes people left (open requests by default)
//   vc review resolve <[screen#]n> "what you did"   answer a note: a check and your line on the page
//   vc review dismiss <[screen#]n> "why"            answer it the other way
//   vc review open <url> --name S [--title T] [--wake]   review a prototype through the companion
//   vc review crop [<[screen#]n>] [--screen S]           (re)take note crops into shots/notes/
//
// Waking: a screen shown with --wake (or <meta name="vc-wake" content="on">)
// gets a Send bar; Send, or a submitted pin note, wakes the chat that ran
// `vc show` (its DorkOS session id: --session, $DORKOS_SESSION_ID or
// $CLAUDE_CODE_SESSION_ID) with a <ui_action> turn. Everything else stays in events.
//
// Global: --project-dir P (default $VC_PROJECT_DIR or the cwd). Sessions live in
// <project>/.dork/visual-companion/<id>/ and `current` names the active one, so
// a restart keeps the same screens, history and port.
//
// Port: --port, $VC_PORT or $BRAINSTORM_PORT pins one (walking up past a busy
// one). Without them a session reuses the port it had last, else a free one.
//
// Every command prints one JSON object (events prints JSONL).
const fs = require('fs');
const path = require('path');
const http = require('http');
const net = require('net');
const crypto = require('crypto');
const { spawn, spawnSync } = require('child_process');
const store = require('./review-store.cjs');

const SCRIPTS = __dirname;
const ASSETS = path.join(SCRIPTS, 'assets');

// ---------- args ----------
const argv = process.argv.slice(2);
const cmd = argv[0] && !argv[0].startsWith('--') ? argv.shift() : 'status';
const flags = {};
const pos = [];
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a === '-') pos.push(a);
  else if (a.startsWith('--')) {
    const [k, v] = a.slice(2).split('=');
    if (v !== undefined) flags[k] = v;
    else if (
      argv[i + 1] !== undefined &&
      !argv[i + 1].startsWith('--') &&
      !['new', 'no-wait', 'all', 'peek', 'app-css', 'no-shots', 'wake', 'tokens-only'].includes(k)
    )
      flags[k] = argv[++i];
    else flags[k] = true;
  } else pos.push(a);
}

function out(obj, code) {
  process.stdout.write(JSON.stringify(obj) + '\n');
  process.exit(code || 0);
}
function fail(error, extra) {
  out({ ok: false, error, ...(extra || {}) }, 1);
}

function parseDuration(s) {
  if (s === undefined || s === true) return undefined;
  const m = String(s).match(/^(\d+(?:\.\d+)?)(ms|s|m|h)?$/);
  if (!m) fail('bad duration: ' + s + ' (use 90s, 30m, 4h or 0)');
  return Math.round(Number(m[1]) * { ms: 1, s: 1e3, m: 60e3, h: 3600e3 }[m[2] || 'ms']);
}

// ---------- session ----------
// Run from inside a skill folder (`cd scripts && node vc.cjs …`), the cwd is the skill,
// not the project: climb out of `.claude/` (or `.agents/`, where a repo keeps its
// skills) so sessions never land inside the skill.
const climb = (d) => {
  const parts = d.split(path.sep);
  const i = Math.max(parts.lastIndexOf('.claude'), parts.lastIndexOf('.agents'));
  return i > 0 ? parts.slice(0, i).join(path.sep) : d;
};
const projectDir = path.resolve(
  flags['project-dir'] || process.env.VC_PROJECT_DIR || climb(process.cwd())
);
const baseDir = path.join(projectDir, '.dork', 'visual-companion');
const currentFile = path.join(baseDir, 'current');

function stamp() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return (
    d.getFullYear() +
    p(d.getMonth() + 1) +
    p(d.getDate()) +
    '-' +
    p(d.getHours()) +
    p(d.getMinutes()) +
    p(d.getSeconds())
  );
}

function sessionDir(create) {
  let id = null;
  if (!flags.new) {
    try {
      id = fs.readFileSync(currentFile, 'utf8').trim() || null;
    } catch {
      // Best effort: nothing to do if this fails.
    }
  }
  if (id && !fs.existsSync(path.join(baseDir, id))) id = null;
  if (!id) {
    if (!create) return null;
    id = stamp();
    fs.mkdirSync(path.join(baseDir, id, 'content'), { recursive: true });
    fs.mkdirSync(path.join(baseDir, id, 'state'), { recursive: true });
    fs.writeFileSync(currentFile, id + '\n');
  }
  return path.join(baseDir, id);
}

const readJson = (f) => {
  try {
    return JSON.parse(fs.readFileSync(f, 'utf8'));
  } catch {
    return null;
  }
};

// ---------- the chat to wake ----------
function agentSession() {
  return (
    flags.session || process.env.DORKOS_SESSION_ID || process.env.CLAUDE_CODE_SESSION_ID || null
  );
}
function agentLabel() {
  if (flags.label) return flags.label;
  const agent = readJson(path.join(projectDir, '.dork', 'agent.json'));
  return (agent && agent.name) || null;
}
// The chat that ran `vc show` is the one a Send wakes, unless routing is off.
function recordRoute(dir) {
  const f = path.join(dir, 'state', 'route.json');
  const cur = readJson(f) || {};
  if (cur.mode === 'off') return cur;
  const session = agentSession();
  if (!session) return cur;
  const next = {
    mode: cur.mode || 'ui-action',
    session,
    dorkos: cur.dorkos || 'http://localhost:' + (process.env.DORKOS_PORT || 4242),
    label: agentLabel() || cur.label || null,
  };
  if (JSON.stringify(next) !== JSON.stringify(cur))
    fs.writeFileSync(f, JSON.stringify(next, null, 2) + '\n');
  return next;
}

// ---------- server ----------
function get(port, p, timeout, host) {
  return new Promise((resolve) => {
    // `host` defaults to our own server's bind address. DorkOS may listen on
    // IPv6 only, so calls to it pass the URL's hostname and let the OS resolve.
    const req = http.get(
      { host: host || '127.0.0.1', port, path: p, timeout: timeout || 800 },
      (res) => {
        let body = '';
        res.on('data', (c) => (body += c));
        res.on('end', () => {
          let json = null;
          try {
            json = JSON.parse(body);
          } catch {
            // Best effort: nothing to do if this fails.
          }
          resolve({ status: res.statusCode, json });
        });
      }
    );
    req.on('timeout', () => {
      req.destroy();
      resolve({ status: 0, busy: true });
    });
    req.on('error', (e) =>
      resolve({ status: 0, refused: e.code === 'ECONNREFUSED', error: e.code })
    );
  });
}

function alive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e.code === 'EPERM';
  }
}

async function running(dir) {
  const info = readJson(path.join(dir, 'state', 'server-info'));
  if (!info || !info.pid || !alive(info.pid)) return null;
  const h = await get(info.port, '/vc/health');
  if (h.status === 200 && h.json && h.json.app === 'visual-companion' && h.json.session_dir === dir)
    return { ...info, health: h.json };
  return null;
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function launch(dir, port) {
  const state = path.join(dir, 'state');
  fs.mkdirSync(state, { recursive: true });
  const log = fs.openSync(path.join(state, 'server.log'), 'a');
  const env = { ...process.env, BRAINSTORM_DIR: dir, BRAINSTORM_PORT: String(port) };
  delete env.BRAINSTORM_OWNER_PID; // vc servers outlive the shell; the idle timeout ends them
  if (agentSession()) env.VC_AGENT_SESSION = agentSession();
  if (agentLabel()) env.VC_AGENT_LABEL = agentLabel();
  const idle = parseDuration(flags.idle);
  if (idle !== undefined) env.BRAINSTORM_IDLE_MS = String(idle);
  if (flags.host) env.BRAINSTORM_HOST = flags.host;
  if (flags['url-host']) env.BRAINSTORM_URL_HOST = flags['url-host'];
  const child = spawn(process.execPath, [path.join(SCRIPTS, 'server.cjs')], {
    detached: true,
    stdio: ['ignore', log, log],
    env,
  });
  let exited = null;
  child.on('exit', (code) => (exited = code === null ? -1 : code));
  child.unref();
  fs.writeFileSync(path.join(state, 'server.pid'), child.pid + '\n');
  for (let i = 0; i < 100; i++) {
    await sleep(50);
    if (exited !== null) return { exited, port };
    const info = readJson(path.join(state, 'server-info'));
    if (info && info.pid === child.pid) return { info };
  }
  return { timeout: true, port };
}

// A port the OS says is free right now. Another process can take it before the
// server binds; the server then exits 3 and ensure() asks again.
function freePort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.unref();
    s.on('error', reject);
    s.listen(0, '127.0.0.1', () => {
      const { port } = s.address();
      s.close(() => resolve(port));
    });
  });
}

// A pinned port (--port, VC_PORT, BRAINSTORM_PORT) walks up when something
// else holds it. Otherwise the session's last port comes first, so a canvas tab
// left open finds the server again, then any free port. Never touch a process
// this session didn't start.
async function ensure(dir) {
  const r = await running(dir);
  if (r) return { info: r, server: 'running' };
  const pinned = flags.port || process.env.VC_PORT || process.env.BRAINSTORM_PORT;
  const want = pinned ? Number(pinned) : null;
  if (pinned && !(want > 0 && want < 65536)) fail('bad port: ' + pinned);
  // A stopped server leaves its port in server-stopped; a crashed one, in server-info.
  const last = (
    readJson(path.join(dir, 'state', 'server-stopped')) ||
    readJson(path.join(dir, 'state', 'server-info')) ||
    {}
  ).port;
  const skipped = [];
  for (let i = 0; i < 25; i++) {
    const port = want ? want + i : i === 0 && last ? last : await freePort();
    const probe = await get(port, '/vc/health', 500);
    if (probe.status === 200 && probe.json && probe.json.session_dir === dir) {
      return {
        info: { ...readJson(path.join(dir, 'state', 'server-info')), port },
        server: 'running',
      };
    }
    if (!probe.refused) {
      skipped.push(port);
      continue;
    }
    const res = await launch(dir, port);
    if (res.info) return { info: res.info, server: 'started', skipped };
    if (res.exited === 3) {
      skipped.push(port);
      continue;
    }
    fail('server failed to start', {
      port,
      log: path.join(dir, 'state', 'server.log'),
      exit: res.exited,
      timeout: !!res.timeout,
    });
  }
  fail(want ? 'no free port from ' + want + ' to ' + (want + 24) : 'no free port after 25 tries', {
    skipped,
  });
}

// ---------- assets ----------
// assets/tokens.css (the frame's colours) and assets/app.css (the real client
// CSS, for screens that opt in) are generated from the DorkOS repo and never
// committed. Build them the first time they're needed, and rebuild tokens.css
// when the repo's token files are newer than it.
function runBuild(extra) {
  const args = [path.join(SCRIPTS, 'build-assets.mjs'), ...extra];
  if (typeof flags.dorkos === 'string') args.push('--dorkos', flags.dorkos);
  const r = spawnSync(process.execPath, args, { encoding: 'utf8', timeout: 120000 });
  if (r.status === 0) return null;
  return (
    ((r.stderr || '').trim().split('\n').pop() || 'asset build failed') +
    ' (scripts/vc build to retry)'
  );
}

function tokensStale() {
  const f = path.join(ASSETS, 'tokens.css');
  if (!fs.existsSync(f)) return true;
  let repo;
  try {
    repo = require('./locate.cjs').findDorkosRepo(
      typeof flags.dorkos === 'string' ? flags.dorkos : undefined
    );
  } catch {
    return false; // keep the copy we have when the repo can't be found
  }
  const built = fs.statSync(f).mtimeMs;
  return ['packages/ui/tokens.css', 'apps/client/src/index.css'].some(
    (s) => fs.statSync(path.join(repo, s)).mtimeMs > built
  );
}

// Tokens are required: a frame without them has no colours, so fail loudly.
// app.css is optional: a screen that asked for it still shows, with a warning.
function ensureAssets(needApp) {
  if (tokensStale()) {
    const err = runBuild(['--tokens-only']);
    if (err && !fs.existsSync(path.join(ASSETS, 'tokens.css'))) fail(err);
  }
  if (needApp && !fs.existsSync(path.join(ASSETS, 'app.css'))) return runBuild([]);
  return null;
}

const wantsAppCss = (html) =>
  !!flags['app-css'] || /<meta\b[^>]*\bvc-css\b[^>]*\bapp\b[^>]*>/i.test(html);

function urlFor(info, screen) {
  const u = new URL(info.url + '/');
  if (screen) u.searchParams.set('screen', screen);
  if (flags.theme === 'light' || flags.theme === 'dark') u.searchParams.set('theme', flags.theme);
  return u.toString();
}

function summary(dir, info, extra) {
  return {
    ok: true,
    url: urlFor(info),
    port: info.port,
    session: path.basename(dir),
    session_dir: dir,
    screen_dir: path.join(dir, 'content'),
    state_dir: path.join(dir, 'state'),
    events_file: path.join(dir, 'state', 'events'),
    shots_dir: path.join(dir, 'shots'),
    route: (() => {
      const r = readJson(path.join(dir, 'state', 'route.json'));
      return r && r.session && r.mode !== 'off'
        ? { mode: r.mode, session: r.session, label: r.label }
        : { mode: r && r.mode === 'off' ? 'off' : 'none' };
    })(),
    ...extra,
  };
}

function setTheme(dir, theme) {
  if (theme !== 'light' && theme !== 'dark') return;
  const f = path.join(dir, 'state', 'config.json');
  const cfg = readJson(f) || {};
  cfg.theme = theme;
  fs.writeFileSync(f, JSON.stringify(cfg) + '\n');
}

function slug(s) {
  return (
    String(s)
      .toLowerCase()
      .replace(/\.html?$/, '')
      .replace(/[^a-z0-9_-]+/g, '-')
      .replace(/^-+|-+$/g, '') || 'screen'
  );
}

// ---------- commands ----------
async function main() {
  if (cmd === 'start') {
    const dir = sessionDir(true);
    if (flags.theme) setTheme(dir, flags.theme);
    const assetsError = ensureAssets(!!flags['app-css']);
    const r = await ensure(dir);
    return out(
      summary(dir, r.info, {
        server: r.server,
        skipped_ports: r.skipped,
        ...(assetsError ? { assets_error: assetsError } : {}),
      })
    );
  }

  if (cmd === 'show') {
    const src = pos[0];
    if (!src) fail('usage: vc show <file|-> [--name N]');
    const html =
      src === '-' ? fs.readFileSync(0, 'utf8') : fs.readFileSync(path.resolve(src), 'utf8');
    if (!html.trim()) fail('empty screen');
    const dir = sessionDir(true);
    if (flags.theme) setTheme(dir, flags.theme);
    fs.mkdirSync(path.join(dir, 'state'), { recursive: true });
    recordRoute(dir);
    const assetsError = ensureAssets(wantsAppCss(html));
    const r = await ensure(dir);
    const content = path.join(dir, 'content');
    fs.mkdirSync(content, { recursive: true });
    // Never reuse a filename: each screen is a new step in history.
    const base = slug(flags.name || (src === '-' ? 'screen' : path.basename(src)));
    let name = base;
    for (let n = 2; fs.existsSync(path.join(content, name + '.html')); n++) name = base + '-' + n;
    let body = html;
    const metas = [];
    if (flags.title)
      metas.push(
        '<meta name="vc-title" content="' + String(flags.title).replace(/"/g, '&quot;') + '">'
      );
    if (flags['app-css']) metas.push('<meta name="vc-css" content="app">');
    if (flags.wake) metas.push('<meta name="vc-wake" content="on">');
    if (metas.length) {
      const full = /^\s*(<!doctype|<html)/i.test(body);
      body = full
        ? body.replace(/<head[^>]*>/i, (m) => m + metas.join(''))
        : metas.join('\n') + '\n' + body;
    }
    const tmp = path.join(content, '.' + name + '.tmp');
    fs.writeFileSync(tmp, body);
    const written = Date.now();
    fs.renameSync(tmp, path.join(content, name + '.html'));
    // Each screen remembers the chat that showed it, so a Send on an older
    // screen goes back to that chat even if another chat showed something since.
    const owner = agentSession();
    if (owner) {
      const rf = path.join(dir, 'state', 'screen-routes.json');
      const map = readJson(rf) || {};
      map[name] = owner;
      fs.writeFileSync(rf, JSON.stringify(map, null, 2) + '\n');
    }

    let shots = null;
    let shotsError;
    if (!flags['no-wait'] && !flags['no-shots'] && process.env.BRAINSTORM_SHOTS !== '0') {
      const status = path.join(dir, 'shots', name + '.json');
      for (let i = 0; i < 200; i++) {
        await sleep(100);
        try {
          if (fs.statSync(status).mtimeMs >= written - 50) {
            const s = readJson(status);
            if (s && s.ok) shots = s.files;
            else shotsError = (s && s.error) || 'screenshot failed';
            break;
          }
        } catch {
          // Best effort: nothing to do if this fails.
        }
      }
      if (!shots && !shotsError) shotsError = 'screenshots still running; they will land in shots/';
    }
    return out(
      summary(dir, r.info, {
        server: r.server,
        screen: name,
        file: path.join(content, name + '.html'),
        screen_url: urlFor(r.info, name),
        shots,
        ...(shotsError ? { shots_error: shotsError } : {}),
        ...(assetsError ? { assets_error: assetsError } : {}),
      })
    );
  }

  if (cmd === 'build') {
    const err = runBuild(flags['tokens-only'] ? ['--tokens-only'] : []);
    if (err) fail(err);
    return out({
      ok: true,
      assets: ASSETS,
      built: flags['tokens-only'] ? ['tokens.css'] : ['tokens.css', 'app.css'],
    });
  }

  const dir = sessionDir(cmd === 'review' && pos[0] === 'open');
  if (!dir) {
    if (cmd === 'review' && (pos[0] || 'list') === 'list')
      out({ ok: true, count: 0, lines: [], notes: [] });
    if (cmd === 'status' || cmd === 'url')
      out({ ok: true, running: false, reason: 'no session yet; run vc show or vc start' });
    fail('no session yet; run vc show or vc start');
  }

  if (cmd === 'status' || cmd === 'url') {
    const r = await running(dir);
    const stopped = readJson(path.join(dir, 'state', 'server-stopped'));
    const screens = fs.existsSync(path.join(dir, 'content'))
      ? fs.readdirSync(path.join(dir, 'content')).filter((f) => f.endsWith('.html')).length
      : 0;
    if (!r) return out({ ok: true, running: false, session_dir: dir, screens, stopped });
    return out(
      summary(dir, r, {
        running: true,
        screens,
        idle_ms: r.health.idle_ms,
        idle_left_ms: r.health.idle_left_ms,
        clients: r.health.clients,
      })
    );
  }

  if (cmd === 'stop') {
    const r = await running(dir);
    if (!r) return out({ ok: true, status: 'not_running' });
    process.kill(r.pid, 'SIGTERM');
    for (let i = 0; i < 40 && alive(r.pid); i++) await sleep(50);
    return out({
      ok: !alive(r.pid),
      status: alive(r.pid) ? 'still running' : 'stopped',
      pid: r.pid,
    });
  }

  if (cmd === 'theme') {
    const t = pos[0];
    if (t !== 'light' && t !== 'dark') fail('usage: vc theme light|dark');
    setTheme(dir, t);
    return out({ ok: true, theme: t });
  }

  if (cmd === 'events') {
    const file = path.join(dir, 'state', 'events');
    const cursorFile = path.join(dir, 'state', 'events.cursor');
    if (!fs.existsSync(file)) return;
    const buf = fs.readFileSync(file);
    let from = 0;
    if (!flags.all) {
      from = Number((fs.existsSync(cursorFile) && fs.readFileSync(cursorFile, 'utf8')) || 0);
      if (from > buf.length) from = 0;
    }
    process.stdout.write(buf.subarray(from).toString('utf8'));
    if (!flags.peek) fs.writeFileSync(cursorFile, String(buf.length));
    return;
  }

  if (cmd === 'route') {
    const f = path.join(dir, 'state', 'route.json');
    const sub = pos[0] || 'status';
    const cur = readJson(f) || {};
    if (sub === 'off') {
      fs.writeFileSync(f, JSON.stringify({ ...cur, mode: 'off' }, null, 2) + '\n');
      return out({ ok: true, route: { mode: 'off' } });
    }
    if (sub === 'status') {
      const log = path.join(dir, 'state', 'route.log');
      const recent = fs.existsSync(log)
        ? fs
            .readFileSync(log, 'utf8')
            .trim()
            .split('\n')
            .slice(-5)
            .map((l) => JSON.parse(l))
        : [];
      return out({ ok: true, route: cur.mode ? cur : { mode: 'none' }, recent });
    }
    if (sub !== 'on')
      fail(
        'usage: vc route [status] | off | on [--via ui-action|message] [--label NAME] [--session ID]'
      );
    const via = flags.via || (cur.mode && cur.mode !== 'off' ? cur.mode : 'ui-action');
    if (via !== 'ui-action' && via !== 'message') fail('--via is ui-action or message');
    const session = agentSession() || cur.session;
    if (!session) fail('no session id: pass --session (your DorkOS session id)');
    const dorkos = (
      flags.dorkos ||
      cur.dorkos ||
      'http://localhost:' + (process.env.DORKOS_PORT || 4242)
    ).replace(/\/$/, '');
    const route = { mode: via, session, dorkos, label: agentLabel() || cur.label || null };
    // Check DorkOS knows the session before promising the person their sends arrive.
    const u = new URL(dorkos + '/api/sessions/' + encodeURIComponent(session));
    const check = await get(Number(u.port || 80), u.pathname, 2000, u.hostname);
    // The companion carries no credential, so it can only wake a chat while
    // DorkOS login is off (the loopback default). With login on, say so.
    if (check.status === 401 || check.status === 403)
      fail(
        'DorkOS has login on, so the companion cannot wake this chat. Clicks still land in scripts/vc events; read them each turn.'
      );
    if (check.status !== 200)
      fail(
        'DorkOS did not recognise session ' +
          session +
          ' at ' +
          dorkos +
          ' (HTTP ' +
          check.status +
          ')'
      );
    fs.writeFileSync(f, JSON.stringify(route, null, 2) + '\n');
    return out({ ok: true, route, title: check.json && check.json.title });
  }

  if (cmd === 'review') return review(dir);

  fail('unknown command: ' + cmd);
}

// ---------- review: the notes people leave, and the agent's answers ----------
function readEvents(dir) {
  const f = path.join(dir, 'state', 'events');
  if (!fs.existsSync(f)) return [];
  return fs
    .readFileSync(f, 'utf8')
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

// Through the server when it's up (so open pages hear it at once), else straight to the log.
async function record(dir, ev) {
  ev.timestamp = Date.now();
  const r = await running(dir);
  if (r) {
    const ok = await new Promise((resolve) => {
      const req = http.request(
        {
          host: '127.0.0.1',
          port: r.port,
          path: '/vc/event',
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          timeout: 2000,
        },
        (res) => {
          res.resume();
          res.on('end', () => resolve(res.statusCode === 200));
        }
      );
      req.on('error', () => resolve(false));
      req.on('timeout', () => {
        req.destroy();
        resolve(false);
      });
      req.end(JSON.stringify(ev));
    });
    if (ok) return 'server';
  }
  fs.appendFileSync(path.join(dir, 'state', 'events'), JSON.stringify(ev) + '\n');
  return 'log';
}

// "settings#2", or "2" with --screen, or "2" when only one screen has an open note 2.
function findNote(dir, ref, all) {
  if (ref === undefined || ref === true) fail('which note? pass <n>, <screen>#<n> or --screen S');
  const m = String(ref).match(/^(?:(.+)#)?(\d+)$/);
  if (!m) fail('bad note reference: ' + ref + ' (use 2 or screen#2)');
  const screen = m[1] || flags.screen || null;
  const n = Number(m[2]);
  const list = store
    .notes(readEvents(dir), screen, path.join(dir, 'shots'))
    .filter((p) => p.n === n && (all || p.status === 'open'));
  if (!list.length)
    fail('no ' + (all ? '' : 'open ') + 'note ' + n + (screen ? ' on ' + screen : ''));
  if (list.length > 1)
    fail('note ' + n + ' is on several screens; say which', { screens: list.map((p) => p.screen) });
  return list[0];
}

async function review(dir) {
  const sub = pos[0] || 'list';
  const shots = path.join(dir, 'shots');
  if (sub === 'list') {
    const all = store.notes(readEvents(dir), flags.screen || null, shots);
    const list = flags.all ? all : all.filter((p) => p.kind !== 'note' && p.status === 'open');
    return out({
      ok: true,
      count: list.length,
      lines: list.map(store.line),
      notes: list.map((p) => ({
        screen: p.screen,
        n: p.n,
        note: p.note,
        kind: p.kind,
        intent: p.intent,
        status: p.status,
        reply: p.reply,
        ref: p.ref,
        selector: p.selector,
        role: p.role,
        name: p.name,
        source: p.source,
        state: p.state,
        styles: p.styles,
        rect: p.rect,
        page: p.page,
        crop: p.crop,
      })),
    });
  }
  if (sub === 'resolve' || sub === 'dismiss') {
    const p = findNote(dir, pos[1], false);
    const reply = String(pos[2] || flags.reply || '').trim();
    if (!reply)
      fail(
        'say it in a line: vc review ' +
          sub +
          ' ' +
          p.screen +
          '#' +
          p.n +
          ' "' +
          (sub === 'resolve' ? 'what you did' : 'why') +
          '"'
      );
    const via = await record(dir, {
      type: 'pin-resolve',
      screen: p.screen,
      n: p.n,
      status: sub === 'resolve' ? 'resolved' : 'dismissed',
      reply,
      by: 'agent',
    });
    return out({
      ok: true,
      screen: p.screen,
      n: p.n,
      status: sub === 'resolve' ? 'resolved' : 'dismissed',
      reply,
      via,
    });
  }
  if (sub === 'open') {
    const target = pos[1];
    if (!target) fail('usage: vc review open <url> --name S [--title T] [--wake] [--session ID]');
    const name = flags.name ? slug(flags.name) : null;
    if (!name) fail('--name is required (a stable key for its notes, e.g. settings-page)');
    const r = await ensure(dir);
    const f = path.join(dir, 'state', 'reviews.json');
    const map = readJson(f) || {};
    const owner = agentSession();
    // The prototype runs on another origin, so the server takes its events only
    // with this review's token (`vt` in the URL below). Any other local page
    // that posts here has none, and wakes nobody. A new open mints a new one.
    const token = crypto.randomBytes(18).toString('base64url');
    map[name] = {
      title: flags.title || map[name]?.title || name,
      url: target,
      wake: !!flags.wake,
      session: owner || map[name]?.session || null,
      opened: Date.now(),
      token,
    };
    const tmp = f + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(map, null, 2) + '\n', { mode: 0o600 });
    fs.renameSync(tmp, f);
    if (owner) {
      const rf = path.join(dir, 'state', 'screen-routes.json');
      const routes = readJson(rf) || {};
      routes[name] = owner;
      fs.writeFileSync(rf, JSON.stringify(routes, null, 2) + '\n');
    }
    const route = recordRoute(dir);
    // The page (or its host) reads ?review=, ?vc= and ?vt=; the director kit
    // loads the layer from vc, and the layer sends vt with every event.
    const u = new URL(target, 'file:///');
    u.searchParams.set('review', name);
    u.searchParams.set('vc', r.info.url + '/');
    u.searchParams.set('vt', token);
    // Who Send reaches, by name ("Send 2 to <agent>").
    if (route && route.label) u.searchParams.set('agent', route.label);
    // A page that never loads the layer shows no Review pill, and nobody can pin.
    // Say so here, not after the person has looked for a button that isn't there.
    let pins = null;
    if (/^https?:/.test(target)) {
      try {
        const html = await (await fetch(target, { signal: AbortSignal.timeout(5000) })).text();
        pins = /review\.js|director\.js|REVIEW_CONFIG/.test(html);
      } catch {
        pins = null;
      }
    }
    const warning =
      pins === false
        ? 'This page does not load the review layer, so it will show no Review pill. Add <script src="' +
          r.info.url +
          '/vc/review.js"></script> to it, or open it through a same-origin host page that injects it.'
        : pins === null
          ? 'Could not fetch the page to check it loads the review layer. Check the Review pill shows before you share the link.'
          : undefined;
    return out({
      ok: true,
      screen: name,
      url: u.toString(),
      pins,
      ...(warning ? { warning } : {}),
      vc: r.info.url + '/',
      wake: !!flags.wake,
      session: owner,
      review_js: r.info.url + '/vc/review.js',
      director_js: r.info.url + '/vc/director.js',
    });
  }
  if (sub === 'crop') {
    const r = await running(dir);
    const list = pos[1]
      ? [findNote(dir, pos[1], true)]
      : store
          .notes(readEvents(dir), flags.screen || null, shots)
          .filter((p) => p.kind !== 'note' && p.status === 'open');
    const own = (s) => fs.existsSync(path.join(dir, 'content', s + '.html'));
    const jobs = list
      .filter((p) => p.selector)
      .map((p) => ({
        // A fragment is cropped from the running server; a prototype from its own page.
        url: own(p.screen)
          ? r
            ? 'http://127.0.0.1:' +
              r.port +
              '/?shot&screen=' +
              encodeURIComponent(p.screen) +
              '&theme=' +
              (p.theme === 'dark' ? 'dark' : 'light')
            : null
          : p.page,
        frame: own(p.screen) ? undefined : p.frame,
        selector: p.selector,
        state: own(p.screen) ? null : p.state,
        viewport: p.viewport,
        out: store.cropPath(shots, p.screen, p.n),
        ref: p.screen + '#' + p.n,
      }))
      .filter((j) => j.url);
    if (!jobs.length) return out({ ok: true, crops: [] });
    const res = await require('./crop.cjs').crop(jobs);
    return out({
      ok: res.every((x) => x.ok),
      crops: jobs.map((j, i) => ({
        note: j.ref,
        file: res[i].ok ? j.out : null,
        error: res[i].error,
      })),
    });
  }
  fail(
    'usage: vc review list | resolve <n> "summary" | dismiss <n> "why" | open <url> --name S | crop [<n>]'
  );
}

main().catch((e) => fail(String(e && e.message ? e.message : e)));
