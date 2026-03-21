import os from 'node:os';
import { getGitStatus } from '../../core/git-status.js';
import type { GitStatusResponse } from '@dorkos/shared/types';
import { readManifest } from '@dorkos/shared/manifest';
import { logger } from '../../../lib/logger.js';
import { env } from '../../../env.js';
import { SERVER_VERSION } from '../../../lib/version.js';
import { isRelayEnabled } from '../../relay/relay-state.js';
import { isPulseEnabled } from '../../pulse/pulse-state.js';
import { configManager } from '../../core/config-manager.js';
import type { ResolvedToolConfig } from './tool-filter.js';
import type { AgentRegistryPort } from '@dorkos/shared/agent-runtime';

const RELAY_TOOLS_CONTEXT = `<relay_tools>
DorkOS Relay is a pub/sub message bus for inter-agent communication.

Subject hierarchy:
  relay.agent.{agentId}                — activate a specific agent session
  relay.inbox.query.{UUID}             — ephemeral inbox for relay_send_and_wait (auto-managed)
  relay.inbox.dispatch.{UUID}          — ephemeral inbox for relay_send_async (auto-expires after ~35 min)
  relay.inbox.{agentId}                — persistent agent reply inbox
  relay.human.console.{clientId}       — reach a human in the DorkOS UI
  relay.system.console                 — system broadcast channel
  relay.system.pulse.{scheduleId}      — Pulse scheduler events

Workflow: Query another agent — SHORT tasks (≤10 min, PREFERRED)
1. mesh_list() to find available agents and their agent IDs
2. relay_send_and_wait(to_subject="relay.agent.{theirAgentId}", payload={task}, from={myAgentId}, timeout_ms=600000)
   → Blocks until reply (max 10 min / 600 000 ms)
   → Returns: { reply, from, replyMessageId, sentMessageId, progress: ProgressEvent[] }
   → progress[] contains intermediate steps: { type: "progress", step, step_type, text, done: false }

Workflow: Dispatch to another agent — LONG tasks (>10 min)
1. relay_send_async(to_subject="relay.agent.{theirAgentId}", payload={task}, from={myAgentId})
   → Returns IMMEDIATELY: { messageId, inboxSubject: "relay.inbox.dispatch.{UUID}" }
2. Poll: relay_inbox(endpoint_subject=inboxSubject, status="unread")
   → Returns progress events: { type: "progress", step, step_type: "message"|"tool_result", text, done: false }
   → Returns final result: { type: "agent_result", text, done: true }
3. When done:true received: relay_unregister_endpoint(subject=inboxSubject)

Workflow: Fire-and-forget (no reply needed)
1. relay_send(subject="relay.agent.{theirAgentId}", payload={task}, from={myAgentId})

Workflow: Manual poll (fallback)
1. relay_register_endpoint(subject="relay.inbox.{myAgentId}")
2. relay_send(subject="relay.agent.{theirAgentId}", payload={task}, from={myAgentId}, replyTo="relay.inbox.{myAgentId}")
3. relay_inbox(endpoint_subject="relay.inbox.{myAgentId}")

CONSTRAINT — Subagent MCP tools: DorkOS MCP tools (relay_*, mesh_*, pulse_*) are NOT available
inside Claude Code Task() subagents. This is an SDK architectural limitation (subprocesses do not
inherit the parent MCP server). The orchestrator pattern workaround:
  WRONG:  Task("use relay_send to message agent B")   ← tools unavailable, silent failure
  RIGHT:  1. Call relay_send_async() in this (parent) session
          2. Pass the inboxSubject into the Task() prompt if needed
          3. Poll relay_inbox() in this session after Task() returns

IMPORTANT: When YOU receive a relay message, respond naturally — do NOT call relay_send.
Your response is automatically forwarded by the relay system.
Only call relay_send/relay_send_and_wait/relay_send_async to INITIATE a new message.

relay_list_endpoints returns type ("dispatch"|"query"|"persistent"|"agent"|"unknown") and expiresAt
(ISO string or null) for each endpoint. Use these to identify active inboxes and their expiry.

Error codes: RELAY_DISABLED, ACCESS_DENIED, INVALID_SUBJECT, ENDPOINT_NOT_FOUND,
             TIMEOUT, QUERY_FAILED, REJECTED, DISPATCH_FAILED, UNREGISTER_FAILED
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

const PULSE_TOOLS_CONTEXT = `<pulse_tools>
DorkOS Pulse lets you create and manage scheduled agent runs.

Available tools:
  pulse_list_schedules() -- list all configured schedules
  pulse_create_schedule(name, cron, prompt, ...) -- create a new schedule (enters pending_approval)
  pulse_update_schedule(id, ...) -- modify schedule settings
  pulse_delete_schedule(id) -- remove a schedule
  pulse_get_run_history(scheduleId) -- view past run results

Schedules can target a specific agent (by agentId) or a directory (by cwd).
Agent-linked schedules automatically resolve the agent's project path at run time.
</pulse_tools>`;

/**
 * Build the `<relay_tools>` context block.
 *
 * When `toolConfig` is provided, uses the pre-resolved config (agent-aware).
 * Otherwise falls back to global feature flag + config toggle checks.
 */
function buildRelayToolsBlock(toolConfig?: ResolvedToolConfig): string {
  if (toolConfig) {
    if (!toolConfig.relay) return '';
  } else {
    if (!isRelayEnabled()) return '';
    const config = configManager.get('agentContext');
    if (config?.relayTools === false) return '';
  }
  return RELAY_TOOLS_CONTEXT;
}

/**
 * Build the `<mesh_tools>` context block.
 *
 * When `toolConfig` is provided, uses the pre-resolved config (agent-aware).
 * Otherwise falls back to the global config toggle.
 * Mesh is always-on per ADR-0062, so no feature flag check in the fallback path.
 */
function buildMeshToolsBlock(toolConfig?: ResolvedToolConfig): string {
  if (toolConfig) {
    if (!toolConfig.mesh) return '';
  } else {
    const config = configManager.get('agentContext');
    if (config?.meshTools === false) return '';
  }
  return MESH_TOOLS_CONTEXT;
}

/**
 * Build the `<adapter_tools>` context block.
 *
 * When `toolConfig` is provided, uses the pre-resolved config (agent-aware).
 * Otherwise falls back to Relay feature flag + config toggle checks.
 */
function buildAdapterToolsBlock(toolConfig?: ResolvedToolConfig): string {
  if (toolConfig) {
    if (!toolConfig.adapter) return '';
  } else {
    if (!isRelayEnabled()) return '';
    const config = configManager.get('agentContext');
    if (config?.adapterTools === false) return '';
  }
  return ADAPTER_TOOLS_CONTEXT;
}

/**
 * Build the `<pulse_tools>` context block.
 *
 * When `toolConfig` is provided, uses the pre-resolved config (agent-aware).
 * Otherwise falls back to Pulse feature flag + config toggle checks.
 */
function buildPulseToolsBlock(toolConfig?: ResolvedToolConfig): string {
  if (toolConfig) {
    if (!toolConfig.pulse) return '';
  } else {
    if (!isPulseEnabled()) return '';
    const config = configManager.get('agentContext');
    if (config?.pulseTools === false) return '';
  }
  return PULSE_TOOLS_CONTEXT;
}

/**
 * Build the `<peer_agents>` context block with a summary of registered agents.
 *
 * Uses `listWithPaths()` for lightweight agent data including project paths.
 * Returns an empty string when the agent registry is unavailable or no agents are registered.
 *
 * @param meshCore - Optional agent registry port for agent data access
 */
async function buildPeerAgentsBlock(
  meshCore: AgentRegistryPort | null | undefined
): Promise<string> {
  if (!meshCore) return '';
  try {
    const agents = meshCore.listWithPaths().slice(0, 10);
    if (agents.length === 0) return '';
    const lines = agents.map((a) => `- ${a.name} (${a.projectPath})`).join('\n');
    return `<peer_agents>\nRegistered agents on this machine (use mesh_list() for live data):\n${lines}\n\nTo contact a peer: mesh_inspect(agentId) for relay endpoint, then relay_send() to that subject.\n</peer_agents>`;
  } catch {
    return '';
  }
}

/**
 * Build a system prompt append string containing runtime context.
 *
 * Returns XML key-value blocks mirroring Claude Code's own `<env>` structure.
 * Never throws — all errors result in partial context (git failures produce
 * `Is git repo: false`).
 *
 * @param cwd - Working directory for the session
 * @param meshCore - Optional agent registry port for peer agents block
 * @param toolConfig - Optional resolved tool config for agent-aware block gating
 */
export async function buildSystemPromptAppend(
  cwd: string,
  meshCore?: AgentRegistryPort | null,
  toolConfig?: ResolvedToolConfig
): Promise<string> {
  const results = await Promise.allSettled([
    buildEnvBlock(cwd),
    buildGitBlock(cwd),
    buildAgentBlock(cwd),
    buildPeerAgentsBlock(meshCore),
  ]);

  // Tool context blocks are synchronous (static strings + config checks)
  const relayBlock = buildRelayToolsBlock(toolConfig);
  const meshBlock = buildMeshToolsBlock(toolConfig);
  const adapterBlock = buildAdapterToolsBlock(toolConfig);
  const pulseBlock = buildPulseToolsBlock(toolConfig);

  return [
    ...results
      .filter((r) => r.status === 'fulfilled' && r.value)
      .map((r) => (r as PromiseFulfilledResult<string>).value),
    relayBlock,
    meshBlock,
    adapterBlock,
    pulseBlock,
  ]
    .filter(Boolean)
    .join('\n\n');
}

/** Build the `<env>` block with system and DorkOS metadata. */
async function buildEnvBlock(cwd: string): Promise<string> {
  const lines = [
    `Working directory: ${cwd}`,
    `Product: DorkOS`,
    `Version: ${SERVER_VERSION}`,
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
  buildPulseToolsBlock as _buildPulseToolsBlock,
  buildPeerAgentsBlock as _buildPeerAgentsBlock,
  RELAY_TOOLS_CONTEXT as _RELAY_TOOLS_CONTEXT,
  MESH_TOOLS_CONTEXT as _MESH_TOOLS_CONTEXT,
  ADAPTER_TOOLS_CONTEXT as _ADAPTER_TOOLS_CONTEXT,
  PULSE_TOOLS_CONTEXT as _PULSE_TOOLS_CONTEXT,
};
