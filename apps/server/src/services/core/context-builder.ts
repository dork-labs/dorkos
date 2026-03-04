import os from 'node:os';
import { getGitStatus } from './git-status.js';
import type { GitStatusResponse } from '@dorkos/shared/types';
import { readManifest } from '@dorkos/shared/manifest';
import { logger } from '../../lib/logger.js';
import { env } from '../../env.js';
import { isRelayEnabled } from '../relay/relay-state.js';
import { configManager } from './config-manager.js';

const RELAY_TOOLS_CONTEXT = `<relay_tools>
DorkOS Relay is a pub/sub message bus for inter-agent communication.

Subject hierarchy:
  relay.agent.{sessionId}          — address a specific agent session
  relay.human.console.{clientId}   — reach a human in the DorkOS UI
  relay.system.console             — system broadcast channel
  relay.system.pulse.{scheduleId}  — Pulse scheduler events

Workflows:
- Register a reply address first: relay_register_endpoint(subject="relay.agent.{your-sessionId}")
- Message another agent: relay_send(subject="relay.agent.{their-sessionId}", payload={...}, from="relay.agent.{your-sessionId}")
- Check for replies: relay_inbox(endpoint_subject="relay.agent.{your-sessionId}")
- See who is listening: relay_list_endpoints()

The "from" field is your own subject. Set "replyTo" so the recipient knows where to respond.

Error codes: RELAY_DISABLED (feature off), ACCESS_DENIED (subject blocked), INVALID_SUBJECT (malformed), ENDPOINT_NOT_FOUND (inbox miss).
</relay_tools>`;

const MESH_TOOLS_CONTEXT = `<mesh_tools>
DorkOS Mesh is a local agent registry for discovering and communicating with AI agents on this machine.

Agent lifecycle:
1. mesh_discover(roots=["/path"]) — scan directories for agent candidates (looks for CLAUDE.md, .dork/agent.json)
2. mesh_register(path, name, runtime, capabilities) — register a candidate as a known agent
3. mesh_inspect(agentId) — get full manifest, health status, and relay endpoint
4. mesh_status() — aggregate overview: total, active, stale agent counts
5. mesh_list(runtime?, capability?) — filter agents by runtime or capability
6. mesh_deny(path, reason) — exclude a path from future discovery
7. mesh_unregister(agentId) — remove an agent from the registry
8. mesh_query_topology(namespace?) — view agent network from a namespace perspective

Workflows:
- Find agents: mesh_list() then mesh_inspect(agentId) for details
- Contact another agent: mesh_inspect(agentId) to get their relay endpoint, then relay_send
- Register this project: mesh_register(path=cwd, name="project-name", runtime="claude-code")

Runtimes: claude-code | cursor | codex | other
</mesh_tools>`;

const ADAPTER_TOOLS_CONTEXT = `<adapter_tools>
Relay adapters bridge external platforms (Telegram, webhooks) to the agent message bus.

Subject conventions for external messages:
  relay.human.telegram.{chatId}    — send to / receive from Telegram
  relay.human.webhook.{webhookId}  — send to / receive from webhooks

Adapter management:
- relay_list_adapters() — see all adapters and their status (connected, disconnected, error)
- relay_enable_adapter(id) / relay_disable_adapter(id) — toggle an adapter on/off
- relay_reload_adapters() — hot-reload config from disk

Bindings route adapter messages to agent projects:
- binding_list() — see current adapter-to-agent bindings
- binding_create(adapterId, agentId, projectPath) — route an adapter to an agent
- binding_delete(id) — remove a binding

Session strategies: per-chat (default, one session per conversation), per-user (shared across chats), stateless (new session each message).
</adapter_tools>`;

/**
 * Build the `<relay_tools>` context block.
 * Included when Relay is enabled AND the config toggle is on.
 */
function buildRelayToolsBlock(): string {
  if (!isRelayEnabled()) return '';
  const config = configManager.get('agentContext');
  if (config?.relayTools === false) return '';
  return RELAY_TOOLS_CONTEXT;
}

/**
 * Build the `<mesh_tools>` context block.
 * Included when Mesh is available AND the config toggle is on.
 * Mesh is always-on per ADR-0062, so no feature flag check.
 */
function buildMeshToolsBlock(): string {
  const config = configManager.get('agentContext');
  if (config?.meshTools === false) return '';
  return MESH_TOOLS_CONTEXT;
}

/**
 * Build the `<adapter_tools>` context block.
 * Included when Relay is enabled (adapters require Relay) AND the config toggle is on.
 */
function buildAdapterToolsBlock(): string {
  if (!isRelayEnabled()) return '';
  const config = configManager.get('agentContext');
  if (config?.adapterTools === false) return '';
  return ADAPTER_TOOLS_CONTEXT;
}

/**
 * Build a system prompt append string containing runtime context.
 *
 * Returns XML key-value blocks mirroring Claude Code's own `<env>` structure.
 * Never throws — all errors result in partial context (git failures produce
 * `Is git repo: false`).
 */
export async function buildSystemPromptAppend(cwd: string): Promise<string> {
  const [envResult, gitResult, agentResult] = await Promise.allSettled([
    buildEnvBlock(cwd),
    buildGitBlock(cwd),
    buildAgentBlock(cwd),
  ]);

  // Tool context blocks are synchronous (static strings + config checks)
  const relayBlock = buildRelayToolsBlock();
  const meshBlock = buildMeshToolsBlock();
  const adapterBlock = buildAdapterToolsBlock();

  return [
    envResult.status === 'fulfilled' ? envResult.value : '',
    gitResult.status === 'fulfilled' ? gitResult.value : '',
    agentResult.status === 'fulfilled' ? agentResult.value : '',
    relayBlock,
    meshBlock,
    adapterBlock,
  ]
    .filter(Boolean)
    .join('\n\n');
}

/** Build the `<env>` block with system and DorkOS metadata. */
async function buildEnvBlock(cwd: string): Promise<string> {
  const lines = [
    `Working directory: ${cwd}`,
    `Product: DorkOS`,
    `Version: ${env.DORKOS_VERSION ?? 'development'}`,
    `Port: ${env.DORKOS_PORT}`,
    `Platform: ${os.platform()}`,
    `OS Version: ${os.release()}`,
    `Node.js: ${process.version}`,
    `Hostname: ${os.hostname()}`,
    `Date: ${new Date().toISOString()}`,
  ];

  return `<env>\n${lines.join('\n')}\n</env>`;
}

/**
 * Build the `<git_status>` block from git status data.
 *
 * For non-git directories or git failures, returns a minimal block
 * with `Is git repo: false`.
 */
async function buildGitBlock(cwd: string): Promise<string> {
  try {
    const status = await getGitStatus(cwd);

    // Non-git directory (error response)
    if ('error' in status) {
      return '<git_status>\nIs git repo: false\n</git_status>';
    }

    const gitStatus = status as GitStatusResponse;
    const lines: string[] = [
      'Is git repo: true',
      `Current branch: ${gitStatus.branch}`,
      'Main branch (use for PRs): main',
    ];

    if (gitStatus.ahead > 0) {
      lines.push(`Ahead of origin: ${gitStatus.ahead} commits`);
    }
    if (gitStatus.behind > 0) {
      lines.push(`Behind origin: ${gitStatus.behind} commits`);
    }
    if (gitStatus.detached) {
      lines.push('Detached HEAD: true');
    }

    if (gitStatus.clean) {
      lines.push('Working tree: clean');
    } else {
      const parts: string[] = [];
      if (gitStatus.modified > 0) parts.push(`${gitStatus.modified} modified`);
      if (gitStatus.staged > 0) parts.push(`${gitStatus.staged} staged`);
      if (gitStatus.untracked > 0) parts.push(`${gitStatus.untracked} untracked`);
      if (gitStatus.conflicted > 0) parts.push(`${gitStatus.conflicted} conflicted`);
      lines.push(`Working tree: dirty (${parts.join(', ')})`);
    }

    return `<git_status>\n${lines.join('\n')}\n</git_status>`;
  } catch (err) {
    logger.warn('[buildGitBlock] git status failed, returning non-git block', { err });
    return '<git_status>\nIs git repo: false\n</git_status>';
  }
}

/**
 * Build agent identity and persona blocks from `.dork/agent.json`.
 *
 * When a manifest exists, always includes `<agent_identity>` (informational).
 * Includes `<agent_persona>` only when `personaEnabled` is true and `persona`
 * text is non-empty.
 *
 * @param cwd - Working directory to check for agent manifest
 * @returns XML block string, or empty string if no manifest
 */
async function buildAgentBlock(cwd: string): Promise<string> {
  const manifest = await readManifest(cwd);
  if (!manifest) return '';

  // Zod v4 + openapi extension drops persona fields from inferred type
  const { persona, personaEnabled } = manifest as {
    persona?: string;
    personaEnabled?: boolean;
  };

  const identityLines = [
    `Name: ${manifest.name}`,
    `ID: ${manifest.id}`,
    manifest.description && `Description: ${manifest.description}`,
    manifest.capabilities.length > 0 && `Capabilities: ${manifest.capabilities.join(', ')}`,
  ].filter(Boolean);

  const blocks = [`<agent_identity>\n${identityLines.join('\n')}\n</agent_identity>`];

  if (personaEnabled !== false && persona) {
    blocks.push(`<agent_persona>\n${persona}\n</agent_persona>`);
  }

  return blocks.join('\n\n');
}

/** @internal Exported for testing only. */
export {
  buildAgentBlock as _buildAgentBlock,
  buildRelayToolsBlock as _buildRelayToolsBlock,
  buildMeshToolsBlock as _buildMeshToolsBlock,
  buildAdapterToolsBlock as _buildAdapterToolsBlock,
  RELAY_TOOLS_CONTEXT as _RELAY_TOOLS_CONTEXT,
  MESH_TOOLS_CONTEXT as _MESH_TOOLS_CONTEXT,
  ADAPTER_TOOLS_CONTEXT as _ADAPTER_TOOLS_CONTEXT,
};
