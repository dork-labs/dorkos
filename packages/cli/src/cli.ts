import { parseArgs } from 'node:util';
import path from 'path';
import { fileURLToPath } from 'url';
import fs from 'fs';
import { checkClaude } from './check-claude.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const { values } = parseArgs({
  options: {
    port:    { type: 'string',  short: 'p', default: '6942' },
    tunnel:  { type: 'boolean', short: 't', default: false },
    dir:     { type: 'string',  short: 'd', default: process.cwd() },
    help:    { type: 'boolean', short: 'h' },
    version: { type: 'boolean', short: 'v' },
  },
  allowPositionals: false,
});

if (values.help) {
  console.log(`
Usage: lifeos-gateway [options]

Web-based interface and REST/SSE API for Claude Code

Options:
  -p, --port <port>  Port to listen on (default: 6942)
  -t, --tunnel       Enable ngrok tunnel
  -d, --dir <path>   Working directory (default: current directory)
  -h, --help         Show this help message
  -v, --version      Show version number

Environment:
  NGROK_AUTHTOKEN    ngrok auth token (required for --tunnel)
  TUNNEL_AUTH        HTTP basic auth for tunnel (user:pass)
  TUNNEL_DOMAIN      Custom ngrok domain

Examples:
  lifeos-gateway
  lifeos-gateway --tunnel
  lifeos-gateway --port 8080 --dir ~/projects/myapp
`);
  process.exit(0);
}

if (values.version) {
  const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, '../../package.json'), 'utf-8'));
  console.log(pkg.version);
  process.exit(0);
}

// Check for Claude CLI
checkClaude();

// Set environment variables the server reads
process.env.GATEWAY_PORT = values.port;
process.env.NODE_ENV = 'production';
process.env.CLIENT_DIST_PATH = path.join(__dirname, '../client');

if (values.tunnel) process.env.TUNNEL_ENABLED = 'true';

const resolvedDir = path.resolve(values.dir!);
process.env.GATEWAY_CWD = resolvedDir;

// Load .env from user's cwd (project-local, optional)
const envPath = path.join(resolvedDir, '.env');
if (fs.existsSync(envPath)) {
  const dotenv = await import('dotenv');
  dotenv.config({ path: envPath });
}

// Start the server
await import('../server/index.js');
