// Finds what the visual companion borrows from the machine it runs on: the
// DorkOS checkout (for the token and app CSS build), playwright-core and a
// Chromium (for screenshots and tests). Nothing here is hardcoded to one
// person's machine; each lookup has an env override and a clear failure.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const { createRequire } = require('module');

const SKILL_DIR = path.resolve(__dirname, '..');

// A DorkOS checkout is a directory holding both files the asset build reads.
const MARKERS = ['apps/client/src/index.css', 'packages/ui/tokens.css'];
const isDorkosRepo = (dir) => !!dir && MARKERS.every((m) => fs.existsSync(path.join(dir, m)));

/**
 * The DorkOS repo: `explicit` (a --dorkos flag), then $VC_DORKOS_REPO, then the
 * git checkout this skill lives in. Throws with what to set when none fits.
 */
function findDorkosRepo(explicit) {
  const tried = [];
  for (const [from, dir] of [
    ['--dorkos', explicit],
    ['VC_DORKOS_REPO', process.env.VC_DORKOS_REPO],
  ]) {
    if (!dir) continue;
    const abs = path.resolve(dir);
    if (isDorkosRepo(abs)) return abs;
    tried.push(from + '=' + abs);
  }
  try {
    const top = execFileSync('git', ['rev-parse', '--show-toplevel'], {
      cwd: fs.realpathSync(SKILL_DIR),
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    if (isDorkosRepo(top)) return top;
    tried.push('git checkout ' + top);
  } catch {
    tried.push('git (the skill is not inside a checkout)');
  }
  throw new Error(
    'Could not find the DorkOS repo (tried: ' +
      tried.join(', ') +
      '). ' +
      'Set VC_DORKOS_REPO to a DorkOS checkout, or pass --dorkos <path>.'
  );
}

function tryRequire(req, id) {
  try {
    return req(id);
  } catch {
    return null;
  }
}

/** playwright-core: $VC_PLAYWRIGHT, then one resolvable from here, then the DorkOS repo's e2e app. */
function findPlaywright() {
  if (process.env.VC_PLAYWRIGHT) {
    const pw = tryRequire(require, path.resolve(process.env.VC_PLAYWRIGHT));
    if (pw) return pw;
  }
  const here = tryRequire(require, 'playwright-core');
  if (here) return here;
  let repo;
  try {
    repo = findDorkosRepo();
  } catch {
    return null;
  }
  for (const pkg of ['apps/e2e/package.json', 'package.json']) {
    const file = path.join(repo, pkg);
    if (!fs.existsSync(file)) continue;
    const req = createRequire(file);
    const direct = tryRequire(req, 'playwright-core');
    if (direct) return direct;
    // @playwright/test depends on playwright-core; resolve it from there.
    try {
      const pwt = path.dirname(req.resolve('@playwright/test/package.json'));
      const viaTest = tryRequire(createRequire(path.join(pwt, 'package.json')), 'playwright-core');
      if (viaTest) return viaTest;
    } catch {
      // Best effort: nothing to do if this fails.
    }
  }
  return null;
}

// Where `playwright install` puts browsers, per platform.
function playwrightCache() {
  if (process.env.PLAYWRIGHT_BROWSERS_PATH && process.env.PLAYWRIGHT_BROWSERS_PATH !== '0')
    return process.env.PLAYWRIGHT_BROWSERS_PATH;
  if (process.platform === 'darwin') return path.join(os.homedir(), 'Library/Caches/ms-playwright');
  if (process.platform === 'win32')
    return path.join(
      process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData/Local'),
      'ms-playwright'
    );
  return path.join(os.homedir(), '.cache/ms-playwright');
}

// Executables inside one ms-playwright browser directory, newest layouts first.
const CACHE_LAYOUTS = [
  'chrome-headless-shell-mac-arm64/chrome-headless-shell',
  'chrome-headless-shell-mac-x64/chrome-headless-shell',
  'chrome-headless-shell-linux64/chrome-headless-shell',
  'chrome-headless-shell-win64/chrome-headless-shell.exe',
  'chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing',
  'chrome-mac/Chromium.app/Contents/MacOS/Chromium',
  'chrome-linux64/chrome',
  'chrome-linux/chrome',
  'chrome-win64/chrome.exe',
  'chrome-win/chrome.exe',
];

const SYSTEM_CHROME = {
  darwin: [
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/Chromium.app/Contents/MacOS/Chromium',
  ],
  linux: [
    '/usr/bin/google-chrome',
    '/usr/bin/google-chrome-stable',
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
  ],
  win32: [
    path.join(
      process.env.PROGRAMFILES || 'C:/Program Files',
      'Google/Chrome/Application/chrome.exe'
    ),
    path.join(
      process.env['PROGRAMFILES(X86)'] || 'C:/Program Files (x86)',
      'Google/Chrome/Application/chrome.exe'
    ),
  ],
};

/**
 * A Chromium to drive: $VC_CHROME, then the browser playwright-core expects,
 * then any Chromium in Playwright's cache, then a system Chrome. Returns
 * undefined when none exists; see CHROME_HELP for the message to show.
 */
function findChrome(pw) {
  if (process.env.VC_CHROME)
    return fs.existsSync(process.env.VC_CHROME) ? process.env.VC_CHROME : undefined;
  try {
    const own = (pw || findPlaywright())?.chromium.executablePath();
    if (own && fs.existsSync(own)) return own;
  } catch {
    // Best effort: nothing to do if this fails.
  }
  const cache = playwrightCache();
  if (fs.existsSync(cache)) {
    const dirs = fs
      .readdirSync(cache)
      .filter((d) => /^chromium(_headless_shell)?-\d+$/.test(d))
      .sort((a, b) => Number(b.split('-').pop()) - Number(a.split('-').pop()));
    for (const d of dirs) {
      for (const rel of CACHE_LAYOUTS) {
        const exe = path.join(cache, d, rel);
        if (fs.existsSync(exe)) return exe;
      }
    }
  }
  return (SYSTEM_CHROME[process.platform] || []).find((p) => fs.existsSync(p));
}

const PLAYWRIGHT_HELP =
  'playwright-core not found. Run pnpm install in the DorkOS repo, or set VC_PLAYWRIGHT to a playwright-core directory.';
const CHROME_HELP =
  'No Chromium found. Set VC_CHROME to a Chrome or Chromium executable, or run `pnpm --filter @dorkos/e2e exec playwright install chromium` in the DorkOS repo.';

module.exports = {
  SKILL_DIR,
  findDorkosRepo,
  findPlaywright,
  findChrome,
  PLAYWRIGHT_HELP,
  CHROME_HELP,
};
