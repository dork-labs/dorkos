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
  CodexTurnTools,
  CodexLaunch,
} from './codex-transport.js';
export { ExecCodexTransport } from './exec-transport.js';
export {
  AppServerCodexTransport,
  createAppServerTransport,
  type AppServerTransportOptions,
} from './app-server-transport.js';

/** A concrete transport. */
export type CodexTransportKind = 'exec' | 'app-server';

/**
 * Resolve `runtimes.codex.transport` to the transport this server runs.
 *
 * `auto` is DorkOS's own default and lives HERE and nowhere else: app-server
 * since spec phase P3 (exec before it). The flip was a change to this function
 * only — no migration, no seeded value — so a person who chose `exec`
 * explicitly keeps it, and it stays honoured.
 *
 * @param setting - The configured value; absent reads as `auto`.
 */
export function resolveCodexTransport(
  setting: CodexTransportSetting | undefined
): CodexTransportKind {
  switch (setting) {
    case 'exec':
      return 'exec';
    case 'app-server':
      return 'app-server';
    default:
      return 'app-server';
  }
}
