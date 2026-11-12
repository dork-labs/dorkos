/**
 * Which transport `CodexRuntime` runs on (spec `codex-app-server-transport`
 * §15, ADR 261005-113107).
 *
 * @module services/runtimes/codex/transport
 */

export type {
  CodexTransport,
  CodexTurnRequest,
  CodexCompactRequest,
  CodexTurnTools,
  CodexLaunch,
} from './codex-transport.js';
import {
  createAppServerTransport,
  type AppServerTransportOptions,
} from './app-server-transport.js';
export {
  AppServerCodexTransport,
  createAppServerTransport,
  type AppServerTransportOptions,
} from './app-server-transport.js';

/** A concrete transport. */
export type CodexTransportKind = 'app-server';

/** Build the only production transport. */
export function createCodexTransport(options: AppServerTransportOptions) {
  return createAppServerTransport(options);
}
