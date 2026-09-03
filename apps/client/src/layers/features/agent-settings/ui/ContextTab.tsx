import { useCallback } from 'react';
import { AGENT_SUBJECT_FORMAT } from '@dorkos/shared/relay-schemas';
import { useRelayEnabled } from '@/layers/entities/relay';
import { Badge, FieldCard, FieldCardContent, SettingRow, Switch } from '@/layers/shared/ui';
import { useAgentContextConfig } from '../model/use-agent-context-config';

/**
 * What Claude Code prepends to every in-session DorkOS tool name.
 *
 * Written out here because the constant that owns it lives in the server
 * (`mcp-tools/tool-exposure.ts`) and the client cannot import server code. The
 * previews below are a SUMMARY of the real blocks, not the blocks themselves —
 * see {@link RELAY_PREVIEW} — but a tool name written without this prefix is one
 * the model cannot call, so a person reading this panel must not learn the short
 * form (DOR-1292).
 */
const TOOL_PREFIX = 'mcp__dorkos__';

/**
 * A plain-language summary of the `<relay_tools>` block, for the person deciding
 * whether to inject it.
 *
 * NOT the block itself. The real text is assembled server-side
 * (`runtimes/claude-code/messaging/context-builder.ts`), varies per session, and
 * is not reachable from the client — so this is a second telling of the same
 * facts, and second tellings drift. It drifted once already: it taught the
 * two-segment `relay.agent.{agentId}`, which matches no namespace access rule
 * and is refused (DOR-1337). The subject format is therefore interpolated from
 * {@link AGENT_SUBJECT_FORMAT} rather than typed out, and
 * `__tests__/ContextTab.test.tsx` pins the rest against that constant.
 *
 * **Two known divergences, both deliberate, neither worth "fixing" blind.**
 * This preview is ABRIDGED — the server block also lists the two ephemeral
 * `relay.inbox.query/dispatch` subjects — and the two texts pad their columns to
 * different widths, so a diff of the two files never lines up and a
 * character-equality test between them would be red on arrival. What must match
 * is the FACTS, which is what the test above pins.
 *
 * That is also why the `Tasks scheduler events` line here was left alone by the
 * DOR-1490 rename while the rest of the product moved to "scheduled tasks":
 * these words are model-facing prompt text, not UI copy, and the two copies have
 * to say the same thing. Renaming one side only is precisely the drift this
 * comment exists to warn about. Rename both, in one change, or neither.
 */
const RELAY_PREVIEW = `DorkOS Relay is a pub/sub message bus for inter-agent communication.

Subject hierarchy:
  ${AGENT_SUBJECT_FORMAT}   — an agent's inbox. Take it from the relaySubject field
                                     of ${TOOL_PREFIX}mesh_list rather than assembling one:
                                     it is the address every access rule is written against.
  relay.inbox.{agentId}            — your own persistent reply inbox
  relay.human.console.{clientId}   — reach a human in the DorkOS UI
  relay.system.console             — system broadcast channel
  relay.system.tasks.{scheduleId}  — Tasks scheduler events

Workflows:
- Find who to talk to: ${TOOL_PREFIX}mesh_list() — every entry carries its relaySubject
- Ask and wait: ${TOOL_PREFIX}relay_send_and_wait(to_subject=<their relaySubject>, payload={...})
- Dispatch and poll: ${TOOL_PREFIX}relay_send_async(...) then ${TOOL_PREFIX}relay_inbox(endpoint_subject=<inbox>, ack=true)
- See who is listening: ${TOOL_PREFIX}relay_list_endpoints()

Your sender identity is set by the server — there is no "from" parameter. Set "replyTo" so the
recipient knows where to respond.

Inboxes are private: you can only read or unregister your own address, an inbox handed to you by
${TOOL_PREFIX}relay_send_async, or one you registered yourself. Reading with ack=true deletes the
messages it returns, for good.

A reply that carries "error" means the other agent's turn FAILED; its text is partial work, not an
answer.

Error codes: RELAY_DISABLED (feature off), ACCESS_DENIED (namespace pair not allowed),
ENDPOINT_ACCESS_DENIED (not your endpoint), RESERVED_SUBJECT (server-managed namespace),
INVALID_SUBJECT (malformed), ENDPOINT_NOT_FOUND (inbox miss), AGENT_ERROR (their turn failed),
TIMEOUT, REJECTED.`;

const MESH_PREVIEW = `DorkOS Mesh is a local agent registry for discovering and communicating with AI agents on this machine.

Agent lifecycle:
1. ${TOOL_PREFIX}mesh_discover(roots=["/path"]) — scan directories for agent candidates (looks for AGENTS.md, .dork/agent.json)
2. ${TOOL_PREFIX}mesh_register(path, name, runtime, capabilities) — register a candidate as a known agent
3. ${TOOL_PREFIX}mesh_inspect(agentId) — get full manifest, health status, and relay endpoint
4. ${TOOL_PREFIX}mesh_status() — aggregate overview: total, active, stale agent counts
5. ${TOOL_PREFIX}mesh_list(runtime?, capability?) — filter agents by runtime or capability; every entry carries its relaySubject
6. ${TOOL_PREFIX}mesh_deny(path, reason) — exclude a path from future discovery
7. ${TOOL_PREFIX}mesh_unregister(agentId) — remove an agent from the registry
8. ${TOOL_PREFIX}mesh_query_topology(namespace?) — view agent network from a namespace perspective

Workflows:
- Find agents: ${TOOL_PREFIX}mesh_list() then ${TOOL_PREFIX}mesh_inspect(agentId) for details
- Contact another agent: take their relaySubject from ${TOOL_PREFIX}mesh_list, then ${TOOL_PREFIX}relay_send
- Register this project: ${TOOL_PREFIX}mesh_register(path=cwd, name="project-name", runtime="claude-code")

Runtimes: claude-code | cursor | codex | other`;

const ADAPTER_PREVIEW = `Relay adapters bridge external platforms (Telegram, webhooks) to the agent message bus.

Subject conventions for external messages:
  relay.human.telegram.{chatId}    — send to / receive from Telegram
  relay.human.webhook.{webhookId}  — send to / receive from webhooks

Adapter management:
- ${TOOL_PREFIX}relay_list_adapters() — see all adapters and their status (connected, disconnected, error)
- ${TOOL_PREFIX}relay_enable_adapter(id) / ${TOOL_PREFIX}relay_disable_adapter(id) — toggle an adapter on/off
- ${TOOL_PREFIX}relay_reload_adapters() — hot-reload config from disk

Bindings route adapter messages to agent projects:
- ${TOOL_PREFIX}binding_list() — see current adapter-to-agent bindings
- ${TOOL_PREFIX}binding_create(adapterId, agentId) — route an adapter to an agent
- ${TOOL_PREFIX}binding_delete(id) — remove a binding

Session strategies: per-chat (default, one session per conversation), per-user (shared across chats), stateless (new session each message).`;

interface ContextBlockSectionProps {
  label: string;
  description: string;
  enabled: boolean;
  available: boolean;
  unavailableReason?: string;
  onToggle: (value: boolean) => void;
  preview: string;
}

function ContextBlockSection({
  label,
  description,
  enabled,
  available,
  unavailableReason,
  onToggle,
  preview,
}: ContextBlockSectionProps) {
  const effective = available && enabled;

  return (
    <section className="space-y-2">
      <SettingRow label={label} description={description}>
        <div className="flex items-center gap-2">
          {!available && (
            <Badge variant="secondary" className="text-xs">
              {unavailableReason}
            </Badge>
          )}
          <Switch
            checked={enabled}
            onCheckedChange={onToggle}
            disabled={!available}
            aria-label={`Toggle ${label} context`}
          />
        </div>
      </SettingRow>
      {effective && (
        <pre className="bg-muted max-h-40 overflow-y-auto rounded-md p-3 text-xs leading-relaxed">
          {preview}
        </pre>
      )}
    </section>
  );
}

/**
 * Context tab for the Agent Settings dialog.
 *
 * Displays toggle switches for each tool context block (relay, mesh, adapter)
 * with read-only previews of the XML content injected into agent system prompts.
 *
 * The labels are the plain names the Settings Tools tab uses for the same three
 * groups (`settings/config/tool-inventory.ts`) — never the subsystem behind
 * them, which ADR 260804-021140 keeps out of the app's chrome.
 */
export function ContextTab() {
  const relayEnabled = useRelayEnabled();
  const { config, updateConfig } = useAgentContextConfig();

  const handleToggle = useCallback(
    (key: 'relayTools' | 'meshTools' | 'adapterTools', value: boolean) => {
      updateConfig({ [key]: value });
    },
    [updateConfig]
  );

  return (
    <div className="space-y-4">
      <p className="text-muted-foreground text-sm">
        Control which tool usage instructions are injected into the agent system prompt. These
        blocks teach the agent how to use DorkOS tools together.
      </p>

      <FieldCard>
        <FieldCardContent>
          <ContextBlockSection
            label="Messaging"
            description="How to send messages, where to send them, and what the errors mean."
            enabled={config.relayTools}
            available={relayEnabled}
            unavailableReason="Messaging is off"
            onToggle={(v) => handleToggle('relayTools', v)}
            preview={RELAY_PREVIEW}
          />

          <ContextBlockSection
            label="Agent discovery"
            description="How to find other agents, register new ones, and work with them."
            enabled={config.meshTools}
            available={true}
            onToggle={(v) => handleToggle('meshTools', v)}
            preview={MESH_PREVIEW}
          />

          <ContextBlockSection
            label="Connection management"
            description="How to set up Telegram, Slack and webhooks, and route each chat to an agent."
            enabled={config.adapterTools}
            available={relayEnabled}
            unavailableReason="Messaging is off"
            onToggle={(v) => handleToggle('adapterTools', v)}
            preview={ADAPTER_PREVIEW}
          />
        </FieldCardContent>
      </FieldCard>
    </div>
  );
}
