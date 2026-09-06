/** Codex environment indirection for connector runtime MCP headers. */
import type { ConnectorRuntimeMcpInjection } from '../connector-tools.js';
import {
  CONNECTOR_RUNTIME_AUTHORIZATION_HEADER,
  CONNECTOR_RUNTIME_CWD_HEADER,
  CONNECTOR_RUNTIME_HEADER_ENV,
  CONNECTOR_RUNTIME_KIND_HEADER,
} from '../connector-tools.js';

const ENV_BY_HEADER: Record<string, string> = {
  [CONNECTOR_RUNTIME_AUTHORIZATION_HEADER]: CONNECTOR_RUNTIME_HEADER_ENV.authorization,
  [CONNECTOR_RUNTIME_KIND_HEADER]: CONNECTOR_RUNTIME_HEADER_ENV.runtime,
  [CONNECTOR_RUNTIME_CWD_HEADER]: CONNECTOR_RUNTIME_HEADER_ENV.cwd,
};

/**
 * Map connector header names to environment variable names for Codex config.
 *
 * @param injection - Turn-scoped connector MCP configuration.
 * @returns Header to environment-variable-name mapping.
 */
export function connectorHeaderEnvNames(
  injection: ConnectorRuntimeMcpInjection
): Record<string, string> {
  const names: Record<string, string> = {};
  for (const header of Object.keys(injection.headers)) {
    const envName = ENV_BY_HEADER[header];
    if (!envName) {
      throw new Error(
        `[CodexRuntime] no environment variable is defined for connector header "${header}".`
      );
    }
    names[header] = envName;
  }
  return names;
}

/**
 * Map connector header values into the Codex subprocess environment.
 *
 * @param injection - Turn-scoped connector MCP configuration, when available.
 * @returns Environment values containing the bearer outside visible argv.
 */
export function connectorHeaderEnv(
  injection?: ConnectorRuntimeMcpInjection | null
): Record<string, string> {
  if (!injection) return {};
  const values: Record<string, string> = {};
  for (const [header, value] of Object.entries(injection.headers)) {
    const envName = ENV_BY_HEADER[header];
    if (envName) values[envName] = value;
  }
  return values;
}
