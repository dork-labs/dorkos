/**
 * One Codex thread load's params (spec `codex-app-server-transport` §9, §18),
 * built from a read-only filesystem snapshot. Split from `thread-loader.ts`,
 * which re-exports it, to keep that file under the line limit.
 *
 * @module services/runtimes/codex/policy/load-overrides
 */
import {
  CONNECTOR_RUNTIME_MCP_SERVER_NAME,
  CONNECTOR_RUNTIME_TOOL_TIMEOUT_MS,
  connectorRuntimeHeaders,
} from '../../connector-tools.js';
import { DORKOS_MCP_SERVER_NAME } from '../../../core/tool-names/tool-names.js';
import { codexCreditsThreadConfig } from '../credits-launch.js';
import { withLiteralHeaders } from '../mcp-server-config.js';
import { guardedMountTargetRecorder } from './writable-missing-targets.js';
import { codexPermissionProfile, codexProtectedConfig } from './protected-profile.js';
import { codexShellEnv } from '../transport/shell-env.js';
import type { ThreadLoadOverrides } from '../app-server/protocol/methods.js';
import type { ThreadLoadInput } from '../app-server/thread-loader.js';
import { approvalPolicyFor } from '../app-server/turn-parts.js';

/**
 * Build one load's params from a read-only filesystem snapshot: sandbox mapping,
 * the mode's approval policy (`approvalPolicyFor`), and the reviewer always
 * the person — never a model (spec §18).
 *
 * @param input - The load inputs.
 * @param secrets - The thread key, the trust verdict and the cwd's realpath.
 */
export function buildLoadOverrides(
  input: Pick<
    ThreadLoadInput,
    'sessionId' | 'cwd' | 'settings' | 'tools' | 'creditsRelay' | 'preventIdleSleep'
  >,
  secrets: {
    threadKey: string | undefined;
    trust: 'trusted' | 'untrusted' | undefined;
    realCwd: string;
    onMissingTargets?: ((targets: string[]) => void) | undefined;
  }
): ThreadLoadOverrides {
  const config: Record<string, unknown> = codexProtectedConfig(
    input.cwd,
    input.tools.filePolicy,
    input.settings,
    guardedMountTargetRecorder(input.settings, secrets.onMissingTargets, input.tools.filePolicy),
    input.sessionId
  );
  const servers: Record<string, unknown> = { ...withLiteralHeaders(input.tools.managed) };
  if (secrets.threadKey !== undefined) {
    // Written LAST so a managed server can never shadow them.
    const headers = connectorRuntimeHeaders({
      bearer: secrets.threadKey,
      runtime: 'codex',
      canonicalCwd: input.cwd,
    });
    if (input.tools.dorkosTools) {
      servers[DORKOS_MCP_SERVER_NAME] = { url: input.tools.dorkosTools.url, http_headers: headers };
    }
    if (input.tools.connectorTools) {
      servers[CONNECTOR_RUNTIME_MCP_SERVER_NAME] = {
        url: input.tools.connectorTools.url,
        http_headers: headers,
        tool_timeout_sec: CONNECTOR_RUNTIME_TOOL_TIMEOUT_MS / 1000,
      };
    }
  }
  if (Object.keys(servers).length > 0) config.mcp_servers = servers;
  // Vendor thread ids differ; shells always receive the server-owned DorkOS chat id.
  config.shell_environment_policy = { set: codexShellEnv(input.tools, input.sessionId) };
  if (secrets.trust !== undefined) {
    config.projects = { [secrets.realCwd]: { trust_level: secrets.trust } };
  }
  if (input.creditsRelay) {
    Object.assign(config, codexCreditsThreadConfig(input.creditsRelay));
  }
  if (input.preventIdleSleep) config.features = { prevent_idle_sleep: true };
  return {
    cwd: input.cwd,
    ...(input.settings.model !== undefined ? { model: input.settings.model } : {}),
    approvalPolicy: approvalPolicyFor(input.settings),
    approvalsReviewer: 'user',
    permissions: codexPermissionProfile(input.settings),
    config,
  };
}
