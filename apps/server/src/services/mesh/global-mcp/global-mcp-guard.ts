/**
 * What a server for every agent may run (DOR-3213, Security's post-merge T7
 * and T8).
 *
 * A global stdio server starts in every agent's session, so what it runs must
 * be something no agent can change. Two rules decide that:
 *
 * - **Paths (T7).** The command, and any argument that names a file, must not
 *   be relative (it would resolve against each agent's own folder) and must not
 *   sit under the DorkOS data directory or any agent's folder, where agents
 *   write. A bare program name (`npx`, `uvx`, `node`) is a PATH lookup, not a
 *   relative path, and is allowed.
 * - **Env (T8).** Names that tell the loader to inject a library
 *   (`DYLD_*`, `LD_PRELOAD`, `LD_AUDIT`, `LD_LIBRARY_PATH`) are refused. Names
 *   that change what a language runtime loads or which program runs
 *   (`NODE_OPTIONS`, `PATH`, `PYTHONPATH`, `BASH_ENV`, `npm_config_*` and the
 *   like) are allowed and flagged, so a person sees them on the server.
 *
 * The same check runs when a person saves a server and again before each
 * injection, so a server written into `global-servers.json` by hand (any
 * program running as this user can write it) is dropped, never started.
 *
 * @module services/mesh/global-mcp/global-mcp-guard
 */
import { realpathSync } from 'node:fs';
import path from 'node:path';
import type { McpServerTransport } from '@dorkos/shared/mesh-schemas';
import type { GlobalMcpServerWarning } from '@dorkos/shared/global-mcp-schemas';

/** Where agents can write, so nothing global may run from. */
export interface GlobalMcpGuardContext {
  /** The resolved DorkOS data directory (agents' homes live under it). */
  readonly dorkHome: string;
  /** Every registered agent's folder. */
  readonly agentRoots: readonly string[];
}

/** Why a server may not run for every agent. */
export interface GlobalMcpRefusal {
  readonly code: 'unsafe_command' | 'unsafe_env';
  readonly message: string;
}

/** Env names that load a library into the program: refused. */
const REFUSED_ENV = [/^DYLD_/i, /^LD_PRELOAD$/i, /^LD_AUDIT$/i, /^LD_LIBRARY_PATH$/i];

/** Env names that change what a runtime loads or which program runs: flagged. */
const FLAGGED_ENV = [
  /^NODE_OPTIONS$/i,
  /^NODE_PATH$/i,
  /^PYTHONPATH$/i,
  /^PYTHONSTARTUP$/i,
  /^PYTHONHOME$/i,
  /^PATH$/i,
  /^BASH_ENV$/i,
  /^ENV$/i,
  /^PERL5OPT$/i,
  /^PERL5LIB$/i,
  /^RUBYOPT$/i,
  /^RUBYLIB$/i,
  /^npm_config_/i,
];

/** An argument ending in one of these names a script the command will run. */
const SCRIPT_EXTENSION = /\.(m?js|cjs|m?ts|py|sh|bash|zsh|rb|pl|php|jar|exe|bat|cmd|ps1)$/i;

/** Paths compare case-folded where the file system usually is. */
const CASE_FOLDS = process.platform === 'darwin' || process.platform === 'win32';

/**
 * The real location of a path, following links. A path that does not exist yet
 * resolves through its nearest existing parent, so a file an agent could create
 * later still lands inside that agent's folder.
 */
function realLocation(p: string): string {
  let existing = path.resolve(p);
  const rest: string[] = [];
  let resolved: string | undefined;
  while (resolved === undefined) {
    try {
      resolved = path.join(realpathSync(existing), ...rest);
    } catch {
      const parent = path.dirname(existing);
      if (parent === existing) resolved = path.resolve(p);
      else {
        rest.unshift(path.basename(existing));
        existing = parent;
      }
    }
  }
  return CASE_FOLDS ? resolved.toLowerCase() : resolved;
}

/** Whether `child` is `parent` or inside it. */
function isInside(child: string, parent: string): boolean {
  const relative = path.relative(parent, child);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

/** The folder agents can write that holds `p`, if any. */
function agentWritableRoot(p: string, ctx: GlobalMcpGuardContext): string | undefined {
  const real = realLocation(p);
  return [ctx.dorkHome, ...ctx.agentRoots].find((root) => isInside(real, realLocation(root)));
}

/** A path that resolves against the folder a program starts in, never PATH. */
function isRelativePath(value: string): boolean {
  if (path.isAbsolute(value)) return false;
  return value.startsWith('.') || value.startsWith('~') || /[/\\]/.test(value);
}

/**
 * The file an argument names, if it names one: an absolute path, a relative
 * one, or a bare script name. `--flag=value` is read for its value. An npm
 * package spec (`@scope/name`) and a plain word are not files.
 */
function fileInArgument(arg: string): string | undefined {
  const value = arg.startsWith('-') ? arg.slice(arg.indexOf('=') + 1) : arg;
  if (arg.startsWith('-') && !arg.includes('=')) return undefined;
  if (value.length === 0 || value.startsWith('@')) return undefined;
  // A URL (`https://host/x.js`) is fetched, not read from a folder.
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(value)) return undefined;
  if (path.isAbsolute(value)) return value;
  if (value.startsWith('./') || value.startsWith('../') || value.startsWith('~')) return value;
  if (value.startsWith('.\\') || value.startsWith('..\\')) return value;
  return SCRIPT_EXTENSION.test(value) ? value : undefined;
}

/** Why one path may not run for every agent, if it may not. */
function pathRefusal(
  value: string,
  what: string,
  ctx: GlobalMcpGuardContext
): GlobalMcpRefusal | undefined {
  if (!path.isAbsolute(value)) {
    return {
      code: 'unsafe_command',
      message: `The ${what} ${value} depends on each agent's folder. Use a full path.`,
    };
  }
  const root = agentWritableRoot(value, ctx);
  if (root === undefined) return undefined;
  return {
    code: 'unsafe_command',
    message: `Agents can change files in ${root}, so the ${what} ${value} can't run for every agent.`,
  };
}

/**
 * Why a server may not run for every agent, or `undefined` when it may.
 * Only a stdio server runs anything here; a remote one always passes.
 *
 * @param connection - The server's connection, as saved.
 * @param ctx - Where agents can write.
 */
export function refuseGlobalServer(
  connection: McpServerTransport,
  ctx: GlobalMcpGuardContext
): GlobalMcpRefusal | undefined {
  if (connection.transport !== 'stdio') return undefined;
  for (const name of Object.keys(connection.env)) {
    if (REFUSED_ENV.some((pattern) => pattern.test(name))) {
      return {
        code: 'unsafe_env',
        message: `${name} loads code into the program, so it can't be set here.`,
      };
    }
  }
  // A bare name is a PATH lookup and is left alone; anything else is a path.
  if (path.isAbsolute(connection.command) || isRelativePath(connection.command)) {
    const refusal = pathRefusal(connection.command, 'command', ctx);
    if (refusal) return refusal;
  }
  for (const arg of connection.args) {
    const file = fileInArgument(arg);
    if (file === undefined) continue;
    const refusal = pathRefusal(file, 'file', ctx);
    if (refusal) return refusal;
  }
  return undefined;
}

/**
 * The env names on a server a person should look at twice: each one changes
 * what the program loads or which program runs. Allowed, never hidden.
 *
 * @param connection - The server's connection.
 */
export function flaggedEnvNames(connection: McpServerTransport): GlobalMcpServerWarning[] {
  if (connection.transport !== 'stdio') return [];
  return Object.keys(connection.env)
    .filter((name) => FLAGGED_ENV.some((pattern) => pattern.test(name)))
    .map((name) => ({
      name,
      note: `${name} changes what the program loads. Check it's yours.`,
    }));
}
