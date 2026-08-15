/**
 * Startup error diagnostics — classifies fatal errors and returns
 * actionable messages so users can self-resolve common issues.
 *
 * @module cli/startup-diagnostics
 */
import os from 'os';

/** Minimum Node.js major version required by DorkOS. */
export const MIN_NODE_MAJOR = 20;

/** Structured diagnostic result with category and human-readable guidance. */
export interface Diagnostic {
  /** Error category for telemetry/logging. */
  category:
    | 'sdk-mismatch'
    | 'module-not-found'
    | 'port-conflict'
    | 'permission-denied'
    | 'db-error'
    | 'config-error'
    | 'node-version'
    | 'unknown';
  /** Short summary of what went wrong. */
  headline: string;
  /** Detailed explanation with context. */
  detail: string;
  /** Concrete steps the user can take to fix the issue. */
  fix: string;
}

/**
 * Check if the Node.js version meets the minimum requirement.
 *
 * Call this early in the CLI entry point — before any imports that could
 * fail on older runtimes. Returns null if the version is acceptable.
 */
export function checkNodeVersion(): Diagnostic | null {
  const major = parseInt(process.versions.node.split('.')[0], 10);
  if (major < MIN_NODE_MAJOR) {
    return {
      category: 'node-version',
      headline: `Node.js ${process.versions.node} is not supported`,
      detail: `DorkOS requires Node.js ${MIN_NODE_MAJOR} or later. You are running ${process.versions.node}.`,
      fix: [
        `Upgrade Node.js to v${MIN_NODE_MAJOR}+ (LTS recommended):`,
        `  nvm install --lts   # if using nvm`,
        `  brew install node    # if using Homebrew`,
        `  https://nodejs.org   # manual download`,
      ].join('\n'),
    };
  }
  return null;
}

/**
 * Classify a startup error and return a human-readable diagnostic.
 *
 * Inspects error type, message, and code to identify common failure modes
 * and suggest concrete fixes. Unknown errors get a generic diagnostic
 * with the original message preserved.
 */
export function diagnoseStartupError(err: unknown): Diagnostic {
  const msg = err instanceof Error ? err.message : String(err);
  const code = (err as NodeJS.ErrnoException)?.code;

  // 1. SDK version mismatch — missing or renamed exports
  if (
    msg.includes('does not provide an export named') ||
    msg.includes('is not a function') ||
    (msg.includes('Cannot find module') && msg.includes('claude-agent-sdk'))
  ) {
    const missingExport = msg.match(/export named '(\w+)'/)?.[1];
    return {
      category: 'sdk-mismatch',
      headline: 'Claude Agent SDK version mismatch',
      detail: missingExport
        ? `This version of DorkOS requires a newer Claude Agent SDK (missing export: ${missingExport}).`
        : `The installed Claude Agent SDK is incompatible with this version of DorkOS.`,
      fix: [
        'Update DorkOS and the SDK together:',
        '  npm install -g dorkos@latest',
        '',
        'If you installed from source:',
        '  pnpm install   # updates all workspace dependencies',
      ].join('\n'),
    };
  }

  // 2. Missing dependency — MODULE_NOT_FOUND
  if (code === 'MODULE_NOT_FOUND' || msg.includes('Cannot find module')) {
    const modMatch = msg.match(/Cannot find module '([^']+)'/);
    const modName = modMatch?.[1] ?? 'unknown';
    return {
      category: 'module-not-found',
      headline: `Missing dependency: ${modName}`,
      detail: `A required module could not be found. This usually means a partial install or corrupted node_modules.`,
      fix: [
        'Reinstall DorkOS:',
        '  npm install -g dorkos@latest',
        '',
        'Or clear the cache and retry:',
        '  npm cache clean --force && npm install -g dorkos',
      ].join('\n'),
    };
  }

  // 3. Port conflict — EADDRINUSE
  if (code === 'EADDRINUSE') {
    const portMatch = msg.match(/(?:port\s+)?(\d{4,5})/i);
    const port = portMatch?.[1] ?? '4242';
    return {
      category: 'port-conflict',
      headline: `Port ${port} is already in use`,
      detail: `Another process is listening on port ${port}. This could be another DorkOS instance or a different application.`,
      fix: [
        'Find what is using the port:',
        `  lsof -i :${port}`,
        '',
        'Kill it if safe:',
        `  kill $(lsof -ti :${port})`,
        '',
        'Or start DorkOS on a different port:',
        `  dorkos --port ${parseInt(port) + 1}`,
      ].join('\n'),
    };
  }

  // 4. Permission errors — EACCES, EPERM
  if (code === 'EACCES' || code === 'EPERM') {
    const pathMatch = msg.match(/'([^']+)'/);
    const filePath = pathMatch?.[1] ?? '~/.dork';
    return {
      category: 'permission-denied',
      headline: 'Permission denied',
      detail: `Cannot access ${filePath}. The data directory may be owned by a different user or have restricted permissions.`,
      fix: [
        'Fix ownership of the DorkOS data directory:',
        `  sudo chown -R $(whoami) ~/.dork`,
        '',
        'Or check if another user is running DorkOS:',
        `  ls -la ~/.dork`,
      ].join('\n'),
    };
  }

  // 5. Database errors — SQLite/Drizzle issues
  if (
    msg.includes('SQLITE') ||
    msg.includes('database') ||
    msg.includes('migration') ||
    msg.includes('drizzle')
  ) {
    return {
      category: 'db-error',
      headline: 'Database error',
      detail: `The DorkOS database at ~/.dork/dork.db may be corrupted or incompatible: ${msg}`,
      fix: [
        'Back up and recreate the database:',
        '  mv ~/.dork/dork.db ~/.dork/dork.db.bak',
        '  dorkos   # will create a fresh database',
        '',
        'Your agents and config are stored separately and will not be lost.',
      ].join('\n'),
    };
  }

  // 6. Config parse errors
  if (
    msg.includes('config') &&
    (msg.includes('JSON') || msg.includes('parse') || msg.includes('schema'))
  ) {
    return {
      category: 'config-error',
      headline: 'Invalid configuration',
      detail: `The config file at ~/.dork/config.json could not be parsed: ${msg}`,
      fix: [
        'Validate the config:',
        '  dorkos config validate',
        '',
        'Or reset to defaults:',
        '  dorkos config reset',
        '',
        'A copy of your previous settings may be in ~/.dork, named',
        'config-<date>.json.bak',
      ].join('\n'),
    };
  }

  // 7. Unknown — preserve original message
  return {
    category: 'unknown',
    headline: 'Startup failed',
    detail: msg,
    fix: [
      'Check the logs for details:',
      `  cat ~/.dork/logs/dorkos-${new Date().toISOString().slice(0, 10)}.ndjson | tail -20`,
      '',
      'If this persists, please report the issue:',
      '  https://github.com/doriancollier/dorkos/issues',
    ].join('\n'),
  };
}

/**
 * Format a diagnostic as a boxed, colored terminal message.
 *
 * Uses ANSI escape codes directly — no dependency on chalk or picocolors
 * since this runs before the server loads.
 */
export function formatDiagnostic(diag: Diagnostic): string {
  const red = '\x1b[31m';
  const yellow = '\x1b[33m';
  const dim = '\x1b[2m';
  const bold = '\x1b[1m';
  const reset = '\x1b[0m';

  const lines = [
    '',
    `${red}${bold}✖ ${diag.headline}${reset}`,
    '',
    `${dim}${diag.detail}${reset}`,
    '',
    `${yellow}${bold}How to fix:${reset}`,
    diag.fix,
    '',
    `${dim}Platform: ${os.platform()} ${os.arch()} | Node: ${process.versions.node}${reset}`,
    '',
  ];

  return lines.join('\n');
}
