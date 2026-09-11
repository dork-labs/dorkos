import { realpathSync } from 'node:fs';
import path from 'node:path';
import { SERVER_VERSION } from '../../../lib/version.js';

/** Quote one literal argument for a POSIX shell, including paths with apostrophes. */
function quote(value: string): string {
  return "'" + value.replaceAll("'", "'\"'\"'") + "'";
}

/**
 * Resolve only the CLI distribution that started this server, never a PATH binary.
 * Development/embedded servers and unsupported shells retain the MCP-only path.
 */
export function currentCliInvocation(): string | undefined {
  if (process.platform === 'win32') return undefined;
  const entry = process.env.DORKOS_CLI_ENTRYPOINT;
  if (!entry || !path.isAbsolute(entry) || process.env.DORKOS_CLI_VERSION !== SERVER_VERSION) {
    return undefined;
  }
  try {
    if (!process.argv[1] || realpathSync(entry) !== realpathSync(process.argv[1])) return undefined;
    return `${quote(realpathSync(process.execPath))} ${quote(realpathSync(entry))}`;
  } catch {
    return undefined;
  }
}
