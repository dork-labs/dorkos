import { parseArgs } from 'node:util';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';
import fs from 'fs';
import { checkClaude } from './check-claude.js';
import { DEFAULT_PORT } from '@dorkos/shared/constants';

// Injected at build time by esbuild define
declare const __CLI_VERSION__: string;

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const { values, positionals } = parseArgs({
  options: {
    port: { type: 'string', short: 'p' },
    tunnel: { type: 'boolean', short: 't', default: false },
    dir: { type: 'string', short: 'd' },
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
  -p, --port <port>  Port to listen on (default: ${DEFAULT_PORT})
  -t, --tunnel       Enable ngrok tunnel
  -d, --dir <path>   Working directory (default: current directory)
  -h, --help         Show this help message
  -v, --version      Show version number

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
process.env.DORK_HOME = DORK_HOME;

// Handle subcommands that don't need the full server
const subcommand = positionals[0];

if (subcommand === 'config') {
  const { initConfigManager } = await import('../server/services/config-manager.js');
  const cfgMgr = initConfigManager(DORK_HOME);
  const { handleConfigCommand } = await import('./config-commands.js');
  handleConfigCommand(cfgMgr, positionals.slice(1));
  process.exit(0);
}

if (subcommand === 'init') {
  const { initConfigManager } = await import('../server/services/config-manager.js');
  const cfgMgr = initConfigManager(DORK_HOME);
  const { runInitWizard } = await import('./init-wizard.js');
  await runInitWizard({ yes: values.yes!, dorkHome: DORK_HOME, store: cfgMgr });
  process.exit(0);
}

// Check for Claude CLI (only needed for server startup)
checkClaude();

// Initialize config manager for precedence merge
const { initConfigManager } = await import('../server/services/config-manager.js');
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

// Working directory: CLI flag > env var > config > cwd
const cliDir = values.dir;
if (cliDir) {
  process.env.DORKOS_DEFAULT_CWD = path.resolve(cliDir);
} else if (!process.env.DORKOS_DEFAULT_CWD) {
  const configCwd = cfgMgr.getDot('server.cwd') as string | null;
  process.env.DORKOS_DEFAULT_CWD = configCwd ? path.resolve(configCwd) : process.cwd();
}

const resolvedDir = process.env.DORKOS_DEFAULT_CWD!;

// Load .env from user's cwd (project-local, optional)
const envPath = path.join(resolvedDir, '.env');
if (fs.existsSync(envPath)) {
  const dotenv = await import('dotenv');
  dotenv.config({ path: envPath });
}

// Start the server
await import('../server/index.js');
