import { parseArgs } from 'node:util';
import os, { networkInterfaces } from 'os';
import path from 'path';
import { fileURLToPath } from 'url';
import fs from 'fs';
import { checkClaude } from './check-claude.js';
import { checkForUpdate } from './update-check.js';
import { DEFAULT_PORT } from '@dorkos/shared/constants';
import { LOG_LEVEL_MAP } from '@dorkos/shared/config-schema';

// Injected at build time by esbuild define
declare const __CLI_VERSION__: string;

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const { values, positionals } = parseArgs({
  options: {
    port: { type: 'string', short: 'p' },
    tunnel: { type: 'boolean', short: 't', default: false },
    dir: { type: 'string', short: 'd' },
    boundary: { type: 'string', short: 'b' },
    pulse: { type: 'boolean' },
    'log-level': { type: 'string', short: 'l' },
    help: { type: 'boolean', short: 'h' },
    version: { type: 'boolean', short: 'v' },
    yes: { type: 'boolean', short: 'y', default: false },
  },
  allowPositionals: true,
});

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

Options:
  -p, --port <port>      Port to listen on (default: ${DEFAULT_PORT})
  -t, --tunnel           Enable ngrok tunnel
  -d, --dir <path>       Working directory (default: current directory)
  -b, --boundary <path>  Directory boundary (default: home directory)
      --pulse              Enable Pulse scheduler
      --no-pulse           Disable Pulse scheduler
  -l, --log-level <level>  Log level (fatal|error|warn|info|debug|trace)
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

// Ensure ~/.dork config directory exists
const DORK_HOME = path.join(os.homedir(), '.dork');
fs.mkdirSync(DORK_HOME, { recursive: true });
fs.mkdirSync(path.join(DORK_HOME, 'logs'), { recursive: true });
process.env.DORK_HOME = DORK_HOME;

// Handle subcommands that don't need the full server
const subcommand = positionals[0];

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

// Pulse scheduler: CLI flag > env var > config
if (values.pulse !== undefined) {
  process.env.DORKOS_PULSE_ENABLED = values.pulse ? 'true' : 'false';
} else if (!process.env.DORKOS_PULSE_ENABLED && cfgMgr.getDot('scheduler.enabled')) {
  process.env.DORKOS_PULSE_ENABLED = 'true';
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
const logLevelName = values['log-level']
  || process.env.LOG_LEVEL
  || (cfgMgr.getDot('logging.level') as string | null)
  || (process.env.NODE_ENV === 'production' ? 'info' : 'debug');
process.env.DORKOS_LOG_LEVEL = String(LOG_LEVEL_MAP[logLevelName] ?? 3);

// Load .env from user's cwd (project-local, optional)
// Re-read env var in case CWD was overridden by boundary fallback above
const envPath = path.join(process.env.DORKOS_DEFAULT_CWD!, '.env');
if (fs.existsSync(envPath)) {
  const dotenv = await import('dotenv');
  dotenv.config({ path: envPath });
}

// Start the server
await import('../server/index.js');

// Print startup banner
const port = process.env.DORKOS_PORT || String(DEFAULT_PORT);
console.log('');
console.log(`  DorkOS v${__CLI_VERSION__}`);
console.log(`  Local:   http://localhost:${port}`);

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
  console.log(`  Network: ${networkUrl}`);
}
console.log('');

// Non-blocking update check (fire-and-forget)
checkForUpdate(__CLI_VERSION__).then((latestVersion) => {
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
}).catch(() => {
  // Silently ignore — never interrupt server
});
