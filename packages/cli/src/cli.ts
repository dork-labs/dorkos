import { parseArgs } from 'node:util';
import os, { networkInterfaces } from 'os';
import path from 'path';
import { fileURLToPath } from 'url';
import fs from 'fs';
import { checkClaude } from './check-claude.js';
import { checkForUpdate } from './update-check.js';
import { link } from './terminal-link.js';
import { DEFAULT_PORT } from '@dorkos/shared/constants';
import { LOG_LEVEL_MAP } from '@dorkos/shared/config-schema';
import { env } from './env.js';
import { checkNodeVersion, diagnoseStartupError, formatDiagnostic } from './startup-diagnostics.js';

// Early Node.js version guard — before any imports that could fail on older runtimes
const nodeVersionIssue = checkNodeVersion();
if (nodeVersionIssue) {
  console.error(formatDiagnostic(nodeVersionIssue));
  process.exit(1);
}

// Injected at build time by esbuild define
declare const __CLI_VERSION__: string;

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// `package` subcommand has its own flag namespace (`--type`, `--parent-dir`, etc.).
// Intercept before the top-level parseArgs call so those flags aren't rejected as
// unknown options by the strict top-level parser. Package commands don't need the
// ~/.dork directory or the server runtime, so they exit before any further setup.
if (process.argv[2] === 'package') {
  const packageSubcommand = process.argv[3];
  const subArgs = process.argv.slice(4);
  if (packageSubcommand === 'init') {
    const { runPackageInit, parsePackageInitArgs } = await import('./package-init-command.js');
    await runPackageInit(parsePackageInitArgs(subArgs));
    process.exit(0);
  }
  if (packageSubcommand === 'validate') {
    const { runPackageValidate } = await import('./package-validate-command.js');
    const packagePath = subArgs[0];
    const exitCode = await runPackageValidate({ packagePath });
    process.exit(exitCode);
  }
  console.error(`Unknown package subcommand: ${packageSubcommand ?? '<none>'}`);
  console.error('Usage: dorkos package <init|validate> [args]');
  process.exit(1);
}

let values: ReturnType<typeof parseArgs>['values'];
let positionals: ReturnType<typeof parseArgs>['positionals'];

try {
  ({ values, positionals } = parseArgs({
    options: {
      port: { type: 'string', short: 'p' },
      tunnel: { type: 'boolean', short: 't', default: false },
      dir: { type: 'string', short: 'd' },
      boundary: { type: 'string', short: 'b' },
      tasks: { type: 'boolean' },
      open: { type: 'boolean' },
      'log-level': { type: 'string', short: 'l' },
      help: { type: 'boolean', short: 'h' },
      version: { type: 'boolean', short: 'v' },
      'post-install-check': { type: 'boolean', default: false },
      yes: { type: 'boolean', short: 'y', default: false },
    },
    allowPositionals: true,
    allowNegative: true,
  }));
} catch (err) {
  if (
    err instanceof TypeError &&
    (err as NodeJS.ErrnoException).code === 'ERR_PARSE_ARGS_UNKNOWN_OPTION'
  ) {
    const match = err.message.match(/Unknown option '([^']+)'/);
    const option = match?.[1] ?? 'unknown';
    console.error(`Unknown option: ${option}`);
    console.error(`Run 'dorkos --help' for usage information.`);
    process.exit(1);
  }
  throw err;
}

if (values.help) {
  console.log(`
Usage: dorkos [command] [options]

Web-based interface and REST/SSE API for Claude Code

Commands:
  config               Show all effective settings
  config get <key>     Get a single config value
  config set <key> <v> Set a single config value
  config list          Full JSON output
  config reset [key]   Reset to defaults
  config edit          Open in $EDITOR
  config path          Print config file location
  config validate      Check config validity
  init                 Interactive setup wizard
  init --yes           Accept all defaults
  package init <name>  Scaffold a new marketplace package
  package validate [p] Validate a marketplace package
  cleanup              Remove all DorkOS data

Options:
  -p, --port <port>      Port to listen on (default: ${DEFAULT_PORT})
  -t, --tunnel           Enable ngrok tunnel
  -d, --dir <path>       Working directory (default: current directory)
  -b, --boundary <path>  Directory boundary (default: home directory)
      --tasks              Enable Tasks scheduler
      --no-tasks           Disable Tasks scheduler
      --no-open            Don't open browser on startup
  -l, --log-level <level>  Log level (fatal|error|warn|info|debug|trace)
      --post-install-check  Verify installation and exit
  -h, --help             Show this help message
  -v, --version          Show version number

Environment:
  NGROK_AUTHTOKEN    ngrok auth token (required for --tunnel)
  TUNNEL_AUTH        HTTP basic auth for tunnel (user:pass)
  TUNNEL_DOMAIN      Custom ngrok domain

Config file: ~/.dork/config.json

Examples:
  dorkos
  dorkos --tunnel
  dorkos --port 8080 --dir ~/projects/myapp
  dorkos config set server.port 8080
  dorkos init
`);
  process.exit(0);
}

if (values.version) {
  console.log(__CLI_VERSION__);
  process.exit(0);
}

if (values['post-install-check']) {
  const claudeFound = checkClaude();
  console.log(`dorkos ${__CLI_VERSION__}`);
  if (claudeFound) {
    console.log('Installation verified.');
  } else {
    console.log('Installation incomplete — Claude Code CLI is missing.');
    process.exit(1);
  }
  process.exit(0);
}

// Resolve data directory: explicit env var > ~/.dork (CLI always runs in production mode)
const DORK_HOME = env.DORK_HOME || path.join(os.homedir(), '.dork');

// Handle cleanup before creating directories — cleanup should see existing state, not dirs we just created
const subcommand = positionals[0];

if (subcommand === 'cleanup') {
  const { runCleanup } = await import('./cleanup-command.js');
  await runCleanup({ dorkHome: DORK_HOME });
  process.exit(process.exitCode ?? 0);
}

// Ensure data directories exist for all other commands
fs.mkdirSync(DORK_HOME, { recursive: true });
fs.mkdirSync(path.join(DORK_HOME, 'logs'), { recursive: true });
process.env.DORK_HOME = DORK_HOME;

if (subcommand === 'config') {
  const { initConfigManager } = await import('../server/services/core/config-manager.js');
  const cfgMgr = initConfigManager(DORK_HOME);
  const { handleConfigCommand } = await import('./config-commands.js');
  handleConfigCommand(cfgMgr, positionals.slice(1));
  process.exit(0);
}

if (subcommand === 'init') {
  const { initConfigManager } = await import('../server/services/core/config-manager.js');
  const cfgMgr = initConfigManager(DORK_HOME);
  const { runInitWizard } = await import('./init-wizard.js');
  await runInitWizard({ yes: values.yes!, dorkHome: DORK_HOME, store: cfgMgr });
  process.exit(0);
}

// Check for Claude CLI (only needed for server startup)
checkClaude();

// Initialize config manager for precedence merge
const { initConfigManager } = await import('../server/services/core/config-manager.js');
const cfgMgr = initConfigManager(DORK_HOME);

if (cfgMgr.isFirstRun) {
  console.log(`Created config at ${cfgMgr.path}`);
}

// Precedence: CLI flags > env vars > config.json > defaults
const cliPort = values.port;
if (cliPort) {
  process.env.DORKOS_PORT = cliPort;
} else if (!process.env.DORKOS_PORT) {
  const configPort = cfgMgr.getDot('server.port');
  process.env.DORKOS_PORT = configPort ? String(configPort) : String(DEFAULT_PORT);
}

process.env.NODE_ENV = 'production';
process.env.CLIENT_DIST_PATH = path.join(__dirname, '../client');

// Tunnel: CLI flag > env var > config
if (values.tunnel) {
  process.env.TUNNEL_ENABLED = 'true';
} else if (!process.env.TUNNEL_ENABLED && cfgMgr.getDot('tunnel.enabled')) {
  process.env.TUNNEL_ENABLED = 'true';
}

// Tunnel config values as fallback (config < env)
const tunnelAuthtoken = cfgMgr.getDot('tunnel.authtoken') as string | null;
if (tunnelAuthtoken && !process.env.NGROK_AUTHTOKEN) {
  process.env.NGROK_AUTHTOKEN = tunnelAuthtoken;
}
const tunnelAuth = cfgMgr.getDot('tunnel.auth') as string | null;
if (tunnelAuth && !process.env.TUNNEL_AUTH) {
  process.env.TUNNEL_AUTH = tunnelAuth;
}
const tunnelDomain = cfgMgr.getDot('tunnel.domain') as string | null;
if (tunnelDomain && !process.env.TUNNEL_DOMAIN) {
  process.env.TUNNEL_DOMAIN = tunnelDomain;
}

// Tasks scheduler: CLI flag > env var > config
if (values.tasks !== undefined) {
  process.env.DORKOS_TASKS_ENABLED = values.tasks ? 'true' : 'false';
} else if (!process.env.DORKOS_TASKS_ENABLED && cfgMgr.getDot('scheduler.enabled')) {
  process.env.DORKOS_TASKS_ENABLED = 'true';
}

// Browser open: CLI flag > env var > config > default (true)
// node:util parseArgs treats --no-open as open=false, --open as open=true
let shouldOpenBrowser = true;
if (values.open !== undefined) {
  shouldOpenBrowser = Boolean(values.open);
} else if (process.env.DORKOS_OPEN !== undefined) {
  shouldOpenBrowser = process.env.DORKOS_OPEN !== 'false' && process.env.DORKOS_OPEN !== '0';
} else {
  const configOpen = cfgMgr.getDot('server.open');
  if (configOpen !== undefined && configOpen !== null) {
    shouldOpenBrowser = Boolean(configOpen);
  }
}

// Relay: env var > config (no CLI flag for relay)
if (!process.env.DORKOS_RELAY_ENABLED && cfgMgr.getDot('relay.enabled')) {
  process.env.DORKOS_RELAY_ENABLED = 'true';
}

// Working directory: CLI flag > env var > config > cwd
const cliDir = values.dir;
if (cliDir) {
  process.env.DORKOS_DEFAULT_CWD = path.resolve(cliDir);
} else if (!process.env.DORKOS_DEFAULT_CWD) {
  const configCwd = cfgMgr.getDot('server.cwd') as string | null;
  process.env.DORKOS_DEFAULT_CWD = configCwd ? path.resolve(configCwd) : process.cwd();
}

// Boundary: CLI flag > env var > config > os.homedir()
const cliBoundary = values.boundary;
if (cliBoundary) {
  process.env.DORKOS_BOUNDARY = path.resolve(cliBoundary);
} else if (!process.env.DORKOS_BOUNDARY) {
  const configBoundary = cfgMgr.getDot('server.boundary') as string | null;
  if (configBoundary) {
    process.env.DORKOS_BOUNDARY = path.resolve(configBoundary);
  }
  // If still not set, server will default to os.homedir() in initBoundary()
}

// Warn if boundary is above home directory
const boundaryVal = process.env.DORKOS_BOUNDARY;
const home = os.homedir();
if (boundaryVal && !boundaryVal.startsWith(home + path.sep) && boundaryVal !== home) {
  console.warn(
    `[Warning] Directory boundary "${boundaryVal}" is above home directory "${home}". ` +
      `This grants access to system directories.`
  );
}

// Validate default CWD is within boundary
const effectiveBoundary = process.env.DORKOS_BOUNDARY || home;
const resolvedDir = process.env.DORKOS_DEFAULT_CWD!;
if (resolvedDir !== effectiveBoundary && !resolvedDir.startsWith(effectiveBoundary + path.sep)) {
  console.warn(
    `[Warning] Default CWD "${resolvedDir}" is outside boundary "${effectiveBoundary}". ` +
      `Falling back to boundary root.`
  );
  process.env.DORKOS_DEFAULT_CWD = effectiveBoundary;
}

// Log level: CLI flag > env var > config > default
const logLevelName =
  values['log-level'] ||
  env.LOG_LEVEL ||
  (cfgMgr.getDot('logging.level') as string | null) ||
  (env.NODE_ENV === 'production' ? 'info' : 'debug');
process.env.DORKOS_LOG_LEVEL = String(LOG_LEVEL_MAP[logLevelName] ?? 3);

// Load .env from user's cwd (project-local, optional).
// override:false (the default) ensures CLI flags and config values set above
// are never overwritten by .env file values — preserving the precedence chain.
const envPath = path.join(process.env.DORKOS_DEFAULT_CWD!, '.env');
if (fs.existsSync(envPath)) {
  const dotenv = await import('dotenv');
  dotenv.config({ path: envPath, override: false });
}

// Start the server — wrap import to catch dependency and startup errors
try {
  await import('../server/index.js');
} catch (err) {
  const diag = diagnoseStartupError(err);
  console.error(formatDiagnostic(diag));
  process.exit(1);
}

// Print startup banner
const port = process.env.DORKOS_PORT || String(DEFAULT_PORT);
const localUrl = `http://localhost:${port}`;
const logo = [
  '  ██████╗  ██████╗ ██████╗ ██╗  ██╗',
  '  ██╔══██╗██╔═══██╗██╔══██╗██║ ██╔╝',
  '  ██║  ██║██║   ██║██████╔╝█████╔╝ ',
  '  ██║  ██║██║   ██║██╔══██╗██╔═██╗ ',
  '  ██████╔╝╚██████╔╝██║  ██║██║  ██╗',
  '  ╚═════╝  ╚═════╝ ╚═╝  ╚═╝╚═╝  ╚═╝',
].join('\n');
const purple = '\x1b[35m';
const ansiReset = '\x1b[0m';
console.log('');
console.log(`${purple}${logo}${ansiReset}`);
console.log('');
console.log(`  DorkOS v${__CLI_VERSION__}`);
console.log(`  Local:   ${link(localUrl, localUrl)}`);

// Find first non-internal IPv4 address
const nets = networkInterfaces();
let networkUrl: string | null = null;
for (const name of Object.keys(nets)) {
  for (const net of nets[name] ?? []) {
    if (net.family === 'IPv4' && !net.internal) {
      networkUrl = `http://${net.address}:${port}`;
      break;
    }
  }
  if (networkUrl) break;
}
if (networkUrl) {
  console.log(`  Network: ${link(networkUrl, networkUrl)}`);
}

// Print tunnel URL if tunnel started during server init
if (process.env.TUNNEL_ENABLED) {
  const { tunnelManager } = await import('../server/services/core/tunnel-manager.js');
  const status = tunnelManager.status;
  if (status.connected && status.url) {
    console.log(`  Tunnel:  ${link(status.url, status.url)}`);

    // Print QR code for mobile access
    try {
      const qrcode = await import('qrcode-terminal');
      const generate = qrcode.default?.generate ?? qrcode.generate;
      console.log('');
      console.log('  Scan to open on mobile:');
      generate(status.url, { small: true }, (code: string) => {
        // Indent each line of the QR code
        const indented = code
          .split('\n')
          .map((line: string) => `  ${line}`)
          .join('\n');
        console.log(indented);
      });
    } catch {
      // qrcode-terminal not available — skip QR code
    }
  }
}
console.log('');

// Open browser automatically (skipped in non-TTY or when --no-open)
if (shouldOpenBrowser && process.stdin.isTTY) {
  const { exec } = await import('node:child_process');
  const openCmd =
    process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'start' : 'xdg-open';
  exec(`${openCmd} ${localUrl}`);
}

// Listen for runtime tunnel activation (toggled on via UI after startup)
{
  const { tunnelManager } = await import('../server/services/core/tunnel-manager.js');
  tunnelManager.on('status_change', async (status: { connected: boolean; url: string | null }) => {
    if (status.connected && status.url) {
      console.log('');
      console.log(`  Tunnel:  ${link(status.url, status.url)}`);
      try {
        const qrcode = await import('qrcode-terminal');
        const generate = qrcode.default?.generate ?? qrcode.generate;
        console.log('');
        console.log('  Scan to open on mobile:');
        generate(status.url, { small: true }, (code: string) => {
          const indented = code
            .split('\n')
            .map((line: string) => `  ${line}`)
            .join('\n');
          console.log(indented);
        });
      } catch {
        // qrcode-terminal not available — skip QR code
      }
      console.log('');
    }
  });
}

// Non-blocking update check (fire-and-forget)
checkForUpdate(__CLI_VERSION__)
  .then((latestVersion) => {
    if (latestVersion) {
      const msg = `Update available: ${__CLI_VERSION__} → ${latestVersion}`;
      const cmd = 'Run npm install -g dorkos@latest to update';
      const width = Math.max(msg.length, cmd.length) + 6;
      const pad = (s: string) => `│   ${s}${' '.repeat(width - s.length - 6)}   │`;
      console.log('');
      console.log(`┌${'─'.repeat(width - 2)}┐`);
      console.log(pad(msg));
      console.log(pad(cmd));
      console.log(`└${'─'.repeat(width - 2)}┘`);
      console.log('');
    }
  })
  .catch(() => {
    // Silently ignore — never interrupt server
  });
