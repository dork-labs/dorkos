import os from 'node:os';
import type {
  AdditionalContextEntry,
  GitStatusData,
  EnvData,
  RelayContextData,
} from '@dorkos/shared/additional-context';
import { CONTEXT_TAG } from '@dorkos/shared/additional-context';
import { readManifest } from '@dorkos/shared/manifest';
import {
  extractCustomProse,
  buildSoulContent,
  TRAIT_SECTION_START,
} from '@dorkos/shared/convention-files';
import { readConventionFile } from '@dorkos/shared/convention-files-io';
import { renderTraits, DEFAULT_TRAITS } from '@dorkos/shared/trait-renderer';
import { env } from '../../../../env.js';
import { SERVER_VERSION } from '../../../../lib/version.js';
import { isRelayEnabled } from '../../../relay/relay-state.js';
import { isTasksEnabled } from '../../../tasks/task-state.js';
import { configManager } from '../../../core/config-manager.js';
import type { ResolvedToolConfig } from '../tooling/tool-filter.js';
import { GEN_UI_CONTEXT } from '../../shared/gen-ui-context.js';
import type { AgentRegistryPort } from '@dorkos/shared/agent-runtime';
import type { BindingRouter } from '../../../relay/binding-router.js';
import type { BindingStore } from '../../../relay/binding-store.js';
import type { AdapterManager } from '../../../relay/adapter-manager.js';

/** Dependencies for building the <relay_connections> context block. */
export interface RelayContextDeps {
  agentId: string;
  bindingRouter: BindingRouter;
  bindingStore: BindingStore;
  adapterManager: AdapterManager;
}

const RELAY_TOOLS_CONTEXT = `<relay_tools>
DorkOS Relay is a pub/sub message bus for inter-agent communication.

Trust model: your sender identity is injected by the server on every send — there
is NO "from" parameter and you cannot send as another agent. Every agent lives in
a namespace (explicit in its manifest, or derived from its directory layout);
agents in the same namespace can message each other, cross-namespace messaging is
DENIED by default, and the DorkBot system agent can reach (and be reached by) all
namespaces. A denied send fails with code ACCESS_DENIED plus a hint: the user can
allow a namespace pair from the Agents page Access panel. Use mesh_query_topology()
to inspect namespaces and rules.

Subject hierarchy:
  relay.agent.{agentId}                — activate a specific agent session
  relay.inbox.query.{UUID}             — ephemeral inbox for relay_send_and_wait (auto-managed)
  relay.inbox.dispatch.{UUID}          — ephemeral inbox for relay_send_async (auto-expires after ~35 min)
  relay.inbox.{agentId}                — persistent agent reply inbox
  relay.human.console.{clientId}       — reach a human in the DorkOS UI
  relay.system.console                 — system broadcast channel
  relay.system.tasks.{scheduleId}      — Tasks scheduler events

Workflow: Query another agent — SHORT tasks (≤10 min, PREFERRED)
1. mesh_list() to find available agents and their agent IDs
2. relay_send_and_wait(to_subject="relay.agent.{theirAgentId}", payload={task}, timeout_ms=600000)
   → Blocks until reply (max 10 min / 600 000 ms)
   → Returns: { reply, from, replyMessageId, sentMessageId, progress: ProgressEvent[] }
   → progress[] contains intermediate steps: { type: "progress", step, step_type, text, done: false }

Workflow: Dispatch to another agent — LONG tasks (>10 min)
1. relay_send_async(to_subject="relay.agent.{theirAgentId}", payload={task})
   → Returns IMMEDIATELY: { messageId, inboxSubject: "relay.inbox.dispatch.{UUID}" }
2. Poll: relay_inbox(endpoint_subject=inboxSubject, ack=true) — defaults to pending (unread) messages
   → Returns messages[]: each { id, subject, status, createdAt, sender, payload }
   → payload is a progress event { type: "progress", step, step_type: "message"|"tool_result", text, done: false }
     or the final result { type: "agent_result", text, done: true }
   → ack=true marks returned messages read, so each poll only returns new messages
3. When a payload with done:true is received: relay_unregister_endpoint(subject=inboxSubject)

Workflow: Fire-and-forget (no reply needed)
1. relay_send(subject="relay.agent.{theirAgentId}", payload={task})
   → { messageId, deliveredTo, queued } — queued:true means no live consumer yet (buffered/dead-lettered)
   → Rejected sends (e.g. rate-limited) return an error with code REJECTED — the message was NOT delivered

Workflow: Manual poll (fallback)
1. relay_register_endpoint(subject="relay.inbox.{myAgentId}")
2. relay_send(subject="relay.agent.{theirAgentId}", payload={task}, replyTo="relay.inbox.{myAgentId}")
3. relay_inbox(endpoint_subject="relay.inbox.{myAgentId}", ack=true)
   → messages[].payload carries each reply; ack=true marks them read

CONSTRAINT — Subagent MCP tools: DorkOS MCP tools (relay_*, mesh_*, tasks_*) are NOT available
inside Claude Code Task() subagents. This is an SDK architectural limitation (subprocesses do not
inherit the parent MCP server). The orchestrator pattern workaround:
  WRONG:  Task("use relay_send to message agent B")   ← tools unavailable, silent failure
  RIGHT:  1. Call relay_send_async() in this (parent) session
          2. Pass the inboxSubject into the Task() prompt if needed
          3. Poll relay_inbox() in this session after Task() returns

IMPORTANT — Outbound messaging rules:
- When your CURRENT message has a <relay_context> block: respond naturally. Your response
  is automatically forwarded to the sender. Do NOT call relay_send.
- When your current message does NOT have <relay_context> (e.g., from the DorkOS console)
  and the user asks you to message them on an external channel (Telegram, Slack): use
  relay_notify_user(message="…", channel="{adapter type or ID}"). It resolves the bound chat
  and honors the channel's "agent may start conversations" permission — if that permission is
  off it returns INITIATE_NOT_ALLOWED instead of sending. Do NOT try to reach a human by
  publishing a raw relay.human.* subject with relay_send: that path enforces the same
  permission and will be denied.
- relay_send/relay_send_and_wait/relay_send_async are for reaching other AGENTS
  (relay.agent.*), not for initiating messages to humans on external channels.

relay_list_endpoints returns type ("dispatch"|"query"|"persistent"|"agent"|"unknown") and expiresAt
(ISO string or null) for each endpoint. Use these to identify active inboxes and their expiry.

Error codes: RELAY_DISABLED, ACCESS_DENIED, INVALID_SUBJECT, ENDPOINT_NOT_FOUND,
             TIMEOUT, QUERY_FAILED, REJECTED, DISPATCH_FAILED, UNREGISTER_FAILED
</relay_tools>`;

const MESH_TOOLS_CONTEXT = `<mesh_tools>
DorkOS Mesh is a local agent registry for discovering and communicating with AI agents on this machine.

Agent lifecycle:
1. mesh_discover(roots=["/path"]) — scan directories for agent candidates (looks for AGENTS.md, .dork/agent.json)
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

To message a human on an external channel, use relay_notify_user(message="…",
channel="{adapter type or ID}") — never publish a relay.human.* subject directly. The bus
addresses external chats with these subjects internally; they are how inbound messages arrive
and how your automatic replies are routed, NOT a send target for you:
  relay.human.telegram.{adapterId}.{chatId}        — Telegram DM
  relay.human.telegram.{adapterId}.group.{chatId}  — Telegram group
  relay.human.slack.{adapterId}.{chatId}            — Slack channel/DM
  relay.human.webhook.{webhookId}                   — Webhook

The {adapterId} is the adapter's ID from relay_list_adapters() (e.g., "telegram-lifeos").
Whether you may start a conversation on a channel is a per-binding permission ("agent may
start conversations"); relay_notify_user enforces it and reports INITIATE_NOT_ALLOWED when off.

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

const TASKS_TOOLS_CONTEXT = `<tasks_tools>
DorkOS Tasks lets you create and manage scheduled agent runs.

Available tools:
  tasks_list() -- list all configured schedules
  tasks_create(name, cron, prompt, ...) -- create a new schedule (enters pending_approval)
  tasks_update(id, ...) -- modify schedule settings
  tasks_delete(id) -- remove a schedule
  tasks_get_run_history(scheduleId) -- view past run results

Schedules can target a specific agent (by agentId) or a directory (by cwd).
Agent-linked schedules automatically resolve the agent's project path at run time.
</tasks_tools>`;

const UI_TOOLS_CONTEXT = `<ui_tools>
DorkOS UI control lets you manipulate the client interface.

Available tools:
  control_ui(action, ...) -- send a UI command to the client
  get_ui_state() -- query current UI state (panels, sidebar, canvas, active agent)

Actions:
  open_panel / close_panel / toggle_panel: { panel: "settings"|"tasks"|"relay"|"picker" }
  open_sidebar / close_sidebar
  switch_sidebar_tab: { tab: "overview"|"sessions"|"schedules"|"connections" } (embedded app only; the web cockpit has no sidebar tab strip, so this is a no-op there)
  open_canvas: { content: { type: "url"|"markdown"|"json"|"image"|"pdf"|"widget", ... }, preferredWidth?: 20-80 }
    image/pdf take a "src" (https url, data: URI, or local file path); widget takes a "definition" (a dorkos-ui widget document, see <gen_ui>)
  update_canvas / close_canvas
  show_toast: { message, level?: "success"|"error"|"info"|"warning", description? }
  set_theme: { theme: "light"|"dark" }
  scroll_to_message: { messageId? } (omit for bottom)
  switch_agent: { cwd: string }
  open_command_palette
  celebrate -- fire a brief confetti burst

Use get_ui_state() before making layout decisions to avoid redundant commands. It reflects the state the client reported at turn start plus the commands you issued this turn — not a live read.
UI commands only take visible effect when an interactive client is attached (headless/scheduled runs accept them but show nothing), and canvas content pushes may be deferred while the user is editing the canvas — a success result means "accepted", not "displayed".
</ui_tools>`;

/**
 * Build the static `<ui_tools>` context block.
 *
 * Always included — UI tools are core tools with no feature flag dependency.
 * The dynamic `<ui_state>` snapshot is no longer appended here; it rides the
 * per-turn additional-context bag and is rendered by {@link renderContextEntry}
 * (ADR-0273) so the static system-prompt prefix stays cacheable.
 */
function buildUiToolsBlock(): string {
  return UI_TOOLS_CONTEXT;
}

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
 * Build the `<tasks_tools>` context block.
 *
 * When `toolConfig` is provided, uses the pre-resolved config (agent-aware).
 * Otherwise falls back to Tasks feature flag + config toggle checks.
 */
function buildTasksToolsBlock(toolConfig?: ResolvedToolConfig): string {
  if (toolConfig) {
    if (!toolConfig.tasks) return '';
  } else {
    if (!isTasksEnabled()) return '';
    const config = configManager.get('agentContext');
    if (config?.tasksTools === false) return '';
  }
  return TASKS_TOOLS_CONTEXT;
}

/**
 * Build the `<relay_connections>` context block showing bound adapters and active chats.
 *
 * Follows the ADR-0069 dual-gate pattern:
 * 1. relayContext must be provided (no deps = no block)
 * 2. Relay feature must be enabled (via isRelayEnabled() or toolConfig)
 * 3. Adapter tools must be enabled (via toolConfig.adapter)
 * 4. Agent must have at least one binding
 */
function buildRelayConnectionsBlock(
  relayContext?: RelayContextDeps,
  toolConfig?: ResolvedToolConfig
): string {
  if (!relayContext) return '';
  if (toolConfig && !toolConfig.adapter) return '';
  if (!toolConfig && !isRelayEnabled()) return '';

  const { agentId, bindingStore, bindingRouter, adapterManager } = relayContext;

  const allBindings = bindingStore.getAll();
  const myBindings = allBindings.filter((b) => b.agentId === agentId);
  if (myBindings.length === 0) return '';

  const adapters = adapterManager.listAdapters();
  const adapterMap = new Map(adapters.map((a) => [a.config.id, a]));

  const lines: string[] = [`Adapters bound to this agent (${agentId}):`];

  for (const binding of myBindings) {
    const adapter = adapterMap.get(binding.adapterId);
    const displayName = adapter?.config?.type ?? binding.adapterId;
    const label = adapter?.config?.label ?? '';
    const state = adapter?.status?.state ?? 'unknown';
    const labelSuffix = label ? ` ${label}` : '';

    lines.push('');
    lines.push(`- ${binding.adapterId} (${displayName}${labelSuffix}) [${state}]`);

    const sessions = bindingRouter.getSessionsByBinding(binding.id);
    if (sessions.length > 0) {
      lines.push('  Active chats:');
      for (const session of sessions) {
        const keyParts = session.key.split(':');
        const channelType = keyParts[1] === 'chat' ? 'DM' : (keyParts[1] ?? 'unknown');
        lines.push(`  - ${session.chatId} (${channelType})`);
      }
    } else {
      lines.push('  No active chats yet (user must message the bot first)');
    }
    lines.push(
      binding.canInitiate
        ? '  Start-conversations permission: ON'
        : '  Start-conversations permission: OFF (reply-only — you cannot message first here)'
    );
  }

  lines.push('');
  lines.push('To message a user on a bound adapter, use relay_notify_user — it resolves the');
  lines.push("chat and enforces the channel's start-conversations permission:");
  lines.push('  relay_notify_user(message="your message", channel="{adapter type or ID}")');

  return `<relay_connections>\n${lines.join('\n')}\n</relay_connections>`;
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
 * Structured for optimal Claude prompt caching — static tool documentation blocks
 * come first (never change), followed by semi-static agent identity (changes only
 * on manifest edit), then stable environment metadata.
 *
 * Dynamic context (git status, peer agents, relay connections, UI state) is
 * intentionally excluded — those are available on-demand via tool calls or
 * prepended to the user message via {@link renderContextEntry} from the
 * per-turn additional-context bag (ADR-0273).
 *
 * @param cwd - Working directory for the session
 * @param toolConfig - Optional resolved tool config for agent-aware block gating
 */
export async function buildSystemPromptAppend(
  cwd: string,
  toolConfig?: ResolvedToolConfig
): Promise<string> {
  // Static tool context blocks (synchronous — config checks only, content never changes)
  const relayBlock = buildRelayToolsBlock(toolConfig);
  const meshBlock = buildMeshToolsBlock(toolConfig);
  const adapterBlock = buildAdapterToolsBlock(toolConfig);
  const tasksBlock = buildTasksToolsBlock(toolConfig);
  const uiBlock = buildUiToolsBlock();
  const genUiBlock = GEN_UI_CONTEXT;

  // Semi-static blocks (async — reads files, but content stable between agent config changes)
  const results = await Promise.allSettled([buildAgentBlock(cwd), buildEnvBlock(cwd)]);

  return [
    // 1. Static tool documentation — fully cacheable, never changes
    relayBlock,
    meshBlock,
    adapterBlock,
    tasksBlock,
    uiBlock,
    genUiBlock,
    // 2. Semi-static identity + env — changes only on agent config or server restart
    ...results
      .filter((r) => r.status === 'fulfilled' && r.value)
      .map((r) => (r as PromiseFulfilledResult<string>).value),
  ]
    .filter(Boolean)
    .join('\n\n');
}

/**
 * Render a single neutral {@link AdditionalContextEntry} into the Claude
 * adapter's tagged block. This is the adapter half of ADR-0273: the server
 * assembles WHAT context exists (structured data); this function decides HOW
 * Claude sees it. The wrapper tag is driven by `CONTEXT_TAG[entry.kind]` — never
 * hardcoded — so a new {@link import('@dorkos/shared/additional-context').ContextKind}
 * only needs its body formatted here, and the render-strip picks up the tag
 * automatically.
 *
 * @param entry - A single assembled context entry.
 */
export function renderContextEntry(entry: AdditionalContextEntry): string {
  const tag = CONTEXT_TAG[entry.kind];
  switch (entry.kind) {
    case 'git_status':
      return wrapTag(tag, formatGitStatus(entry.data));
    case 'ui_state':
      return wrapTag(tag, JSON.stringify(entry.data, null, 2));
    case 'queue_note':
      return `<${tag}>composed while the agent was responding to the previous message</${tag}>`;
    case 'env':
      return wrapTag(tag, formatEnv(entry.data));
    case 'relay_context':
      return wrapTag(tag, formatRelayContext(entry.data));
  }
}

/** Wrap inner content in a `<tag>…</tag>` block on its own lines. */
function wrapTag(tag: string, inner: string): string {
  return `<${tag}>\n${inner}\n</${tag}>`;
}

/**
 * Format structured {@link GitStatusData} into the `<git_status>` body lines
 * (the formatting that moved out of the old `buildGitBlock`).
 */
function formatGitStatus(data: GitStatusData): string {
  if (!data.isRepo) return 'Is git repo: false';

  const lines: string[] = [
    'Is git repo: true',
    `Current branch: ${data.branch}`,
    'Main branch (use for PRs): main',
  ];

  if ((data.ahead ?? 0) > 0) lines.push(`Ahead of origin: ${data.ahead} commits`);
  if ((data.behind ?? 0) > 0) lines.push(`Behind origin: ${data.behind} commits`);
  if (data.detached) lines.push('Detached HEAD: true');

  if (data.clean) {
    lines.push('Working tree: clean');
  } else {
    const parts: string[] = [];
    if ((data.modified ?? 0) > 0) parts.push(`${data.modified} modified`);
    if ((data.staged ?? 0) > 0) parts.push(`${data.staged} staged`);
    if ((data.untracked ?? 0) > 0) parts.push(`${data.untracked} untracked`);
    if ((data.conflicted ?? 0) > 0) parts.push(`${data.conflicted} conflicted`);
    // `deriveGitStatus` always sets `clean` to match the counts, so this branch
    // implies at least one dirty part. Guard the empty case anyway so a partial
    // hand-built `GitStatusData` never renders a bare `dirty ()`.
    lines.push(
      parts.length > 0 ? `Working tree: dirty (${parts.join(', ')})` : 'Working tree: clean'
    );
  }

  return lines.join('\n');
}

/** Format structured {@link EnvData} into the `<env>` body lines. */
function formatEnv(data: EnvData): string {
  return [
    `Working directory: ${data.workingDirectory}`,
    `Product: ${data.product}`,
    `Version: ${data.version}`,
    `Port: ${data.port}`,
    `Platform: ${data.platform}`,
    `OS Version: ${data.osVersion}`,
    `Node.js: ${data.nodeVersion}`,
    `Hostname: ${data.hostname}`,
  ].join('\n');
}

/** Format structured {@link RelayContextData} into the `<relay_context>` body lines. */
function formatRelayContext(data: RelayContextData): string {
  const lines: string[] = [
    `Agent-ID: ${data.agentId}`,
    `Session-ID: ${data.sessionId}`,
    `From: ${data.from}`,
    `Message-ID: ${data.messageId}`,
    `Subject: ${data.subject}`,
    `Sent: ${data.sent}`,
  ];
  if (
    data.hopsUsed !== undefined ||
    data.ttlSecondsRemaining !== undefined ||
    data.callBudgetRemaining !== undefined
  ) {
    lines.push('', 'Budget remaining:');
    if (data.hopsUsed !== undefined && data.hopsMax !== undefined) {
      lines.push(`- Hops: ${data.hopsUsed} of ${data.hopsMax} used`);
    }
    if (data.ttlSecondsRemaining !== undefined) {
      lines.push(`- TTL: ${data.ttlSecondsRemaining} seconds remaining`);
    }
    if (data.callBudgetRemaining !== undefined) {
      lines.push(`- Max turns: ${data.callBudgetRemaining}`);
    }
  }
  if (data.replyTo) {
    lines.push(
      '',
      `Reply to: ${data.replyTo}`,
      "If you cannot complete the task within the budget, summarize what you've done and stop."
    );
  }
  return lines.join('\n');
}

/**
 * Build the `<env>` block with system and DorkOS metadata.
 *
 * All values here are stable for the lifetime of the server process.
 * Dynamic values (date, git status, UI state) are intentionally excluded
 * to maximize Claude's prompt cache hit rate — the SDK's own system prompt
 * already injects the current date.
 */
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
  ];

  return `<env>\n${lines.join('\n')}\n</env>`;
}

/**
 * Build agent identity, persona, and safety boundary blocks from `.dork/` convention files.
 *
 * Reads `agent.json` for identity data and trait values, `SOUL.md` for personality,
 * and `NOPE.md` for safety boundaries. Falls back to the legacy `persona` field
 * when no SOUL.md exists (pre-migration agents).
 *
 * Injection order: identity -> persona (SOUL.md) -> safety boundaries (NOPE.md).
 *
 * @param cwd - Working directory to check for agent manifest and convention files
 * @returns XML block string, or empty string if no manifest
 */
async function buildAgentBlock(cwd: string): Promise<string> {
  const manifest = await readManifest(cwd);
  if (!manifest) return '';

  // Zod v4 + openapi extension drops persona fields from inferred type
  const { persona, personaEnabled, traits, conventions } = manifest as {
    persona?: string;
    personaEnabled?: boolean;
    traits?: Record<string, number>;
    conventions?: { soul?: boolean; nope?: boolean; dorkosKnowledge?: boolean };
  };

  // --- Identity block ---
  const identityLines = [
    `Name: ${manifest.name}`,
    `ID: ${manifest.id}`,
    manifest.description && `Description: ${manifest.description}`,
    manifest.capabilities.length > 0 && `Capabilities: ${manifest.capabilities.join(', ')}`,
  ].filter(Boolean);

  const blocks = [`<agent_identity>\n${identityLines.join('\n')}\n</agent_identity>`];

  // --- Persona block (SOUL.md or legacy persona) ---
  const soulEnabled = conventions?.soul !== false;

  if (soulEnabled) {
    let soulContent = await readConventionFile(cwd, 'SOUL.md');

    if (soulContent) {
      // If SOUL.md has a trait section, regenerate it with current trait values
      if (soulContent.includes(TRAIT_SECTION_START)) {
        const customProse = extractCustomProse(soulContent);
        const traitBlock = renderTraits({ ...DEFAULT_TRAITS, ...traits });
        soulContent = buildSoulContent(traitBlock, customProse);
      }
      blocks.push(`<agent_persona>\n${soulContent}\n</agent_persona>`);
    } else if (personaEnabled !== false && persona) {
      // Legacy fallback: use persona field
      blocks.push(`<agent_persona>\n${persona}\n</agent_persona>`);
    }
  }

  // --- Safety boundaries block (NOPE.md) ---
  const nopeEnabled = conventions?.nope !== false;

  if (nopeEnabled) {
    const nopeContent = await readConventionFile(cwd, 'NOPE.md');
    if (nopeContent) {
      blocks.push(`<agent_safety_boundaries>\n${nopeContent}\n</agent_safety_boundaries>`);
    }
  }

  // --- DorkOS knowledge block (default ON) ---
  if (conventions?.dorkosKnowledge !== false) {
    blocks.push(buildDorkosContextBlock());
  }

  return blocks.join('\n\n');
}

/** Build the `<dorkos_context>` block with platform overview and doc links. */
function buildDorkosContextBlock(): string {
  return `<dorkos_context>
DorkOS is the operating system for autonomous AI agents.
Subsystems: Console (chat), Tasks (scheduling), Relay (messaging), Mesh (discovery).
Documentation: https://dorkos.ai/llms.txt
Full docs: https://dorkos.ai/docs
</dorkos_context>`;
}

/** @internal Exported for testing only. */
export {
  buildAgentBlock as _buildAgentBlock,
  buildRelayToolsBlock as _buildRelayToolsBlock,
  buildMeshToolsBlock as _buildMeshToolsBlock,
  buildAdapterToolsBlock as _buildAdapterToolsBlock,
  buildTasksToolsBlock as _buildTasksToolsBlock,
  buildPeerAgentsBlock as _buildPeerAgentsBlock,
  buildRelayConnectionsBlock as _buildRelayConnectionsBlock,
  buildUiToolsBlock as _buildUiToolsBlock,
  RELAY_TOOLS_CONTEXT as _RELAY_TOOLS_CONTEXT,
  MESH_TOOLS_CONTEXT as _MESH_TOOLS_CONTEXT,
  ADAPTER_TOOLS_CONTEXT as _ADAPTER_TOOLS_CONTEXT,
  TASKS_TOOLS_CONTEXT as _TASKS_TOOLS_CONTEXT,
  UI_TOOLS_CONTEXT as _UI_TOOLS_CONTEXT,
};
