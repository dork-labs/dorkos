import { renderDocEvents } from '../../../canvas/doc-channel/prompt.js';
import { formatAccountsAccess } from '../../shared/accounts-access-context.js';
import { formatContextWarning } from '../../../session/agent-compaction/context-warning-block.js';
import type {
  AdditionalContextEntry,
  GitStatusData,
  EnvData,
  RelayContextData,
} from '@dorkos/shared/additional-context';
import { CONTEXT_TAG } from '@dorkos/shared/additional-context';
import { isRelayEnabled } from '../../../relay/relay-state.js';
import { isTasksEnabled } from '../../../tasks/task-state.js';
import type { ToolDocGates } from './tool-doc-gates.js';
import { GEN_UI_CONTEXT } from '../../shared/gen-ui-context.js';
import { buildAgentContextAppend } from '../../shared/agent-context.js';
import type { AgentHome } from '../../../core/agent-identity/index.js';
import { buildRoomToolsBlock } from '../../shared/room-tools-context.js';
import { buildCanvasContentCatalog, buildUiActionCatalog } from '../../shared/ui-tool-contract.js';
import { formatRoomContext } from '../../shared/room-context-block.js';
import { formatApprovalVerdict } from '../../shared/approval-verdict-block.js';
import { formatSeedContext } from '../../shared/seed-context-block.js';
import { formatStagedContext } from '../../shared/staged-context-block.js';
import type { AgentRegistryPort } from '@dorkos/shared/agent-runtime';
import { IN_SESSION_TOOL_PREFIX } from '../mcp-tools/tool-exposure.js';
import { WORKBENCH } from '../../../../config/constants.js';
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

/**
 * Shorthand for {@link IN_SESSION_TOOL_PREFIX} inside this file's template
 * literals, where it is interpolated in front of ~90 tool names.
 *
 * Every block below writes `${T}chat_send` rather than `chat_send` because the
 * short name is not a tool: Claude Code exposes the in-session server's tools as
 * `mcp__dorkos__*`, and a model that copies the prose gets `No such tool
 * available` for anything else (DOR-1292). `__tests__/context-tool-names.test.ts`
 * diffs every name written here against the live tool server.
 */
const T = IN_SESSION_TOOL_PREFIX;

/**
 * The one block that explains the naming, so the ~90 long names below read as a
 * rule rather than as noise.
 *
 * It also answers the second half of the failure. Tool search is on in this SDK, so
 * an MCP server's tools are DEFERRED by default — absent from the turn-1 prompt,
 * reachable only through `ToolSearch`. Measured on Haiku: it searched
 * `select:react_to_room_entry`, got "No matching deferred tools found", and gave up,
 * while `select:mcp__dorkos__marketplace_get` resolved first try in the run next door.
 *
 * Deferral IS switchable — `createSdkMcpServer` takes `alwaysLoad`, and so does
 * `tool()`'s fifth argument (verified against the real factory, not the type
 * declarations). DorkOS uses it for a few tools on every session, four more on a
 * session that IS a registered mesh agent, and declines it for the rest:
 * eighty-odd schemas on every turn's prompt is a worse trade than one search. So
 * this block still teaches the search, because for most of the surface it is still
 * the way in. See `mcp-tools/tool-exposure.ts` for which and why.
 *
 * WHICH of the two sentences this renders is not cosmetic. The prompt claiming a
 * tool is loaded when it is deferred spends the turn it was written to save. The
 * flag is therefore decided by `loadsAgentToAgentTools` — the same function
 * `mcp-tools/index.ts` decides exposure with — over the same input, the
 * SESSION'S cwd rather than the turn's (see the call site in
 * `launch-resolver.ts` for why the difference matters) (DOR-1337 / F8).
 *
 * @param agentToAgentToolsPreloaded - True when the four agent-to-agent tools ride
 *   this session's turn-1 prompt.
 * @param messagesAllowed - False when the Messages area is Blocked for this
 *   agent. The chat tools are then not in its list at all, so the sentence that
 *   names them as loaded is left out, by the same answer `<chat_tools>` uses.
 */
function dorkosToolsContext(agentToAgentToolsPreloaded: boolean, messagesAllowed = true): string {
  const preloaded =
    agentToAgentToolsPreloaded && messagesAllowed
      ? `The room tools, ${T}list_capabilities, and — because you are a registered agent —
${T}mesh_list, ${T}mesh_inspect, ${T}chat_send and ${T}chat_read are already in your
tool list. Call any of them straight away, with no lookup step.`
      : `The room tools and ${T}list_capabilities are already in your tool list — call them
straight away, with no lookup step.`;

  return `<dorkos_tools>
In the tool blocks below — the ones whose tags end in _tools — every DorkOS tool is
written the only way you can call it: in full, starting ${T}. Copy the whole
string. Dropping that start does not give you a shorter alias for the same tool; it
gives you a name that is not a tool at all, and the call comes back "No such tool
available". Prose elsewhere may instead describe a tool by the END of its name,
because other runtimes reach these same tools under a different prefix; on THIS
runtime the prefix is always ${T}.

${preloaded}

Any OTHER tool you do not see there is deferred, not missing. Load it by its full
name and then call it:
  ToolSearch(query="select:${T}marketplace_get")
A search for the short form finds nothing.

Those blocks are not the whole surface. ${T}list_capabilities() returns the full
catalog of what you can do on this machine — settings, agents, connectors, the
marketplace — with each entry's id and input schema. Ask it before concluding that
something cannot be done here.
</dorkos_tools>`;
}

/**
 * Build the `<chat_tools>` block's text: how this agent messages other chats,
 * checks on them, stops them, and tells a helper from a spin-off chat
 * (spec `spin-off-chats` §7).
 *
 * Written only for an agent session, so it can say the tools are already
 * loaded: that is the same fact `mcp-tools/tool-exposure.ts` decides exposure
 * with. See {@link buildChatToolsBlock} for the session that is not an agent.
 *
 * **Reaching the person** rides Relay (`relay_notify_user`), so that paragraph is
 * written only when Relay is on; the chat tools themselves need no bus.
 *
 * @param relayOn - Whether Relay is on, which `relay_notify_user` needs.
 */
function chatToolsContext(relayOn: boolean): string {
  const loadingNote = `${T}mesh_list, ${T}mesh_inspect, ${T}chat_send and ${T}chat_read are already in your
tool list — no ToolSearch step before you use them.`;

  const reachingThePerson = relayOn
    ? `

Reaching the person:
- When your CURRENT message has a <relay_context> block: respond naturally. Your response
  is automatically forwarded to the sender.
- Otherwise, to reach the person when they are not looking at this chat: use
  ${T}relay_notify_user(message="…"). It resolves the bound chat (Telegram, Slack) and honors
  that channel's "agent may start conversations" permission — if that permission is off it
  returns INITIATE_NOT_ALLOWED instead of sending. With no external channel connected it
  posts into your direct message with them inside DorkOS, so a stock install is never
  silent; the reply's "surface" says which one it used. The bound chat may be a GROUP or a
  conversation with someone other than your operator, so write the message to be read by
  whoever is in that chat, never as a private aside. You get a limited number of these per
  hour — anything you could say in the conversation you are already in belongs there
  instead. Naming a channel (channel="{adapter type or ID}") means that channel or nothing.
- ${T}chat_send is for other chats and agents, never for the person.`
    : '';

  return `<chat_tools>
A chat is a conversation with an agent. Chats message chats: every message you send
lands in a chat a person can open and read, marked with your name and this chat.

${loadingNote}

There is no "from" parameter. The server stamps every message with you and this chat,
so you cannot send as anyone else, and the other side always knows who wrote it.

Message a chat or an agent:
  ${T}chat_send(to=<chat id or agent id>, message="…", summary="a few words")
  - A chat id posts into that chat. An agent id posts into your own direct chat with
    that agent, started on the first message. ${T}mesh_list() lists the agents.
  - delivery="queue" (the default) waits until that chat's current turn ends; an idle
    chat starts at once. delivery="steer" joins its running turn now. delivery="interrupt"
    stops its running turn and runs your message next. Use the default unless the other
    chat must change course right now.
  - replyTo=<message id> when you answer a message another chat sent you.
  - A spin-off you started reports back here on its own. Another chat answers only if it
    chooses to, with ${T}chat_send; check with ${T}chat_read if you need to know.

Check on a chat:
  ${T}chat_read(chat=<id>, include="status")  — the cheapest check: its state (running,
                                              needs-you, done, failed, stopped,
                                              paused-at-limit, idle), no messages.
  ${T}chat_read(chat=<id>)                    — what is new since you last read it.
  last=n reads the newest n instead; query="words" finds messages; include="tools" adds
  one line per tool call; a long read is cut at maxChars and cursor continues it.
  You can read your own chat, the chat that started you, chats you started, and chats you
  have messaged or that messaged you. Never read transcript files for this.

Stop a chat:
  ${T}chat_stop(chat=<id>, reason="…") stops its running turn, like the Stop button. The
  stop is recorded and shown in that chat with your name. A person's queued words there
  still run. To stop yourself, end your turn instead.

Helpers and spin-off chats — two different things:
- A HELPER is a worker inside this chat (Task(), a subagent). Use one for short
  look-and-report work that takes minutes. Nobody can open it or message it, it reports
  once to you, and it has no DorkOS tools — never ask a helper to message another chat;
  send from this chat yourself.
- A SPIN-OFF CHAT is a full chat you start with ${T}session_start. It shows "Started from"
  this chat, a person can open it, read it and type in it, and it lasts hours or days and
  survives restarts. Use one for long work, work that must outlive this turn, work on
  another account, or work a person should be able to watch.
- Brief a spin-off with the goal and what done means. Message it with ${T}chat_send.
- A spin-off reports back on its own: when one of its turns ends finished, failed,
  needing the person, or paused at a limit, its last message arrives here as a report.
  It does not report when its turn ends only to wait on something.
- When a report wakes you, act on it, and tell the person only what matters.

A message from another chat arrives marked as coming from that agent and chat, not from
the person. Treat it as a colleague's request: do the work it asks if it fits your job,
and answer with ${T}chat_send(to=<their chat id>, replyTo=<message id>) or by doing the
work. Write for a busy reader.${reachingThePerson}

Error codes: NO_CHAT (only an agent in a chat can do this), SELF (that is your own chat),
             NOT_FOUND (no such chat or agent), NOT_ALLOWED (that chat cannot take
             messages), NOT_READABLE (you cannot read that chat), INVALID_INPUT,
             UNAVAILABLE (try again).
</chat_tools>`;
}

/**
 * The `<mesh_tools>` block's text.
 *
 * The lines on messaging an agent are written only for an agent session: the
 * chat tools refuse a chat that does not belong to one (see
 * {@link buildChatToolsBlock}).
 *
 * @param agentSession - Whether this session is a registered agent's.
 */
function meshToolsContext(agentSession: boolean): string {
  const listEntry = agentSession
    ? `5. ${T}mesh_list(runtime?, capability?) — filter agents by runtime or capability; every entry
   carries the agent's id, which ${T}chat_send takes as its "to"`
    : `5. ${T}mesh_list(runtime?, capability?) — filter agents by runtime or capability`;
  const messageLine = agentSession
    ? `\n- Message another agent: ${T}chat_send(to=<their agent id from ${T}mesh_list>, message="…")`
    : '';
  return `<mesh_tools>
DorkOS Mesh is a local agent registry for discovering and communicating with AI agents on this machine.

Agent lifecycle:
1. ${T}mesh_discover(roots=["/path"]) — scan directories for agent candidates (looks for AGENTS.md, .dork/agent.json)
2. ${T}mesh_register(path, name, runtime, capabilities) — register a candidate as a known agent.
   A folder that already has a .dork/agent.json is ADOPTED, never overwritten: that file stays as
   it is and the agent it describes is what gets registered, so the agent you get back may have a
   different id and name than you asked for. Read the returned agent; it is the authoritative one.
3. ${T}mesh_inspect(agentId) — get full manifest and health status
4. ${T}mesh_status() — aggregate overview: total, active, stale agent counts
${listEntry}
6. ${T}mesh_deny(path, reason) — exclude a path from future discovery
7. ${T}mesh_unregister(agentId) — remove an agent from the registry
8. ${T}mesh_query_topology(namespace?) — view agent network from a namespace perspective

Workflows:
- Find agents: ${T}mesh_list() then ${T}mesh_inspect(agentId) for details${messageLine}
- Register this project: ${T}mesh_register(path=cwd, name="project-name", runtime="claude-code")
  — if the project already has a .dork/agent.json, this adopts that agent instead of creating one,
  and the name and runtime you pass are ignored rather than written over it

Runtimes: claude-code | cursor | codex | other
</mesh_tools>`;
}

const ADAPTER_TOOLS_CONTEXT = `<adapter_tools>
Relay adapters bridge external platforms (Telegram, webhooks) to the agent message bus.

To message a human on an external channel, use ${T}relay_notify_user(message="…",
channel="{adapter type or ID}") — never publish a relay.human.* subject directly. The bus
addresses external chats with these subjects internally; they are how inbound messages arrive
and how your automatic replies are routed, NOT a send target for you:
  relay.human.telegram.{adapterId}.{chatId}        — Telegram DM
  relay.human.telegram.{adapterId}.group.{chatId}  — Telegram group
  relay.human.slack.{adapterId}.{chatId}            — Slack channel/DM
  relay.human.webhook.{webhookId}                   — Webhook

The {adapterId} is the adapter's ID from ${T}relay_list_adapters() (e.g., "telegram-lifeos").
Whether you may start a conversation on a channel is a per-binding permission ("agent may
start conversations"); ${T}relay_notify_user enforces it and reports INITIATE_NOT_ALLOWED when off.
A binding may cover a group chat, or a chat with someone other than your operator, so treat
anything you send this way as read by everyone in that chat.

Adapter management:
- ${T}relay_list_adapters() — see all adapters and their status (connected, disconnected, error)
- ${T}relay_enable_adapter(id) / ${T}relay_disable_adapter(id) — toggle an adapter on/off
- ${T}relay_reload_adapters() — hot-reload config from disk

Bindings route adapter messages to agent projects:
- ${T}binding_list() — see current adapter-to-agent bindings
- ${T}binding_create(adapterId, agentId, projectPath) — route an adapter to an agent
- ${T}binding_delete(id) — remove a binding

Session strategies: per-chat (default, one session per conversation), per-user (shared across chats), stateless (new session each message).
</adapter_tools>`;

/**
 * The Tasks tool docs, plus the one place an agent is told durable CronCreate
 * is not a scheduler under DorkOS (DOR-2717). The CLI writes a durable job to
 * `.claude/scheduled_tasks.json` and fires it only while a CLI process for the
 * session that owns it is running and idle; a different session will not run
 * it. DorkOS holds a warm process for session-only timers, which the Stop
 * hook's `session_crons` names, but that list is the in-memory store only, so
 * a durable job holds nothing and dies quietly with the next idle reap. Tasks
 * is the scheduler that runs whether or not a chat is open.
 */
const TASKS_TOOLS_CONTEXT = `<tasks_tools>
DorkOS Tasks lets you create and manage scheduled agent runs.

Available tools:
  ${T}tasks_list() -- list all configured schedules
  ${T}tasks_create(name, cron, prompt, ...) -- create a new schedule (enters pending_approval)
  ${T}tasks_update(id, ...) -- modify schedule settings
  ${T}tasks_delete(id) -- remove a schedule
  ${T}tasks_get_run_history(scheduleId) -- view past run results

Schedules can target a specific agent (by agentId) or a directory (by cwd).
Agent-linked schedules automatically resolve the agent's project path at run time.

Claude Code's own CronCreate with durable: true is not reliable here: its job fires only
while this chat's Claude Code process is running, and DorkOS ends idle processes. Use
${T}tasks_create for anything that must run on a schedule. Session-only timers
(CronCreate, ScheduleWakeup, /loop) are fine for a reminder later in this chat.
</tasks_tools>`;

const MARKETPLACE_TOOLS_CONTEXT = `<marketplace_tools>
DorkOS Marketplace lets you find, inspect, and install packages (agents, plugins,
skill packs, adapters), and scaffold new ones into the user's personal marketplace.

Read-only lookups:
  ${T}marketplace_search(query?, type?, category?, tags?, marketplace?, limit?) -- search every enabled source (limit defaults to 20)
  ${T}marketplace_get(name, marketplace?) -- full manifest + README for one package
  ${T}marketplace_list_marketplaces() -- configured sources (name, source, enabled, package count)
  ${T}marketplace_list_installed(type?, checkUpdates?, verify?) -- what is installed, one entry per scope (global | agent-local | override); checkUpdates adds update.status/latestVersion (slower: fetches each marketplace); verify adds integrity (clean | modified | unknown) with the changed files (slower: reads every shipped file)
  ${T}marketplace_recommend(context, type?, limit?) -- keyword/tag-matched suggestions for a free-text need (limit defaults to 5)

Mutations -- ${T}marketplace_install, ${T}marketplace_update (with apply), ${T}marketplace_uninstall,
${T}marketplace_create_package -- all require explicit user confirmation through the SAME two-call protocol:
  1. Call the tool without confirmationToken. A requires_confirmation response means the user
     has not approved yet -- show them the preview and STOP. Do not assume approval and do not
     retry in a loop; nothing resumes this for you.
  2. Once the user has approved (in the DorkOS UI, or by telling you to proceed), re-call the
     SAME tool with confirmationToken set to the value that response returned. The token is
     single-use and bound to the exact package/marketplace/scope you first asked about --
     changing any of those on the retry invalidates it.

  ${T}marketplace_install(name, marketplace?, projectPath?, confirmationToken?)
  ${T}marketplace_update(names?, installPaths?, projectPath?, apply?, confirmationToken?) -- without apply, only checks
     what has a newer version and changes nothing; with apply, reinstalls the stale ones where they are installed
  ${T}marketplace_uninstall(name, purge?, projectPath?, confirmationToken?)
  ${T}marketplace_create_package(name, type, description, author?, categories?, confirmationToken?)
</marketplace_tools>`;

const UI_TOOLS_CONTEXT = `<ui_tools>
DorkOS UI control lets you manipulate the client interface.

Available tools:
  ${T}control_ui(action, ...) -- send a UI command to the client
  ${T}get_ui_state() -- query current UI state (panels, sidebar, canvas, active agent)

Actions:
${buildUiActionCatalog({ indent: '  ', sentences: false })}

The <canvas> that open_canvas and update_canvas take is EXACTLY ONE of these shapes:
${buildCanvasContentCatalog({ indent: '    ', sentences: false })}

Each action's full description is on the ${T}control_ui tool itself — read it there before a first call.
Use ${T}get_ui_state() before making layout decisions to avoid redundant commands. It reflects the state the client reported at turn start plus the commands you issued this turn — not a live read.
UI commands only take visible effect when an interactive client is attached (headless/scheduled runs accept them but show nothing), and a canvas push to a document somebody is editing is held rather than applied — a success result means "accepted", not "displayed".

PUTTING SOMETHING ON A ROOM. The six canvas actions take an optional target with a room id, which
puts the document on that room's shared canvas instead of this window. You have to be a member of
the room: one you are not in answers "No such room", the same answer a room that does not exist
gives. Everyone in the room sees it, and one line saying what you put there is posted when your
turn ends -- it starts nobody's turn. Three per room per turn; the other actions ignore a target.

THE BROWSER TAB. A page you opened with browser_navigate is one DorkOS is serving, so you can use it
and not only look at it -- click it, type into it, and read it back:
  ${T}browser_read_page(documentId?, selector?) -- what is on the page, one line per thing.
  ${T}browser_click(role?, name?, text?, selector?, nth?, documentId?) -- click one of them.
  ${T}browser_type(text, role?, name?, clear?, submit?, documentId?) -- put text in a field.
  ${T}browser_press(key, documentId?) -- one key or chord at whatever has focus.
  ${T}browser_scroll(by?, to?, role?, name?, documentId?) -- move the page.
  ${T}browser_wait_for(text?, selector?, fetchIdle?, timeoutMs?, documentId?) -- let the page catch up.
Read the page first: the names it prints are the names the other five take. This works only on a
preview DorkOS serves or proxies -- a page loaded straight from the internet is shown, not driven,
and says so in a sentence rather than making you wait. With more than one browser tab open, leave
documentId out to act in the one whose window last brought a preview to the front -- almost always
the one you want. Every one of these six answers with the tab it acted on and that tab's id, so to
stay on one tab, pass back the id the last answer gave you. In a room, ${T}get_ui_state lists the
open tabs with their ids as well; in a one-on-one session it does not.

RECORDING WHAT YOU DID. When showing somebody what happens is clearer than describing it, record it:
  ${T}browser_record_start(documentId?) -- start filming; every action after this takes a frame.
  ${T}browser_record_stop() -- stop, save the file, and get its path back.
It is a slideshow of the steps you took, not a video, and it saves into your own working directory.
The stop gives you the last frame as a picture and the path to the file; post the file to a room
with ${T}post_to_room to show it to somebody, rather than describing it in prose. One recording at a
time, and it keeps the first ${WORKBENCH.MAX_RECORDING_FRAMES} frames -- past that it stops filming and
everything else keeps working.
</ui_tools>`;

/**
 * Build the static `<ui_tools>` context block.
 *
 * Its two lists are GENERATED from `UiCanvasContentSchema` and `UiCommandSchema`
 * by the catalogs in `runtimes/shared/ui-tool-contract.ts`, which is also what
 * the tool's own description is composed from — so the block and the tool can no
 * longer name different sets. Hand-written, they had drifted to 10 content types
 * here against 6 on the tool and 14 in the schema. The block names each action
 * and shape without the per-action sentence: it rides the cached system-prompt
 * prefix, and the sentence is one tool-description read away.
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
 * Build the static `<marketplace_tools>` context block.
 *
 * Included unless the Tools & packages area is Blocked for this agent, in which
 * case the tools it documents are not in the agent's list either (spec
 * `agent-permissions` D15). There is no feature flag to check. DOR-529 added
 * this block for parity: it was the only tool group with zero
 * system-prompt context, `relay`/`mesh`/`adapter`/`tasks` all had one. This closes
 * that gap on its own merits; it is not a fix for the eval-awareness defect the
 * same ticket found — every credentialed run measured against the marketplace
 * install eval resolved the tool's schema on the first `ToolSearch` call with no
 * context block at all, so nothing here changes tool DISCOVERY. It is defensible
 * only about discovery, though: the block's own text ("show them the preview and
 * STOP... do not retry in a loop") is a behavioral instruction aimed at the exact
 * behavior the eval measures, so it can plausibly shift how often a model retries
 * on turn 1 — that is a claim about outcomes this change does not get to make.
 *
 * What decides whether the agent can CALL these tools is its permission, which
 * the gate resolves on every call; this block only describes them. It documents
 * `marketplace_install` / `marketplace_uninstall` / `marketplace_create_package`'s
 * confirmation-token protocol accurately for that reason.
 *
 * @param toolConfig - The agent's tool-doc gates, when the caller resolved them.
 */
function buildMarketplaceToolsBlock(toolConfig?: ToolDocGates): string {
  if (toolConfig && !toolConfig.packages) return '';
  return MARKETPLACE_TOOLS_CONTEXT;
}

/**
 * Build the `<chat_tools>` context block.
 *
 * Only an agent session gets it. The chat tools answer NO_CHAT to a chat that
 * does not belong to an agent, so teaching them there is noise that ends in a
 * refusal. `agentSession` is `loadsAgentToAgentTools`'s answer, the same one
 * that decides whether the tools are loaded at all.
 *
 * When `toolConfig` is provided, uses the agent's gates (`toolDocGates`): the
 * block goes with the Messages area. Without one, the chat tools are always
 * there, so the block is too; only its paragraph on reaching the person follows
 * the Relay feature flag.
 *
 * @param toolConfig - Pre-resolved tool config, when the caller has one.
 * @param agentSession - Whether this session is a registered agent's.
 */
function buildChatToolsBlock(toolConfig?: ToolDocGates, agentSession = false): string {
  if (!agentSession) return '';
  if (toolConfig && !toolConfig.messages) return '';
  return chatToolsContext(toolConfig ? toolConfig.relay : isRelayEnabled());
}

/**
 * Build the `<mesh_tools>` context block.
 *
 * When `toolConfig` is provided, uses the agent's gates (`toolDocGates`).
 * Mesh is always-on per ADR-0062, so there is no feature flag to fall back to.
 * The lines on messaging an agent also need the Messages area.
 *
 * @param toolConfig - Pre-resolved tool config, when the caller has one.
 * @param agentSession - Whether this session is a registered agent's.
 */
function buildMeshToolsBlock(toolConfig?: ToolDocGates, agentSession = false): string {
  if (toolConfig && !toolConfig.mesh) return '';
  return meshToolsContext(agentSession && (!toolConfig || toolConfig.messages));
}

/**
 * Build the `<adapter_tools>` context block.
 *
 * When `toolConfig` is provided, uses the agent's gates (`toolDocGates`).
 * Otherwise falls back to the Relay feature flag.
 */
function buildAdapterToolsBlock(toolConfig?: ToolDocGates): string {
  if (!(toolConfig ? toolConfig.adapter : isRelayEnabled())) return '';
  return ADAPTER_TOOLS_CONTEXT;
}

/**
 * Build the `<tasks_tools>` context block.
 *
 * When `toolConfig` is provided, uses the agent's gates (`toolDocGates`).
 * Otherwise falls back to the Tasks feature flag.
 */
function buildTasksToolsBlock(toolConfig?: ToolDocGates): string {
  if (!(toolConfig ? toolConfig.tasks : isTasksEnabled())) return '';
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
  toolConfig?: ToolDocGates
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
        // Say which of the two a session is. The old line called every
        // chat-scoped session a "DM" — including group chats — and printed a
        // per-user session's person id as though it were a chat.
        lines.push(
          session.scope === 'user'
            ? `  - person ${session.userId} (one session per person)`
            : `  - chat ${session.chatId}`
        );
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
  lines.push(`To message a user on a bound adapter, use ${T}relay_notify_user — it resolves`);
  lines.push("the chat and enforces the channel's start-conversations permission:");
  lines.push(`  ${T}relay_notify_user(message="your message", channel="{adapter type or ID}")`);

  return `<relay_connections>\n${lines.join('\n')}\n</relay_connections>`;
}

/**
 * Build the `<peer_agents>` context block with a summary of registered agents.
 *
 * Uses `listWithPaths()` for lightweight agent data including project paths.
 * Returns an empty string when the agent registry is unavailable or no agents are registered.
 *
 * @param meshCore - Optional agent registry port for agent data access
 * @param agentSession - Whether this session is a registered agent's; only one
 *   can message a peer, so only one is told how
 */
async function buildPeerAgentsBlock(
  meshCore: AgentRegistryPort | null | undefined,
  agentSession = false
): Promise<string> {
  if (!meshCore) return '';
  try {
    const agents = meshCore.listWithPaths().slice(0, 10);
    if (agents.length === 0) return '';
    // The name a person reads, not the addressing slug — this block introduces
    // colleagues, and `chat_send` to an id from `mesh_list` is how one is reached, so
    // the slug buys nothing here and misnames every agent that has a real name
    // (DOR-1264).
    const lines = agents.map((a) => `- ${a.displayName ?? a.name} (${a.projectPath})`).join('\n');
    const howToMessage = agentSession
      ? `\n\nTo message a peer: take its id from ${T}mesh_list(), then ${T}chat_send(to=<their agent id>, message="…").`
      : '';
    return `<peer_agents>\nRegistered agents on this machine (use ${T}mesh_list() for live data):\n${lines}${howToMessage}\n</peer_agents>`;
  } catch {
    return '';
  }
}

/**
 * The claude-code system-prompt append, in the two forms the adapter needs.
 *
 * `text` is what goes on the prompt. `stable` is what the relaunch fingerprint
 * digests — the same append with the agent's own `<agent_memory>` block left
 * out, assembled without it rather than cut out of `text`. Without the split, a
 * `memory_write` would move `pins.systemPromptAppend` and tear down the warm
 * process on nearly every turn that saved a note.
 */
export interface SystemPromptAppend {
  /** The whole append, in order. Hand this to `systemPrompt.append`. */
  readonly text: string;
  /** The append minus `<agent_memory>`. Digest this for a relaunch pin. */
  readonly stable: string;
}

/**
 * Build a system prompt append string containing runtime context.
 *
 * Structured for optimal Claude prompt caching — static tool documentation blocks
 * come first (never change), followed by the runtime-neutral agent identity and
 * environment blocks from {@link buildAgentContextAppend} (which change only on
 * manifest edit or server restart).
 *
 * This function owns only the Claude-SPECIFIC half: documentation for the
 * in-session MCP tools this runtime is given. Everything a Codex or OpenCode
 * agent also needs (identity, persona, safety boundaries, `<dorkos_context>`,
 * `<env>`) lives in `runtimes/shared/agent-context.ts` and is shared with those
 * adapters rather than duplicated.
 *
 * Because the Claude-specific half is the half that names tools, it is also the
 * only half allowed to spell `mcp__dorkos__` (DOR-1292). Every tool it names is
 * rendered through {@link T}; `__tests__/context-tool-names.test.ts` diffs the
 * result against the live in-session server and fails if the two disagree, in
 * either direction.
 *
 * Dynamic context (git status, peer agents, relay connections, UI state) is
 * intentionally excluded — those are available on-demand via tool calls or
 * prepended to the user message via {@link renderContextEntry} from the
 * per-turn additional-context bag (ADR-0273).
 *
 * @param home - The home of the agent this session acts as, resolved through
 *   `resolveAgentHome`, or `undefined` for a session about a directory. The
 *   agent's identity, persona and memory are read from here and nowhere else
 *   (spec `agent-home-desk` I1).
 * @param cwd - Working directory for the session (the `<env>` block)
 * @param toolConfig - The agent's tool-doc gates (`toolDocGates`), when the
 *   caller resolved them; without them only the server feature flags decide
 * @param options - Per-session facts the prose has to agree with. `agentSession`
 *   is `loadsAgentToAgentTools`'s answer for THIS session — the same function
 *   and the same input `mcp-tools/index.ts` decides exposure with — so the
 *   prompt's "already in your tool list" is true whenever it says so
 *   (DOR-1337 / F8). Callers must not compute it themselves.
 */
export async function buildSystemPromptAppend(
  home: AgentHome | undefined,
  cwd: string,
  toolConfig?: ToolDocGates,
  options: { agentSession?: boolean; blockedAreaLines?: string } = {}
): Promise<SystemPromptAppend> {
  const agentSession = options.agentSession ?? false;

  // Static tool context blocks (synchronous — config checks only, content never changes)
  const chatBlock = buildChatToolsBlock(toolConfig, agentSession);
  const meshBlock = buildMeshToolsBlock(toolConfig, agentSession);
  const adapterBlock = buildAdapterToolsBlock(toolConfig);
  const tasksBlock = buildTasksToolsBlock(toolConfig);
  const marketplaceBlock = buildMarketplaceToolsBlock(toolConfig);
  // Rendered under THIS runtime's prefix. The body moved to `runtimes/shared/`
  // when the DorkOS tools reached codex and opencode (DOR-1613); claude-code
  // always carries them in-process, so it is always rendered here.
  //
  // **Read HERE, at append time, and that costs nothing — the fingerprint is
  // what makes it safe** (spec `tool-only-room-replies` §D11). This append is
  // built once per session launch rather than per turn, which looks like it
  // would leave a warm session holding the block it launched with. It does not:
  // `stable` below is assembled from these same `toolDocs`, so the room block is
  // digested into the relaunch fingerprint, and flipping the experiment changes
  // the digest and forces the relaunch. A warm session cannot carry a menu
  // written in the wrong tense past the next turn.
  //
  // (An earlier revision of this comment claimed a one-relaunch lag and argued
  // it was survivable because the per-turn `<room_context>` block is mode-aware
  // anyway. The second half is true and the first half was not — the mechanism
  // that closes it was three lines below.)
  const roomBlock = buildRoomToolsBlock(IN_SESSION_TOOL_PREFIX);
  const uiBlock = buildUiToolsBlock();
  const genUiBlock = GEN_UI_CONTEXT;

  // Runtime-neutral identity + env (async: reads files, but content is stable
  // between agent config changes)
  const agentContext = await buildAgentContextAppend(home, cwd);

  // 1. Static tool documentation — fully cacheable, never changes.
  //    The naming rule comes first, because every block after it is written in
  //    the long form it explains (DOR-1292).
  const toolDocs = [
    dorkosToolsContext(agentSession, !toolConfig || toolConfig.messages),
    chatBlock,
    meshBlock,
    adapterBlock,
    tasksBlock,
    marketplaceBlock,
    roomBlock,
    // One line per Blocked permission area, telling the agent the area exists and
    // how to get it (spec `agent-permissions` D15). Empty when nothing is blocked.
    // Part of the digested tool docs, so a change relaunches a warm session.
    options.blockedAreaLines ?? '',
    uiBlock,
    genUiBlock,
  ];

  // 2. Semi-static identity + env — changes only on agent config or server
  //    restart — in its two forms. `stable` is assembled from the same tool docs
  //    and the memory-free half of the agent context, so the agent's own notes
  //    are absent from it by construction rather than by removal. See
  //    `agent-context.ts`'s `buildAgentBlock` for why that distinction is a
  //    security property and not a nicety.
  return {
    text: [...toolDocs, agentContext.text].filter(Boolean).join('\n\n'),
    stable: [...toolDocs, agentContext.stable].filter(Boolean).join('\n\n'),
  };
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
    case 'doc_events':
      return renderDocEvents(entry.data);
    case 'git_status':
      return wrapTag(tag, formatGitStatus(entry.data));
    case 'ui_state':
      return wrapTag(tag, JSON.stringify(entry.data, null, 2));
    case 'queue_note':
      return `<${tag}>composed while the agent was responding to the previous message</${tag}>`;
    case 'staged_context':
      // Shared with Codex and OpenCode for the same reason as `seed_context`:
      // the body is a person's prose and carries a defused-tag security seam, so
      // it is written once and reads identically on every runtime.
      return wrapTag(tag, formatStagedContext(entry.data));
    case 'env':
      return wrapTag(tag, formatEnv(entry.data));
    case 'relay_context':
      return wrapTag(tag, formatRelayContext(entry.data));
    case 'room_context':
      // Shared with the Codex and OpenCode adapters on purpose: the body carries
      // an untrusted-input fence, and a security surface written three times is
      // one that holds in one place and leaks in the other two.
      //
      // The prefix is the one thing the shared writer cannot know: it names the
      // posting tool in the tool-only closing directive, and this runtime spells
      // it differently from OpenCode (DOR-1292).
      return wrapTag(tag, formatRoomContext(entry.data, { toolPrefix: IN_SESSION_TOOL_PREFIX }));
    case 'seed_context':
      // Shared for the same reason, one step milder: the body carries the
      // sentence that tells the reader the person cannot see this block, and
      // that sentence must read identically on every runtime.
      return wrapTag(tag, formatSeedContext(entry.data));
    case 'accounts_access':
      return wrapTag(tag, formatAccountsAccess(entry.data, 'claude-code'));
    case 'approval_verdict':
      // Shared for the strongest version of the room_context reason: this block
      // reports a SECURITY decision, and one written three times is one that
      // says "DorkOS decided this" on one runtime and dumps JSON on the other
      // two — which is exactly what the default arm in the Codex and OpenCode
      // renderers would have done.
      return wrapTag(tag, formatApprovalVerdict(entry.data));
    case 'context_warning':
      // Shared so the note names tools each runtime can actually call.
      return wrapTag(tag, formatContextWarning(entry.data, 'claude-code'));
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

/** @internal Exported for testing only. */
export {
  buildChatToolsBlock as _buildChatToolsBlock,
  buildMeshToolsBlock as _buildMeshToolsBlock,
  buildAdapterToolsBlock as _buildAdapterToolsBlock,
  buildTasksToolsBlock as _buildTasksToolsBlock,
  buildMarketplaceToolsBlock as _buildMarketplaceToolsBlock,
  buildPeerAgentsBlock as _buildPeerAgentsBlock,
  buildRelayConnectionsBlock as _buildRelayConnectionsBlock,
  buildUiToolsBlock as _buildUiToolsBlock,
  dorkosToolsContext as _dorkosToolsContext,
  ADAPTER_TOOLS_CONTEXT as _ADAPTER_TOOLS_CONTEXT,
  TASKS_TOOLS_CONTEXT as _TASKS_TOOLS_CONTEXT,
  MARKETPLACE_TOOLS_CONTEXT as _MARKETPLACE_TOOLS_CONTEXT,
  UI_TOOLS_CONTEXT as _UI_TOOLS_CONTEXT,
};
