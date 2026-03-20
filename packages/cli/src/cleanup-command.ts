import { confirm } from '@inquirer/prompts';
import fs from 'fs';
import path from 'path';
import http from 'node:http';

/** Default server port — inlined to avoid @dorkos/shared dependency in CLI tests. */
const DEFAULT_PORT = 4242;

/** Known entries in ~/.dork/ with human-readable descriptions. */
const KNOWN_ENTRIES: Record<string, string> = {
  'config.json': 'user configuration',
  'dork.db': 'SQLite database',
  'dork.db-wal': 'SQLite write-ahead log',
  'dork.db-shm': 'SQLite shared memory',
  logs: 'server logs',
  relay: 'adapter state',
};

/** Options for the cleanup command. */
interface CleanupOptions {
  /** Path to ~/.dork directory */
  dorkHome: string;
}

/**
 * Read the configured port from config.json, falling back to the default.
 *
 * @param dorkHome - Path to the DorkOS data directory
 * @returns The configured server port
 */
function readPort(dorkHome: string): number {
  try {
    const raw = fs.readFileSync(path.join(dorkHome, 'config.json'), 'utf-8');
    const config = JSON.parse(raw);
    const port = config?.server?.port;
    if (typeof port === 'number' && port > 0) return port;
  } catch {
    // Config missing or malformed — use default
  }
  return DEFAULT_PORT;
}

/**
 * Check whether the DorkOS server is responding on the given port.
 *
 * @param port - Port to check
 * @returns True if the server is running
 */
function isServerRunning(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const req = http.get(`http://localhost:${port}/api/health`, { timeout: 1000 }, (res) => {
      res.resume(); // Drain the response
      resolve(res.statusCode === 200);
    });
    req.on('error', () => resolve(false));
    req.on('timeout', () => {
      req.destroy();
      resolve(false);
    });
  });
}

/**
 * Query the SQLite DB for distinct project paths that have agent data.
 *
 * @param dbPath - Path to dork.db
 * @returns Array of project paths with existing .dork/ directories
 */
async function findProjectPaths(dbPath: string): Promise<string[]> {
  try {
    const { default: Database } = await import('better-sqlite3');
    const db = new Database(dbPath, { readonly: true });
    try {
      const rows = db.prepare('SELECT DISTINCT project_path FROM agents').all() as Array<{
        project_path: string;
      }>;
      return rows.map((r) => r.project_path).filter((p) => fs.existsSync(path.join(p, '.dork')));
    } finally {
      db.close();
    }
  } catch {
    return [];
  }
}

/**
 * Run the interactive cleanup command to remove DorkOS data.
 *
 * @param options - Cleanup options including the data directory path
 */
export async function runCleanup(options: CleanupOptions): Promise<void> {
  const { dorkHome } = options;

  // Check if anything exists to clean
  if (!fs.existsSync(dorkHome)) {
    console.log('\nNo DorkOS data found. Nothing to clean up.\n');
    return;
  }

  // Check if server is running
  const port = readPort(dorkHome);
  if (await isServerRunning(port)) {
    console.log(`\nDorkOS server is running on port ${port}. Stop it before running cleanup.\n`);
    process.exitCode = 1;
    return;
  }

  console.log('\nDorkOS Cleanup\n');

  // Inventory global data
  const entries = fs.readdirSync(dorkHome);
  if (entries.length === 0) {
    console.log('No DorkOS data found. Nothing to clean up.\n');
    return;
  }

  console.log(`Global data (${dorkHome}):`);
  for (const entry of entries) {
    const description = KNOWN_ENTRIES[entry] ?? 'unknown';
    console.log(`  ${entry.padEnd(20)} (${description})`);
  }
  console.log('');

  // Discover per-project agent data before deleting DB
  const dbPath = path.join(dorkHome, 'dork.db');
  const projectPaths = fs.existsSync(dbPath) ? await findProjectPaths(dbPath) : [];

  // Phase 1: Global data removal
  const removeGlobal = await confirm({
    message: `Remove global DorkOS data (${dorkHome})?`,
    default: false,
  });

  if (!removeGlobal) {
    console.log('\n  Aborted.\n');
    return;
  }

  fs.rmSync(dorkHome, { recursive: true, force: true });
  console.log(`\n  Removed ${dorkHome}\n`);

  // Phase 2: Per-project data removal
  if (projectPaths.length > 0) {
    console.log(`Found ${projectPaths.length} project(s) with agent data:`);
    for (const p of projectPaths) {
      console.log(`  ${p}/.dork/`);
    }
    console.log('');

    const removeProjects = await confirm({
      message: 'Also remove per-project agent data?',
      default: false,
    });

    if (removeProjects) {
      for (const p of projectPaths) {
        const dorkDir = path.join(p, '.dork');
        fs.rmSync(dorkDir, { recursive: true, force: true });
        console.log(`  Removed ${dorkDir}`);
      }
      console.log('');
    } else {
      console.log('\n  Skipped per-project data.\n');
    }
  }

  // Safe notice
  console.log('Will NOT touch:');
  console.log('  ~/.claude/           (Claude Code — not managed by DorkOS)\n');
  console.log('To complete uninstall: npm uninstall -g dorkos\n');
}
