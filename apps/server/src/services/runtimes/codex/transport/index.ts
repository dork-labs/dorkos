/**
 * Which transport `CodexRuntime` runs on (spec `codex-app-server-transport`
 * §15, ADR 261005-113107).
 *
 * @module services/runtimes/codex/transport
 */
import type { CodexTransportSetting } from '@dorkos/shared/config-schema';

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
  createAppServerTransport,
  type AppServerTransportOptions,
} from './app-server-transport.js';

/** A concrete transport. */
export type CodexTransportKind = 'exec' | 'app-server';

/**
 * The legacy exec setting now selects app-server too: the pinned CLI cannot
 * explicitly select a protected permission profile on exec. Never fall back
 * to exec when app-server startup fails.
 */
export function resolveCodexTransport(_setting: CodexTransportSetting | undefined): 'app-server' {
  return 'app-server';
}

/** The only production launch path, including callers with a legacy exec value. */
export function createCodexTransport(
  choice: CodexTransportKind,
  options: AppServerTransportOptions
) {
  resolveCodexTransport(choice);
  return createAppServerTransport(options);
}
