// Shared test helpers: run vc in a throwaway project, drive headless Chromium.
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { spawnSync } = require('child_process');

const {
  SKILL_DIR: SKILL,
  findDorkosRepo,
  findPlaywright,
  findChrome,
  PLAYWRIGHT_HELP,
  CHROME_HELP,
} = require('../scripts/locate.cjs');
const VC = path.join(SKILL, 'scripts/vc.cjs');
const pw = findPlaywright();
const CHROME = findChrome(pw);
if (!pw || !CHROME) {
  console.error(pw ? CHROME_HELP : PLAYWRIGHT_HELP);
  process.exit(1);
}
// axe-core for the accessibility checks, from the DorkOS repo's install.
const AXE = (() => {
  try {
    const base = path.join(findDorkosRepo(), 'node_modules/.pnpm');
    const d = fs.existsSync(base) && fs.readdirSync(base).find((x) => x.startsWith('axe-core@'));
    return d ? path.join(base, d, 'node_modules/axe-core/axe.min.js') : null;
  } catch {
    return null;
  }
})();

// Test ports sit in their own band, so a real session on a free port rarely meets one.
let nextPort = 8800 + Math.floor(Math.random() * 40) * 5;
function port() {
  return (nextPort += 5);
}

// Every throwaway project is remembered, so stopAll() (and process exit) stops
// its server even if a test forgot to register it.
const made = new Set();
function project() {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'vc-test-'));
  made.add(d);
  return d;
}
process.on('exit', () => {
  for (const d of made) {
    try {
      const info = JSON.parse(
        fs.readFileSync(
          fs
            .readdirSync(path.join(d, '.dork/visual-companion'))
            .filter((x) => x !== 'current')
            .map((x) => path.join(d, '.dork/visual-companion', x, 'state/server-info'))[0],
          'utf8'
        )
      );
      process.kill(info.pid, 'SIGTERM');
    } catch {
      // Best effort: nothing to do if this fails.
    }
  }
});

function vc(dir, args, opts = {}) {
  const r = spawnSync(process.execPath, [VC, ...args, '--project-dir', dir], {
    encoding: 'utf8',
    input: opts.input,
    // Never wake the real chat running these tests: no session, DorkOS port 1.
    env: {
      ...process.env,
      CLAUDE_CODE_SESSION_ID: '',
      DORKOS_SESSION_ID: '',
      DORKOS_PORT: '1',
      ...(opts.env || {}),
    },
    timeout: 30000,
  });
  if (opts.raw) return r;
  const line = (r.stdout || '').trim().split('\n').pop();
  try {
    return JSON.parse(line);
  } catch (e) {
    throw new Error('vc ' + args.join(' ') + ' → ' + r.stdout + r.stderr, { cause: e });
  }
}

function write(dir, name, html) {
  const f = path.join(dir, name);
  fs.writeFileSync(f, html);
  return f;
}

const screen = (title, extra = '') =>
  `<h2>${title}</h2><p class="subtitle">${title} subtitle</p>${extra}`;
const OPTIONS = `<div class="options">
  <div class="option" data-choice="a" onclick="toggleSelect(this)"><div class="letter">A</div><div class="content"><h3>Quiet</h3><p>Less.</p></div></div>
  <div class="option" data-choice="b" onclick="toggleSelect(this)"><div class="letter">B</div><div class="content"><h3>Busy</h3><p>More.</p></div></div>
</div>`;

async function browser() {
  return pw.chromium.launch({ executablePath: CHROME, headless: true });
}

// Collects console errors and page errors for a page.
function watchErrors(page) {
  const errors = [];
  page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
  page.on('pageerror', (e) => errors.push(String(e)));
  return errors;
}

function events(dir) {
  const s = vc(dir, ['status']);
  const f = path.join(s.state_dir || path.join(s.session_dir, 'state'), 'events');
  if (!fs.existsSync(f)) return [];
  return fs
    .readFileSync(f, 'utf8')
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l));
}

async function waitFor(fn, ms = 5000, step = 50, label = '') {
  const t0 = Date.now();
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() - t0 > ms)
      throw new Error('timed out after ' + ms + 'ms' + (label ? ': ' + label : ''));
    await new Promise((r) => setTimeout(r, step));
  }
}

function stopAll(dirs) {
  for (const d of new Set([...dirs, ...made])) {
    try {
      vc(d, ['stop']);
    } catch {
      // Best effort: nothing to do if this fails.
    }
  }
}

function listen(handler, p) {
  return new Promise((resolve) => {
    const s = http.createServer(handler);
    s.listen(p || 0, '127.0.0.1', () => resolve(s));
  });
}

module.exports = {
  SKILL,
  VC,
  pw,
  AXE,
  port,
  project,
  vc,
  write,
  screen,
  OPTIONS,
  browser,
  watchErrors,
  events,
  waitFor,
  stopAll,
  listen,
  findChrome,
};
