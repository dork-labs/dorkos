/**
 * What DorkOS's own tool gate runs without a card: the two safe-listed tool sets, the per-call
 * rule that still gates some of their calls, and the identity the owner-facing ones need. Read by
 * `canUseTool` (`interactive-handlers.ts`) and by the held turn's hook (`held-turn-hook.ts`, DOR-3204),
 * so the two cannot disagree.
 *
 * @module services/runtimes/claude-code/tool-gate/auto-allow
 */
import { UI_COMMAND_REACH, UiCommandSchema } from '@dorkos/shared/schemas';
import type { PermissionModeId } from '@dorkos/shared/schemas';
import { CHAT_SEND_TOOL, CHAT_STOP_TOOL } from '@dorkos/shared/chat-messages';
import { MEMORY_TOOL_NAMES } from '../../../memory/tool-names.js';
import { inSessionToolName, isHostServedOrUnattributed } from '../mcp-tools/tool-exposure.js';
import { ceilingOn, type CeilingedMode } from '../turn-permission.js';
import type { ToolApprovalContext, ToolGateLogger } from '../messaging/interactive-handlers.js';

// ---------------------------------------------------------------------------
// Auto-approved tool sets (module-level to avoid per-call reconstruction)
// ---------------------------------------------------------------------------

/**
 * Read-only Claude Code tools — cannot modify filesystem or execute shell
 * commands. Auto-allowed in `canUseTool`, so exported for the census guard that
 * keeps every extension tool out of it (DOR-2685).
 */
export const READ_ONLY_TOOLS: ReadonlySet<string> = new Set([
  'Read',
  'Grep',
  'Glob',
  'LS',
  'NotebookRead',
  'WebSearch',
  'WebFetch',
]);

/**
 * DorkOS agent communication tools, auto-approved because they carry their own
 * authorization, NOT because they are read-only. Some of these mutate:
 * `chat_send` starts a turn in another chat and `chat_stop` ends one.
 *
 * The exemption is deliberate. Agents message each other's chats as a matter of
 * course, so a card per message would train the user to dismiss cards without
 * reading them, which weakens every other approval card. What bounds the damage
 * instead is that the server stamps the calling chat as the sender, so a message
 * or a stop can never claim to come from anyone else, and every one lands in a
 * chat a person can open (with each stop also in the audit trail). The Messages
 * permission area is resolved on every call, so a person who wants these asked
 * about or Blocked says so there (spec `spin-off-chats`, ADR 261009-171114).
 *
 * ## Why this is a hand-written list and not derived (DOR-499)
 *
 * This is one of the places DorkOS names a subset of its MCP tools, and the most
 * consequential: everything here is auto-allowed in `canUseTool` without ever
 * asking a person. DOR-499 collapsed three OTHER such lists into one per-tool
 * table (`core/mcp-tool-tiers.ts`, which now carries each tool's permission area
 * as well) and deliberately left this one alone, for the same reason the
 * tokenless read-only carve-out in `core/external-mcp/tool-security.ts` was left
 * alone.
 *
 * It is not the same predicate as any area or tier. An area answers "which
 * permission switch takes this away". A tier answers "does this need approval in
 * general". This list
 * answers the narrower question above: does this tool carry its own authorization,
 * so that a card would add friction without adding safety? That is a hand-picked
 * judgment, not a property of the tier. `chat_send` and
 * `mesh_register` are `act` and are here; plenty of other `act` tools are
 * deliberately not. Deriving the list from `act` + `observe` would auto-admit every
 * future `act` tool to a no-prompt path as a side effect of picking a tier, and
 * that is fail-open on the one axis where it costs something real.
 *
 * So the MEMBERSHIP stays hand-written, and the relationship is pinned in the safe
 * direction instead: `core/__tests__/mcp-tool-gate.test.ts` asserts every name here is
 * a real tool and that none is `destructive`. That catches a rename going stale and a
 * dangerous addition, without letting the tier table grant anything.
 *
 * The QUALIFIED SPELLING is not hand-written, though, and that distinction matters
 * (DOR-1292). These names are matched against what the SDK sends, which is
 * `mcp__<server>__<tool>` — so they used to be typed out with the prefix baked in,
 * in three separate places. Renaming the MCP server would then have silently
 * emptied this set: not a crash, just every DorkOS tool raising an approval card
 * from that moment on, the room verbs included, whose entire purpose is to avoid a
 * card nobody is positioned to answer. Deriving the prefix from
 * {@link inSessionToolName} makes that impossible, and `tool-exposure.test.ts` pins
 * that every entry here starts with it.
 *
 * ## Membership is necessary, not sufficient (DOR-625)
 *
 * A name here means "do not ask ABOUT THE TOOL". It does not mean every call to
 * that tool is auto-allowed, and for one member it must not: `control_ui` is a
 * multiplexer carrying 22 different effects behind one name, and one of them
 * (`apply_layout`) reaches a mutating DorkOS route — `POST /api/shapes/:name/apply`,
 * which writes `SKILL.md` files into a person's own skills root, rewrites their
 * active-Shape config, creates, rebinds and deletes scheduled tasks, and toggles
 * extensions. Not, since DOR-607 and DOR-1486, a schedule running with the prompts
 * off: a manifest's `bypassPermissions` is clamped and the row parks at
 * `pending_approval` until a person approves it. {@link isAutoAllowedCall} makes
 * the final decision per CALL, so a tool on this list can still be per-argument
 * gated. Read the two together — this set alone no longer answers the question.
 */
export const DORKOS_AGENT_TOOLS = new Set(
  [
    // The `rooms` domain, plus the one relay verb that reaches a PERSON. Every one
    // of these is auto-allowed only for a session that HAS an agent identity — see
    // {@link IDENTITY_SCOPED_TOOLS}, which is where the whole argument for them
    // lives.
    'post_to_room',
    'react_to_room_entry',
    'read_room_history',
    'search_room_history',
    // The cross-room half of the same two reads (DOR-1532). Same membership
    // bound, same identity qualifier — see IDENTITY_SCOPED_TOOLS below.
    'list_member_rooms',
    'search_member_rooms',
    // The two lookups (DOR-1610): which room, and who is in it. Same membership
    // bound and the same identity qualifier as every verb above them — both
    // answer from the caller's own roster rows and nothing else.
    'get_room',
    'find_room',
    // Reading the room's shared canvas (DOR-1999). Same membership bound and the
    // same identity qualifier as every read above it: it answers from the
    // caller's own roster rows and nothing else, and its one file-backed answer
    // is narrowed further still — a document whose tree this reader could not
    // already read comes back as its name and nothing more.
    'read_canvas',
    // The verbs that ARRANGE rooms (DOR-1611; `archive_room` from spec
    // `agent-permissions` D12). They carry everything above them plus one bound
    // none of the others has: the Rooms permission, resolved for THIS agent at
    // the capability gate on every call. See IDENTITY_SCOPED_TOOLS.
    'create_room',
    'add_room_members',
    'remove_room_members',
    'update_room',
    'leave_room',
    'archive_room',
    // Asking past a Blocked permission (spec `agent-permissions` D8). Its whole
    // effect is to put a DorkOS card in front of a person, rate-limited per
    // agent before anything is minted; a runtime card asking "may it ask?"
    // first would be a second card for one question. Identity-scoped: without
    // an agent the tool refuses itself.
    'request_permission',
    'relay_notify_user',
    'relay_list_endpoints',
    // Chats messaging chats (spec `spin-off-chats`). The sender is the verified
    // calling chat, never an argument, and each tool refuses without one. In a
    // turn held to a ceiling, `chat_stop` and a steering or interrupting
    // `chat_send` still ask — see isAutoAllowedCall.
    'chat_send',
    'chat_read',
    'chat_stop',
    'mesh_list',
    'mesh_inspect',
    'mesh_discover',
    'mesh_register',
    'mesh_status',
    'mesh_query_topology',
    'get_agent',
    // The agent's own memory, both tools. Always loaded and auto-allowed on
    // identity, for the argument stated in full under IDENTITY_SCOPED_TOOLS below.
    ...MEMORY_TOOL_NAMES,
    // Asking for its OWN conversation to be summarized (DOR-2732). It reaches
    // nothing but the calling session, runs only after the turn ends, at most
    // once an hour, and the owner's say is the DorkOS permission the gate
    // already resolves on every call. A runtime card on top would be a second
    // ask for one question, raised on the turn with the least room to spare.
    'compact_my_session',
    // UI control tools. `get_ui_state` only reads. `control_ui` is the multiplexer
    // — most of its actions only move pixels, but not all of them, so its calls go
    // through `isAutoAllowedCall` below rather than riding this membership alone.
    'control_ui',
    'get_ui_state',
  ].map(inSessionToolName)
);

/**
 * The members of {@link DORKOS_AGENT_TOOLS} whose auto-allow holds only while
 * the SESSION HAS AN AGENT IDENTITY (DOR-1229, extended by DOR-1265).
 *
 * What they have in common is the reason they may skip a card at all: **an
 * identified agent's reach here is bounded to a scope the OWNER already set up**
 * — the rooms she seated it in, and the chats her bindings already let it speak
 * first in. The identity is what makes that sentence true, which is why losing
 * it takes the auto-allow with it. It is a bound on the SCOPE, not a promise
 * about the audience: see the notify section below for how wide the operator can
 * (and by default does) set that scope.
 *
 * What the auto-allow gives up is stated once, here, because it is the same
 * thing for all sixteen: **the per-call card an operator watching a DIRECT session
 * could have denied.** Not the setup consent, which is untouched — a room the
 * agent is not a member of, and a binding nobody switched initiating on for, are
 * both still refused underneath. (Note what that does NOT say: an unclaimed CHAT
 * is not necessarily refused, because a wildcard binding's scope covers the whole
 * adapter. The consent that holds is the one on the binding, not one per chat.)
 *
 * ## Why the rooms verbs need the qualifier
 *
 * The rooms verbs authorize on MEMBERSHIP: each resolves the caller's roster row
 * before doing anything, and the reads answer "not a member" with the same
 * `ROOM_NOT_FOUND` they answer "no such room" with, so a room id is not a
 * capability and a probe learns nothing.
 *
 * **That bound only exists for an AGENT caller**, which is the whole reason this
 * set is separate. Who the caller IS comes from `callerAuthor`
 * (`services/rooms/service/room-caller-author.ts`). From inside a chat with no
 * identity it now refuses (DOR-2863), but it used to fall back to the person who
 * OWNS the install, and every other surface with no identity and no login still
 * does. The owner is exempt from the membership check by design —
 * `seesEveryRoom` short-circuits `canSee`, so every room on the machine is
 * readable, the owner's own DMs with agents included — and an owner-attributed
 * post lands as a human message at cascade depth zero, which triggers every
 * always/mentioned agent in the channel and is bounded by no claim. So without
 * the qualifier these eight would have been a no-prompt path to the operator's
 * whole room history from any ordinary coding session.
 *
 * **`list_member_rooms` and `search_member_rooms` are the widest of the eight, and
 * that is exactly why they are here** (DOR-1532). Every other room verb takes a
 * room id and answers about that one room; these two answer about EVERY room the
 * caller is in at once, from no argument at all. Under an identity that is still
 * the agent's own membership and nothing else — both are built from
 * `room_members` rows for that agent, each room floored at its own `joinedSeq`,
 * which is precisely the grant message-search §7 already gives it. Without one
 * the caller is the install owner, and a single no-argument call would enumerate
 * and then search the operator's whole room history in one hop. The qualifier is
 * what keeps "list the rooms you are in" from meaning "list every room on this
 * machine".
 *
 * **`get_room` and `find_room` are the same argument about a different payload**
 * (DOR-1610). What they hand back is not messages but the SHAPE of the install:
 * a room's topic, its whole roster, and — for `find_room`, from no room id at
 * all — which rooms hold which people. Under an identity that is the agent's own
 * membership, which its roster panel and its own room context block already show
 * it. Without one the caller is the owner, and one uncarded call from any
 * ordinary coding session reads out any room the OPERATOR belongs to and
 * everyone in it — their private DMs with other agents included, which is the
 * part that matters. Note what this does NOT claim: `seesEveryRoom` does not
 * come into it, because both verbs go through `requireMemberRoom`, which wants
 * an explicit member row even from the owner. The exposure is the operator's own
 * rooms rather than every room on the machine, and that is still an ordinary
 * coding session reading somebody's private conversations without being asked.
 *
 * **The verbs that ARRANGE rooms carry one bound more than any verb above
 * them** (DOR-1611, spec `agent-permissions`). `create_room`,
 * `add_room_members`, `remove_room_members`, `update_room`, `leave_room` and
 * `archive_room` sit in the Rooms permission area: `registry.invoke` resolves it
 * for this agent, fresh, on every call — Blocked refuses, Ask raises the gate's
 * own card inside the call, Allowed runs — and no agent can write its own
 * permissions through DorkOS. (One with file tools can edit its manifest; that
 * is honoured and recorded as a change made outside DorkOS, see
 * `services/core/permissions/permission-observer.ts`.) So the auto-allow here is strictly narrower than the eight
 * above: those need only an identity, these need an identity AND a Rooms
 * permission a person set or chose a preset for.
 *
 * They must not raise a SESSION card for the domain's standing reason, and it is
 * sharper for these than for the reads. An agent opens a channel or pulls a
 * colleague in DURING a room turn — that is the moment the work needs it — and
 * DOR-1229 measured what a card costs there: eleven minutes, then an auto-deny.
 * A card would also be asking the person a question she has already answered, on
 * the Permissions page built for it; where she chose Ask, the capability gate
 * raises its own card and holds the call. Without an identity the call resolves
 * against the install's defaults only; this gate still asks rather than
 * inferring harmlessness from another layer, which is the same posture
 * `memory_write` takes below.
 *
 * ## Why `relay_notify_user` is here too (DOR-1265)
 *
 * It is not a rooms verb and it authorizes on nothing like membership — it is
 * here because a note can only land inside a SCOPE THE OPERATOR SET. Two earlier
 * drafts of this comment got the scope wrong in the narrow direction, so it is
 * spelled out:
 *
 * - **Their own DorkOS DM** — the 1:1 they share with this agent, used when no
 *   external chat can carry the note (`relay/notify-dm.ts`, DOR-1209).
 * - **Whatever their bindings already permit this agent to START a conversation
 *   in.** Two operator acts gate that: a binding has to exist, and its "Agent
 *   can start conversations" switch has to be on (`canInitiate`, per binding,
 *   default FALSE). What the scope then COVERS is the operator's choice too, and
 *   it is often wider than one chat: a binding may name a group, a chat with
 *   somebody else, or — with the chat filter left empty, which is the app's
 *   default for a new binding ("Any chat (wildcard)") — **every chat that has
 *   messaged that adapter, including ones nobody claimed**. That is stated
 *   exactly this way in `relay/initiate-consent.ts`: sender scoping does not
 *   narrow a wildcard binding, "because that is the scope the person chose when
 *   they left the chat filter empty".
 *
 * So: a note is NOT necessarily private to the operator, and not necessarily to
 * somebody they hand-picked. It is always inside a scope they configured and
 * switched on. The tool's `channel` argument selects among those bindings; it
 * cannot create one, widen one, or get past `canInitiate`
 * (`resolveNotifyTarget` → `bindingAllowsInitiate`, answered `INITIATE_NOT_ALLOWED`).
 *
 * So what a card here was actually asking was "may this agent use the channel
 * you already gave it, this once" — a fair question in a session somebody is
 * watching, and an unanswerable one in a room turn. Measured live on 2026-08-16:
 * asked in a channel to send a proactive note, the agent's room turn parked on
 * `awaiting_approval` and no message was ever sent, twice on two days.
 *
 * Nothing bounds the frequency by count any more (ADR 261006-225605): a note
 * goes only where the operator configured, and every note lands in the inbox
 * where it can be read back.
 *
 * Without an identity the tool refuses itself — the handler answers
 * `NOT_AN_AGENT` — so the qualifier costs a call nothing today. It is still
 * stated rather than assumed: the gate must not be the layer that decides a call
 * is harmless because some other layer happens to refuse it. (And the two do not
 * resolve identity through the same store — see below.)
 *
 * ## Why `memory_write` is here (DOR-632)
 *
 * It is not a rooms verb either, and its argument is its own — the spec is
 * explicit that "like the room verbs" would conflate the tier with the
 * auto-allow. Three things together are what make a card unnecessary:
 *
 * - **It is jailed to the caller's own file.** There is no path parameter, no
 *   agent parameter, and nothing else the model can name: the target is
 *   `<agentPath>/.dork/MEMORY.md` for the identity this session presented. An
 *   agent cannot reach another agent's memory even by trying, so the card would
 *   be asking about a scope of exactly one file the operator already owns.
 * - **It has no execution semantics.** Nothing here runs, sends, spends, or
 *   leaves the machine. The worst outcome of a bad write is a wrong note in a
 *   small markdown file the operator can open and edit, and `remove` undoes it
 *   from inside.
 * - **Its blast radius is bounded by two mechanisms that hold whether or not a
 *   person is watching**: the file is capped (8,000 characters, refused past
 *   it, never trimmed), and everything in it is injected FENCED and framed as
 *   data, with a handler-written provenance suffix on every note. A poisoned
 *   entry names the room that poisoned it.
 *
 * And the reason it must not raise a card is the same one the room verbs have:
 * the turn that most needs to save something is a room turn, where nobody is
 * positioned to answer. An agent that parked on an approval card to write a
 * note would have learned the thing and then failed to keep it.
 *
 * Without an identity the tool refuses itself — `no-agent`, a plain sentence —
 * so the qualifier costs a call nothing today. It is stated anyway, for the same
 * reason it is stated for `relay_notify_user`: the gate must not be the layer
 * that decides a call is harmless because another layer happens to refuse it.
 *
 * ## Where identity comes from
 *
 * One KEY — the session's identity anchor (its working directory, or the agent
 * a room working copy was handed to, DOR-2091) — resolved here by
 * {@link createInSessionContextResolver}, the same function, with the same
 * argument, that `mcp-tools/index.ts` builds the capability resolver from. For
 * the rooms verbs that is also the same STORE, so this gate and the caller they
 * run as cannot disagree.
 *
 * **`relay_notify_user` is the exception, and not one to paper over.** The gate's
 * answer comes from an unrevoked `agent_identity_tokens` row
 * (`AgentIdentityService.describeAgent`); the tool's sender comes from the MESH
 * registry (`resolveSenderIdentity` → `meshCore.getSubjectByPath`), which it has
 * to, because the relay `from` is an authorization principal that ACL rules match
 * on and only the mesh knows an agent's canonical subject. Two stores, one key.
 * Where they disagree the GATE is the permissive one, so the outcome is a turn
 * that proceeds and gets a structured `NOT_AN_AGENT` back — no card, no note, and
 * a different failure from the one this fix was about. Both directions are pinned
 * in `core/__tests__/mcp-relay-notify-tools.test.ts`.
 *
 * A room turn is handed the addressed agent's own directory, or — in a room
 * with files — its worktree, which anchors back to that agent (DOR-2091). An
 * agent a room dispatched to is in the mesh by construction, so the two agree
 * wherever this was meant to work: the verbs are
 * frictionless there. An ordinary app session in a plain project directory
 * resolves neither, and keeps today's card.
 *
 * ## Why they are auto-allowed at all, once identity holds
 *
 * A room triggers a turn INTO THE DARK — nobody is holding that session's
 * stream — under the runtime's strictest permission mode, so a card raised
 * there is a card nobody is positioned to answer. Measured on 2026-08-16:
 * `search_room_history` asked at 15s, the room said the agent was waiting at
 * 75s, and the turn made no further progress until the interaction window
 * auto-denied it ten minutes later. Eleven minutes to answer one question.
 *
 * It is also what the rooms domain already asks for: "A card on every message
 * an agent posts into its own room would be the over-tiering that teaches
 * people to click through", with the writes bounded by mechanisms instead — the
 * cascade guard and the two-ceiling turn budget for a post. This list was the
 * one place not told.
 */
export const IDENTITY_SCOPED_TOOLS = new Set(
  [
    'post_to_room',
    'react_to_room_entry',
    'read_room_history',
    'search_room_history',
    'list_member_rooms',
    'search_member_rooms',
    'get_room',
    'find_room',
    'read_canvas',
    'create_room',
    'add_room_members',
    'remove_room_members',
    'update_room',
    'leave_room',
    'archive_room',
    'request_permission',
    'relay_notify_user',
    ...MEMORY_TOOL_NAMES,
  ].map(inSessionToolName)
);

/** The multiplexer on {@link DORKOS_AGENT_TOOLS}: one name, 22 different effects. */
const CONTROL_UI_TOOL = inSessionToolName('control_ui');

/** The qualified chat-send and chat-stop names, for {@link isAutoAllowedCall}. */
const CHAT_SEND_QUALIFIED = inSessionToolName(CHAT_SEND_TOOL);
const CHAT_STOP_QUALIFIED = inSessionToolName(CHAT_STOP_TOOL);

/**
 * Whether one CALL to a safe-listed tool may skip the approval card, given its
 * arguments (DOR-625).
 *
 * Every safe-listed tool answers `true` except `control_ui`, whose verdict is
 * per-action: {@link UI_COMMAND_REACH} classifies each of the 22 UI commands, and
 * only the `client-only` ones skip. The classification is a total `Record` over
 * the command union, so a new UI command cannot be added without `tsc` demanding
 * a verdict for it.
 *
 * **Fails closed twice.** An input the command union rejects has no known action,
 * so there is nothing to look up and the call asks — "no rule" is never consent.
 * And a call that is not auto-allowed is not denied here either: it falls through
 * to {@link resolveModeDecision}, which raises a card in every mode but
 * `bypassPermissions`.
 *
 * **A turn held to a ceiling cannot cut into another chat unasked.** A turn
 * another agent's message or an outside sender started carries a permission
 * ceiling, and trust never extends to strangers. So in such a turn `chat_stop`,
 * and `chat_send` with `delivery` `steer` or `interrupt` (or any value that is
 * not the default `queue`), ask. A queued `chat_send` and `chat_read` still skip
 * the card: they only add a message to a chat a person can read.
 *
 * **A stranger's turn cannot read past its folder unasked** (spec `official-community-space`
 * D10). The CLI asks about a read only when it reaches outside the agent's folder, or the web;
 * under a stranger's ceiling those go to the mode table too, which asks, as the mode that asks
 * would. Otherwise any stranger's question could read the computer and post what it found.
 *
 * @param toolName - The tool the model called.
 * @param input - The raw arguments it called with.
 * @param ceiling - What bounds the gate now: nothing, a ceiling, or a stranger's (`ceilingOn`).
 * @returns `true` to skip the card, `false` to hand the call to the mode table.
 */
function isAutoAllowedCall(
  toolName: string,
  input: Record<string, unknown>,
  ceiling: ReturnType<typeof ceilingOn>
): boolean {
  if (ceiling !== 'none') {
    if (toolName === CHAT_STOP_QUALIFIED) return false;
    if (toolName === CHAT_SEND_QUALIFIED) return (input.delivery ?? 'queue') === 'queue';
  }
  if (ceiling === 'stranger' && READ_ONLY_TOOLS.has(toolName)) return false;
  if (toolName !== CONTROL_UI_TOOL) return true;
  const parsed = UiCommandSchema.safeParse(input);
  if (!parsed.success) return false;
  return UI_COMMAND_REACH[parsed.data.action] === 'client-only';
}

/**
 * Whether this session resolves to an agent identity, for the owner-facing gate
 * ({@link IDENTITY_SCOPED_TOOLS}).
 *
 * **Fails CLOSED, and that is the whole point of not inlining it.** The resolver
 * reads the agent index off disk, and a throw there must mean "ask", never "skip
 * the card". What is on the other side differs per verb — for the four rooms
 * verbs an unresolved caller becomes the person who OWNS the install, who sees
 * every room on the machine; for `relay_notify_user` it is a message to a person
 * sent by a session nobody can name — and neither is something to wave through
 * because a disk read failed. `createInSessionContextResolver` already swallows
 * its own errors, so this catch is the belt to that braces: a future resolver
 * that throws cannot silently widen the auto-allow.
 *
 * @param resolveIdentity - The memoized session-identity resolver.
 * @param log - Where a failed lookup is reported.
 */
export async function hasAgentIdentity(
  resolveIdentity: () => Promise<unknown>,
  log: ToolGateLogger
): Promise<boolean> {
  try {
    // An `identity`, not merely an answer: a session standing in a working copy
    // nobody can vouch for answers `agentIdentityPresented` with no identity
    // (DOR-2091), and that is a machine this gate cannot name — so it asks.
    const context = await resolveIdentity();
    return (
      typeof context === 'object' &&
      context !== null &&
      (context as { identity?: unknown }).identity !== undefined
    );
  } catch (err) {
    log.info('[canUseTool] could not resolve this session identity; asking instead', {
      error: err instanceof Error ? err.message : String(err),
    });
    return false;
  }
}

/**
 * Whether DorkOS's own gate lets a call run without a card, on everything but
 * the caller's identity: a call to one of the two safe-listed tool sets
 * ({@link READ_ONLY_TOOLS}, {@link DORKOS_AGENT_TOOLS}), served by the server
 * DorkOS registered, that {@link isAutoAllowedCall} also clears. The
 * owner-facing subset then also needs an agent identity
 * ({@link IDENTITY_SCOPED_TOOLS}); {@link dorkosAutoAllows} asks both.
 *
 * Safe-list membership is necessary but not sufficient: `isAutoAllowedCall` has
 * the last word, so a multiplexer tool can still be gated per argument
 * (DOR-625). A call this refuses is not denied; it goes to the mode table.
 *
 * @param session - The session's mode and ceilings.
 * @param toolName - The tool the model called.
 * @param input - Its arguments.
 * @param mcpServer - The serving MCP server, when Claude Code sent one.
 */
export function autoAllowedByCall(
  session: CeilingedMode<PermissionModeId>,
  toolName: string,
  input: Record<string, unknown>,
  mcpServer: ToolApprovalContext['mcpServer']
): boolean {
  return (
    (READ_ONLY_TOOLS.has(toolName) || DORKOS_AGENT_TOOLS.has(toolName)) &&
    // The name says "a DorkOS tool"; only the provenance can say the call is
    // served by the server DorkOS registered. A configured server that named
    // itself `dorkos` presents the same `mcp__dorkos__…` names.
    isHostServedOrUnattributed(mcpServer) &&
    isAutoAllowedCall(toolName, input, ceilingOn(session))
  );
}

/**
 * Whether DorkOS's own gate lets a call run without a card. Read by
 * `canUseTool` and by the held turn's hook (`held-turn-hook.ts`), so the two
 * cannot disagree.
 *
 * @param session - The session's mode and ceilings.
 * @param toolName - The tool the model called.
 * @param input - Its arguments.
 * @param mcpServer - The serving MCP server, when Claude Code sent one.
 * @param resolveIdentity - The memoized session-identity resolver.
 * @param log - Where a failed identity lookup is reported.
 */
export async function dorkosAutoAllows(
  session: CeilingedMode<PermissionModeId>,
  toolName: string,
  input: Record<string, unknown>,
  mcpServer: ToolApprovalContext['mcpServer'],
  resolveIdentity: () => Promise<unknown>,
  log: ToolGateLogger
): Promise<boolean> {
  return (
    autoAllowedByCall(session, toolName, input, mcpServer) &&
    (!IDENTITY_SCOPED_TOOLS.has(toolName) || (await hasAgentIdentity(resolveIdentity, log)))
  );
}
