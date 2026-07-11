/**
 * Build a sanitized feedback report from the client's view of the server.
 *
 * The cockpit already fetches the server config for the sidebar footer; this
 * helper reduces it to the safe subset a GitHub issue can carry (version, host
 * platform, configured runtimes, current route, and on/off settings). It never
 * reads paths, tokens, or session content. Pass its result to `buildIssueUrl`
 * from `@dorkos/shared/feedback`.
 *
 * @module shared/lib/build-issue-report
 */
import { sanitizeFlags, type FeedbackKind, type FeedbackReport } from '@dorkos/shared/feedback';
import type { ServerConfig } from '@dorkos/shared/schemas';

/**
 * Map the server config into a raw flag record keyed by the allowlist paths.
 *
 * Only on/off values and short enums are read. `sanitizeFlags` drops anything
 * missing or unsafe, so listing an occasional undefined here is harmless.
 */
function rawFlagsFromConfig(config: ServerConfig): Record<string, unknown> {
  return {
    'tunnel.enabled': config.tunnel?.enabled,
    'tasks.enabled': config.tasks?.enabled,
    'relay.enabled': config.relay?.enabled,
    'mesh.enabled': config.mesh?.enabled,
    'mcp.enabled': config.mcp?.enabled,
    'telemetry.enabled': config.telemetry?.enabled,
    'auth.enabled': config.auth?.enabled,
    'logging.level': config.logging?.level,
  };
}

/**
 * Build a feedback report from the current server config and route.
 *
 * @param kind - Which template the report maps to
 * @param config - The server config, or `undefined` while it is still loading
 * @param pathname - The active route path, e.g. `/agents`
 * @returns A report ready for `buildIssueUrl`
 */
export function buildClientReport(
  kind: FeedbackKind,
  config: ServerConfig | undefined,
  pathname: string
): FeedbackReport {
  return {
    kind,
    version: config?.version ?? 'unknown',
    platform: config?.platform ?? 'unknown',
    runtimes: config?.runtimes ?? [],
    surface: `web ${pathname}`.trim(),
    flags: config ? sanitizeFlags(rawFlagsFromConfig(config)) : {},
  };
}
