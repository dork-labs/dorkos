/**
 * The permission tier of every hand-registered MCP tool, written down once
 * (DOR-468).
 *
 * ## Why this table exists at all
 *
 * DorkOS sorts what an agent can do into three tiers, and `destructive` is the one
 * that stops and asks a person. Until this table, only the 15 Capability Registry
 * capabilities carried a tier. The other 47 agent-facing MCP tools are registered
 * by hand across two servers and carried none, so `tasks_delete` ("Delete a Tasks
 * schedule permanently") ran without asking while `marketplace.uninstall` did not.
 *
 * ## Why a table, and not a `tier:` field at each registration
 *
 * Because the two registration sites demonstrably drift. The same tool is written
 * out twice today — once in `runtimes/claude-code/mcp-tools/` for the in-session
 * `dorkos` server and once in `core/external-mcp/` for the external `/mcp` server —
 * and five of those pairs already disagree about their own DESCRIPTION, one
 * (`mesh_discover`) disagrees about its INPUT SCHEMA, and seven tools exist on only
 * one of the two servers. Writing a tier at 47 registrations twice over would add
 * one more hand-copied fact to a set that has already proven it drifts, on the one
 * axis where drifting is a security hole rather than a typo.
 *
 * So the tier is keyed by TOOL NAME, and a tool has exactly one tier no matter
 * where it is registered. That is also the whole answer for a tool that exists on
 * one server only: it has one entry, and if it later gains a second registration,
 * the second one inherits the tier it already had. This mirrors the annotation
 * table next door (`mcp-tool-metadata.ts`), which is the same pattern for the same
 * reason.
 *
 * ## What a tier does and does not promise
 *
 * A tier governs WHETHER A CALL NEEDS A PERSON'S APPROVAL. It says nothing about
 * what the call's arguments are allowed to contain. An `act` tool can still take an
 * argument that turns off some other safety system, and labeling it `act` here is
 * not a claim that it cannot. Do not read a full table as a governed domain.
 *
 * `tasks_create` and `tasks_update` were the worked example of that gap: both
 * accept a `permissionMode` argument, and `tasks_update` applied it, so an `act`
 * call could hand a future unattended run the safety prompts its caller did not
 * have. The answer was NOT a higher tier — a card on every schedule edit is the
 * over-tiering that teaches people to click through — but a policy on the FIELD,
 * in `tasks/task-write-policy.ts` (DOR-504). Both tools stay `act`. If you find
 * another argument of this shape, that is the pattern to copy.
 *
 * Only `destructive` changes runtime behavior. `observe` returns allowed before any
 * other check runs, and `act` passes the gate. Labeling all 47 anyway is the point:
 * the gate refuses to register a tool that has no entry here, so the NEXT tool
 * somebody adds cannot quietly arrive untiered.
 *
 * ## Adding a tool
 *
 * Add its entry here, or the MCP server will not build. Sort by tier the way the
 * rest of the codebase sorts by blast radius: does the person lose something they
 * would have to rebuild from scratch (`destructive`), does the call change
 * something they can put back (`act`), or does it only read (`observe`)? Prefer the
 * lower tier when it is close. An approval card in front of routine work teaches
 * people to click Allow without reading, and that makes every other card weaker.
 *
 * @module services/core/mcp-tool-tiers
 */
import type { CapabilityTier } from '@dorkos/shared/capabilities';
import type { GatedAction } from './capabilities/tier-enforcement.js';

/** One tool's tier declaration. */
export interface McpToolTier {
  /**
   * What a person loses if this goes wrong. `destructive` is the only tier that
   * stops and asks; see the module TSDoc for how to choose.
   */
  tier: CapabilityTier;
  /**
   * Human-facing title, written for the person reading an approval card or a
   * refusal in their Activity feed — not for the model, which reads the tool's own
   * description. Say what happens to them, not what the code does.
   */
  title: string;
  /**
   * The argument names the approval card may show, most consequential first.
   *
   * Required on `destructive` (a card with no arguments asks a person to approve
   * an irreversible action without telling them which one), and pointless on the
   * other two tiers, which never build a card. Pinned in both directions by
   * `__tests__/mcp-tool-gate.test.ts`.
   */
  approvalDisplayFields?: readonly string[];
}

/**
 * Every hand-registered MCP tool, with its tier.
 *
 * Grouped by domain and ordered as the registration files order them, so this
 * table can be read side by side with `runtimes/claude-code/mcp-tools/` and
 * `core/external-mcp/`. Tools marked "in-session only" have no external `/mcp`
 * registration today; see the module TSDoc for why that changes nothing here.
 */
export const MCP_TOOL_TIERS = {
  // ── Core ────────────────────────────────────────────────────────────────
  ping: { tier: 'observe', title: 'Check that DorkOS is answering' },
  get_server_info: { tier: 'observe', title: 'Read server information' },
  get_session_count: { tier: 'observe', title: "Count an agent's sessions" },
  get_agent: { tier: 'observe', title: "Read an agent's setup file" },

  // ── Tasks ───────────────────────────────────────────────────────────────
  tasks_list: { tier: 'observe', title: 'List scheduled tasks' },
  // Creates the schedule already parked at `pending_approval`, so a person has to
  // approve it before it ever runs. A second card here would ask the same question
  // twice.
  tasks_create: { tier: 'act', title: 'Create a scheduled task' },
  // Can overwrite a schedule's prompt and cron with no history, which is real. The
  // answer to "no history" is an audit trail, not a card on every edit.
  tasks_update: { tier: 'act', title: 'Change a scheduled task' },
  // `deleteTask` is a bare DELETE with no trash and no undo (`tasks/task-store.ts`).
  // The person rebuilds the prompt, the schedule, and the timezone from memory.
  tasks_delete: {
    tier: 'destructive',
    title: 'Delete a scheduled task',
    approvalDisplayFields: ['id'],
  },
  tasks_get_run_history: { tier: 'observe', title: "Read a scheduled task's run history" },

  // ── Relay: messaging ────────────────────────────────────────────────────
  relay_send: { tier: 'act', title: 'Send a message to another agent' },
  // Not `observe`: `ack: true` DESTROYS each acknowledged message. It unlinks the
  // payload file from the maildir (`packages/relay/src/maildir-store.ts`), leaving
  // only the index row, so later reads come back with `payload: null`. It stays
  // `act` for the same reason `relay_unregister_endpoint` does — this is the
  // ordinary way a caller drains its own inbox, and a card on every drain is the
  // fastest way to teach someone to stop reading cards.
  relay_inbox: { tier: 'act', title: 'Read and clear the message inbox' },
  relay_list_endpoints: { tier: 'observe', title: 'List message endpoints' },
  relay_register_endpoint: { tier: 'act', title: 'Create a message endpoint' },
  relay_send_and_wait: { tier: 'act', title: 'Send a message and wait for the reply' },
  relay_send_async: { tier: 'act', title: 'Send a message without waiting' },
  // This one deletes a maildir, undelivered messages and all. It is still `act`,
  // and deliberately: it is the documented last step of every async send, so the
  // tool's own description tells the agent to call it on each `done: true`. A card
  // in front of routine cleanup is the fastest way to teach someone to stop reading
  // cards.
  relay_unregister_endpoint: { tier: 'act', title: 'Remove a message endpoint' },
  // In-session only. Already consent-gated by the binding's `canInitiate` flag,
  // which is the right gate for "may this reach the person at all".
  relay_notify_user: { tier: 'act', title: 'Send the person a message' },

  // ── Relay: chat connections ─────────────────────────────────────────────
  relay_list_adapters: { tier: 'observe', title: 'List chat connections' },
  relay_enable_adapter: { tier: 'act', title: 'Turn a chat connection on' },
  relay_disable_adapter: { tier: 'act', title: 'Turn a chat connection off' },
  relay_reload_adapters: { tier: 'act', title: 'Reload chat connections' },

  // ── Relay: traces and counters ──────────────────────────────────────────
  relay_get_trace: { tier: 'observe', title: 'Read a message trace' },
  relay_get_metrics: { tier: 'observe', title: 'Read messaging counters' },

  // ── Chat routes ─────────────────────────────────────────────────────────
  binding_list: { tier: 'observe', title: 'List chat routes' },
  binding_create: { tier: 'act', title: 'Create a chat route' },
  // Settings, not content: five fields the cockpit can put back in under a minute,
  // and no messages are lost with it.
  binding_delete: { tier: 'act', title: 'Remove a chat route' },
  // In-session only.
  binding_list_sessions: { tier: 'observe', title: 'List active chat sessions' },

  // ── Mesh ────────────────────────────────────────────────────────────────
  // Not `observe`: the scan auto-imports every agent file it walks past.
  mesh_discover: { tier: 'act', title: 'Scan for agents' },
  mesh_register: { tier: 'act', title: 'Register an agent' },
  mesh_list: { tier: 'observe', title: 'List registered agents' },
  mesh_deny: { tier: 'act', title: 'Block a path from future scans' },
  // Worse than its name: it deletes the agent's `.dork/agent.json` from disk, tears
  // down its Relay endpoint (which removes that endpoint's maildir), and cascades
  // into disabling the agent's scheduled tasks. One call, three kinds of the
  // person's own data. It already refuses system agents, which is the domain
  // saying out loud that it knew.
  mesh_unregister: {
    tier: 'destructive',
    // The title is the sentence a person reads before clicking Allow, so it says
    // "turns off" rather than "deletes": the task cascade sets `enabled: false,
    // status: 'paused'`, it does not remove the schedules. Overstating the loss on
    // a card is its own kind of dishonest.
    title: 'Remove an agent and its setup file, and turn off its scheduled tasks',
    approvalDisplayFields: ['agentId'],
  },
  mesh_status: { tier: 'observe', title: 'Read mesh health' },
  mesh_inspect: { tier: 'observe', title: 'Inspect one agent' },
  mesh_query_topology: { tier: 'observe', title: 'Read the agent network layout' },

  // ── Agents ──────────────────────────────────────────────────────────────
  create_agent: { tier: 'act', title: 'Create a new agent workspace' },

  // ── Extensions ──────────────────────────────────────────────────────────
  get_extension_api: { tier: 'observe', title: 'Read the extension API reference' },
  list_extensions: { tier: 'observe', title: 'List extensions' },
  get_extension_errors: { tier: 'observe', title: 'Read extension errors' },
  // Cannot clobber: the scaffolder throws when the directory already exists, so
  // this only ever writes into a fresh one.
  create_extension: { tier: 'act', title: 'Scaffold a new extension' },
  reload_extensions: { tier: 'act', title: 'Reload extensions' },
  test_extension: { tier: 'act', title: 'Compile and test an extension' },

  // ── Cockpit and preview (in-session only) ───────────────────────────────
  // A third copy of this tool is registered on the codex-scoped `dorkos_ui`
  // server, which does NOT go through the gate. That is a runtime no-op for an
  // `act` tool, and it is stated rather than glossed: if this tool were ever
  // promoted, that server would need the gated registrar first.
  control_ui: { tier: 'act', title: 'Drive the DorkOS cockpit' },
  get_ui_state: { tier: 'observe', title: "Read the cockpit's state" },
  browser_read_console: { tier: 'observe', title: "Read the preview's console log" },
  browser_read_network: { tier: 'observe', title: "Read the preview's network log" },
  // Not `observe`, even though the output is only a picture: taking it injects a
  // script into the live preview page. Calling that "only reads" is a small lie,
  // and `act` costs nothing because it never prompts.
  browser_screenshot: { tier: 'act', title: 'Take a screenshot of the preview' },
} as const satisfies Record<string, McpToolTier>;

/** The name of a hand-registered MCP tool that carries a tier. */
export type McpToolName = keyof typeof MCP_TOOL_TIERS;

/**
 * The {@link GatedAction} for a hand-registered MCP tool, ready to hand to the
 * tier gate.
 *
 * The action's `id` is the tool name itself. Capability ids always contain a dot —
 * the compiler enforces it, `CapabilityDefinition.id` is typed
 * `` `${string}.${string}` `` — and tool names never do, so the two id spaces
 * cannot collide in an approval binding or in the Activity feed. The tool half of
 * that invariant has no type to lean on (these are plain object keys), so it is
 * asserted in `__tests__/mcp-tool-gate.test.ts` instead.
 *
 * Throws on an unknown name rather than defaulting, and the choke point calls this
 * for every tool when the server is BUILT, not when a tool is called. So a tool
 * added without an entry fails the server's construction on the first session
 * instead of running ungated until somebody notices.
 *
 * @param toolName - The registered MCP tool name.
 * @returns The action the tier gate decides on.
 * @throws If no tier is declared for `toolName`.
 */
export function gatedActionForMcpTool(toolName: string): GatedAction {
  const declared = (MCP_TOOL_TIERS as Record<string, McpToolTier | undefined>)[toolName];
  if (!declared) {
    throw new Error(
      `MCP tool "${toolName}" is registered but declares no permission tier. Add it to ` +
        `MCP_TOOL_TIERS in services/core/mcp-tool-tiers.ts. Every agent-facing tool needs a ` +
        `tier, so that "this one needs a person's approval" is a decision somebody made rather ` +
        `than a line nobody wrote.`
    );
  }
  return {
    id: toolName,
    title: declared.title,
    tier: declared.tier,
    ...(declared.approvalDisplayFields
      ? { approvalDisplayFields: declared.approvalDisplayFields }
      : {}),
  };
}
