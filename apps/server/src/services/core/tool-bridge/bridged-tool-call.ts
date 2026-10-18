/**
 * The hub's side of the tool bridge (DOR-2939 part 6, `specs/everything-is-
 * a-space/design-agent-computers.md` §3): an agent working on an agent
 * computer calls a DorkOS tool, the computer sends it to the hub as
 * `tools.call`, and the hub runs it there, as that agent, with that agent's
 * permissions. `tools.list` answers which tools the agent may see now.
 *
 * Transport-agnostic: the relay (part 5) hands each decoded call here with the
 * computer its connection proved, and sends back what this returns. Nothing
 * here throws across, and nothing from inside the hub crosses either: every
 * failure is `{ ok: false, code, message }` with a fixed code and sentence
 * (`bridge-guards.ts`), never a path, a stack or a raw error.
 *
 * ## What the hub trusts
 *
 * Only what it can check itself, in this order:
 *
 * 1. the computer is within its sliding-window budget, and so is the turn;
 * 2. external MCP is on (`mcp.enabled`), as `/mcp` requires;
 * 3. the agent works on this connection's computer ({@link BridgedToolDeps.agentWorksOn})
 *    and is not paused; a revoked or expired one runs marked so, and the gate
 *    blocks it as it does on `/mcp`;
 * 4. the session is one the hub started for that agent, its turn is running
 *    now, and **every fact about the turn comes from the hub's own record of
 *    it** ({@link BridgedToolDeps.turnFor}): its tier, its permission mode and
 *    its outsider cap. The frame carries none of them, and a session with no
 *    record is refused: never run at the agent's ordinary level;
 * 5. the tool is one the hub runs: never one whose effect is the computer
 *    itself (`local_browser.*`, which stays there);
 * 6. a setup tool runs only for DorkBot with its owner's grant, only while
 *    DorkBot is the only agent on its computer, and never in a turn that read
 *    an outsider's words (`hub-setup-tools.ts`); a request for access is
 *    judged by the tool it asks for;
 * 7. a read-only permission mode runs reads only;
 * 8. a teammate-tier turn is held to the teammate table (`turn-power/teammate-tier.ts`).
 *
 * Then the tool runs through the normal capability and permission gate, as
 * that agent, under the caller kind `agent-computer`, which is never a person:
 * no signed-in user, no trusted marker, no approval of its own. The identity
 * carries the kind (`via`), and the gate asks a person on the hub before every
 * destructive tool, whatever its areas say. A capped turn's identity carries
 * the cap (`outsiderCapped`), so the gate holds the call as a stranger's turn
 * and no session record can lift it; the agent is also counted as reading an
 * outsider's words while the call runs, so a note it saves is marked.
 *
 * The computer enforces the same permission mode and cap on its own local
 * tools, from `turn.start` (`@dorkos/shared/session-relay-agent-computer`).
 *
 * @module services/core/tool-bridge/bridged-tool-call
 */
import type { PermissionMode } from '@dorkos/shared/schemas';
import {
  AGENT_COMPUTER_MAX_BODY_BYTES,
  AGENT_COMPUTER_MAX_TOOL_OUTPUT_BYTES,
  AGENT_COMPUTER_MAX_TOOLS,
  RelayToolSummarySchema,
  parseRelayCallResult,
  type RelayToolCallOutcome,
  type RelayToolSummary,
} from '@dorkos/shared/session-relay-agent-computer';
import type { RequestKind } from '../../../lib/request-classifier.js';
import type { AgentIdentity } from '../agent-identity/agent-identity-service.js';
import { TEAMMATE_DORKOS_TOOLS, teammateTierRefusal } from '../turn-power/teammate-tier.js';
import {
  fixedRefusal,
  isDeniedPayload,
  modeAllows,
  withOutsiderCap,
  type BridgedToolRateLimits,
} from './bridge-guards.js';
import {
  HUB_SETUP_REFUSAL_CODE,
  forwardedToolName,
  hubSetupToolRefusal,
  isHubSetupAction,
  type BridgeAction,
} from './hub-setup-tools.js';

/** The caller kind every bridged call runs under. Never a person. */
export const AGENT_COMPUTER_CALLER: Extract<RequestKind, 'agent-computer'> = 'agent-computer';

/** A refused or failed call, in the relay's own words. */
export type BridgedRefusal = Extract<RelayToolCallOutcome, { ok: false }>;

/** What the hub recorded about every turn, whatever its tier. */
interface BridgedTurnRecord {
  /** The agent the hub started the turn for. */
  readonly agentId: string;
  /**
   * Whether the turn is running now. A record outlives its turn, and a finished
   * turn's session calls nothing: the computer would otherwise keep a turn's
   * reach after the hub ended it.
   */
  readonly running: boolean;
  /** The permission mode the hub started it at. */
  readonly permissionMode: PermissionMode;
  /** Whether the turn read words DorkOS cannot vouch for. */
  readonly outsiderCapped: boolean;
}

/** The hub's record of the turn a session is running. */
export type BridgedTurn =
  | (BridgedTurnRecord & { readonly tier: 'owner' })
  /** A teammate-tier turn answers one room, the only room its tools may reach. */
  | (BridgedTurnRecord & { readonly tier: 'teammate'; readonly roomId: string });

/** The hub's record of an agent. */
export interface BridgedAgent {
  /** The agent's home on the hub: its identity key. */
  readonly agentPath: string;
  /** Its name, for Activity. */
  readonly displayName: string;
  /** Whether it is the system agent, DorkBot. */
  readonly isSystem: boolean;
  /**
   * Why the agent is not acting as itself, from the agent-identity service
   * (`describeAgent`): its tokens were revoked or ran out. Carried onto the
   * identity, so the gate blocks it as it blocks a shut-off agent on `/mcp`.
   */
  readonly inactive?: 'revoked' | 'expired';
  /** Whether the agent is paused (`mesh/pause`). A paused agent calls nothing. */
  readonly paused: boolean;
}

/** One tool run, handed to the {@link BridgedToolRunner}. */
export interface BridgedToolRun {
  /** Always {@link AGENT_COMPUTER_CALLER}; the runner hands it to the server it builds. */
  readonly caller: typeof AGENT_COMPUTER_CALLER;
  /** The agent the tool runs as: shut-off and capped marks included. */
  readonly identity: AgentIdentity;
  /** The session the call came from. */
  readonly sessionId: string;
  /** The computer the call came from. */
  readonly computerId: string;
}

/**
 * Runs tools through the normal gate as an agent. The live one is
 * `mcp-tool-runner.ts`; tests pass a fake.
 */
export interface BridgedToolRunner {
  /** The tools this agent may see now: Blocked ones already left out. */
  list(run: BridgedToolRun): Promise<readonly RelayToolSummary[]>;
  /** Run one tool. May throw; the bridge turns a throw into a fixed refusal. */
  call(run: BridgedToolRun & { tool: string; input: unknown }): Promise<RelayToolCallOutcome>;
}

/** What the bridge reads, all of it the hub's own records. */
export interface BridgedToolDeps {
  /** The computer an agent works on, or `null` when it works on none. */
  agentWorksOn(agentId: string): string | null;
  /**
   * Every agent that works on a computer, by id, from the hub's own records.
   * DorkBot is alone on its computer only when this is exactly DorkBot.
   */
  agentsOn(computerId: string): readonly string[];
  /**
   * The hub's record of the turn a session runs, or `null` when the hub has
   * none. Never the computer's word: the hub's own record, made when it
   * started the turn, and `running` says whether it still runs.
   */
  turnFor(sessionId: string): BridgedTurn | null;
  /** An agent's record, or `null` when the hub does not know it. */
  agent(agentId: string): BridgedAgent | null | Promise<BridgedAgent | null>;
  /** Whether external MCP is on (`mcp.enabled`): off, no bridged call runs either. */
  mcpEnabled(): boolean;
  /** The action a tool name means, or `null` when there is none. */
  actionForTool(tool: string): BridgeAction | null;
  /** Whether the owner granted DorkBot its setup level, read fresh. */
  dorkbotSetupGranted(): boolean;
  /** The sliding windows calls are counted in (`createBridgedToolRateLimits`). */
  limits: BridgedToolRateLimits;
  /** Runs the tool. */
  runner: BridgedToolRunner;
}

/** Who a bridged call is from and where. */
export interface BridgedCallOrigin {
  /** The computer the connection proved. */
  readonly computerId: string;
  /** The agent the computer says is calling. */
  readonly agentId: string;
  /** The session the computer says it is calling from. */
  readonly sessionId: string;
}

/** One `tools.call`. */
export interface BridgedToolCall extends BridgedCallOrigin {
  /** The tool's name, as the agent called it. */
  readonly tool: string;
  /** Its input. */
  readonly input: unknown;
}

/** A `tools.list` answer, or why there is none. */
export type BridgedToolListResult =
  { readonly ok: true; readonly tools: readonly RelayToolSummary[] } | BridgedRefusal;

const refusal = (code: string, message: string): BridgedRefusal => ({ ok: false, code, message });

const NOT_HERE = refusal('not_this_computer', 'That agent does not work on this computer.');
const NO_TURN = refusal('unknown_session', 'That session is not one this agent is running.');
const ENDED = refusal('turn_ended', 'That turn has ended.');
const PAUSED = refusal('agent_paused', 'That agent is paused.');
const MCP_OFF = refusal('mcp_disabled', 'DorkOS tools are turned off for agents.');
const RATE_LIMITED = refusal('rate_limited', 'Too many tool calls. Wait a moment and try again.');
const FAILED = refusal('tool_failed', 'The tool failed before it could answer.');

/** Tools whose effect is the computer itself: they run there, never on the hub. */
function runsOnComputer(action: BridgeAction): boolean {
  return action.id.startsWith('local_browser.') || action.toolName.startsWith('local_browser_');
}

/** What an admitted call runs as. */
interface Admitted {
  readonly agent: BridgedAgent;
  readonly turn: BridgedTurn;
  readonly run: BridgedToolRun;
  /** Whether DorkBot may use the setup tools in this call, read once. */
  readonly maySetUp: boolean;
  /** Whether the agent is the only one on its computer. */
  readonly alone: boolean;
}

/** The agent and turn a call may run as, or why not. */
async function admit(
  origin: BridgedCallOrigin,
  deps: BridgedToolDeps
): Promise<Admitted | BridgedRefusal> {
  if (!deps.mcpEnabled()) return MCP_OFF;
  if (deps.agentWorksOn(origin.agentId) !== origin.computerId) return NOT_HERE;
  const agent = await deps.agent(origin.agentId);
  if (!agent) return NOT_HERE;
  if (agent.paused) return PAUSED;
  const turn = deps.turnFor(origin.sessionId);
  if (!turn || turn.agentId !== origin.agentId) return NO_TURN;
  if (!turn.running) return ENDED;
  const identity: AgentIdentity = {
    agentPath: agent.agentPath,
    displayName: agent.displayName,
    createdAt: new Date().toISOString(),
    ...(agent.inactive ? { inactive: agent.inactive } : {}),
    ...(turn.outsiderCapped ? { outsiderCapped: true as const } : {}),
  };
  // Alone means the hub's list for this computer is exactly this agent: an
  // empty list, or one that leaves the agent out, is the hub not knowing, and
  // not knowing is never alone.
  const onComputer = deps.agentsOn(origin.computerId);
  const alone = onComputer.length > 0 && onComputer.every((id) => id === origin.agentId);
  return {
    agent,
    turn,
    // A turn that read an outsider's words never sets anything up: trust never
    // extends to strangers, grant or not. Read once per call or list.
    maySetUp: agent.isSystem && !turn.outsiderCapped && deps.dorkbotSetupGranted(),
    alone,
    run: {
      caller: AGENT_COMPUTER_CALLER,
      identity,
      sessionId: origin.sessionId,
      computerId: origin.computerId,
    },
  };
}

/** An input as the teammate table reads it: an object, or nothing. */
function argsOf(input: unknown): Record<string, unknown> {
  return typeof input === 'object' && input !== null && !Array.isArray(input)
    ? (input as Record<string, unknown>)
    : {};
}

/** The refusal for running `action` with `input` in this turn, or `null`. */
function decide(action: BridgeAction, input: unknown, admitted: Admitted): BridgedRefusal | null {
  const { agent, turn } = admitted;
  if (runsOnComputer(action)) {
    return refusal('runs_on_computer', 'That tool runs on the computer itself.');
  }
  const who = {
    agentIsDorkBot: agent.isSystem,
    setupGranted: admitted.maySetUp,
    aloneOnComputer: admitted.alone,
  };
  const setup = hubSetupToolRefusal(action, who, input);
  if (setup) return refusal(HUB_SETUP_REFUSAL_CODE, setup);
  if (!modeAllows(turn.permissionMode, action.tier)) {
    return refusal('read_only_turn', 'This turn can only read.');
  }
  if (turn.tier === 'teammate') {
    const refused = teammateTierRefusal(
      { roomId: turn.roomId },
      { source: 'dorkos', name: action.toolName, input: argsOf(input) }
    );
    if (refused) return refusal('teammate_tier', refused);
  }
  return null;
}

/** Why an answer cannot cross: too large for a frame, or not JSON the relay carries. */
function unsendable(output: unknown): BridgedRefusal {
  let bytes: number;
  try {
    bytes = Buffer.byteLength(JSON.stringify(output) ?? '', 'utf8');
  } catch {
    return refusal('output_invalid', 'The tool answered with something the computer cannot read.');
  }
  return bytes > AGENT_COMPUTER_MAX_TOOL_OUTPUT_BYTES || bytes > AGENT_COMPUTER_MAX_BODY_BYTES
    ? refusal('output_too_large', 'The tool answered with more than the computer can receive.')
    : refusal('output_invalid', 'The tool answered with something the computer cannot read.');
}

/**
 * Run one `tools.call` from an agent computer, or say why not.
 *
 * @param call - The proven computer, and the agent, session, tool and input it sent.
 * @param deps - The hub's records, the limits and the runner.
 * @returns The tool's outcome; never throws.
 */
export async function handleBridgedToolCall(
  call: BridgedToolCall,
  deps: BridgedToolDeps
): Promise<RelayToolCallOutcome> {
  try {
    if (!deps.limits.perComputer.hit(call.computerId).allowed) return RATE_LIMITED;
    const admitted = await admit(call, deps);
    if ('ok' in admitted) return admitted;
    if (!deps.limits.perTurn.hit(call.sessionId).allowed) return RATE_LIMITED;
    const action = deps.actionForTool(call.tool);
    if (!action) return refusal('unknown_tool', 'There is no DorkOS tool by that name.');
    const refused = decide(action, call.input, admitted);
    if (refused) return refused;
    // A request for access runs the tool it names: that tool is judged too.
    const forwarded = forwardedToolName(action, call.input);
    const target = forwarded === null ? null : deps.actionForTool(forwarded);
    const targetRefused = target && decide(target, argsOf(call.input).arguments, admitted);
    if (targetRefused) return targetRefused;

    const { run, turn, agent } = admitted;
    const outcome = await withOutsiderCap(turn.outsiderCapped, agent.agentPath, () =>
      deps.runner.call({ ...run, tool: action.toolName, input: call.input })
    );
    if (!outcome.ok) return fixedRefusal(outcome.code);
    // The gate's refusal names areas and settings: it crosses in fixed words.
    if (isDeniedPayload(outcome.output)) return fixedRefusal('denied');
    return parseRelayCallResult('tools.call', outcome) ?? unsendable(outcome.output);
  } catch {
    return FAILED;
  }
}

/** Whether a listed tool stays hidden from this turn. */
function hiddenFrom(tool: RelayToolSummary, admitted: Admitted, deps: BridgedToolDeps): boolean {
  const { turn } = admitted;
  const action = deps.actionForTool(tool.name);
  if (!action || runsOnComputer(action)) return true;
  if (isHubSetupAction(action) && !(admitted.maySetUp && admitted.alone)) return true;
  if (!modeAllows(turn.permissionMode, action.tier)) return true;
  if (turn.tier === 'teammate') {
    const rule = Object.hasOwn(TEAMMATE_DORKOS_TOOLS, action.toolName)
      ? TEAMMATE_DORKOS_TOOLS[action.toolName]
      : undefined;
    return rule?.kind !== 'this-room';
  }
  return false;
}

/**
 * Answer one `tools.list`: the tools this agent may see now, less the setup
 * tools (unless DorkBot holds the grant), the tools that run on the computer
 * itself, what a read-only turn may not do, and, for a teammate-tier turn,
 * everything the teammate table refuses. Blocked areas are already left out
 * by the runner. Counted against the computer's budget, not the turn's.
 *
 * @param origin - The proven computer, and the agent and session it named.
 * @param deps - The hub's records, the limits and the runner.
 * @returns The tools, or why there are none; never throws.
 */
export async function handleBridgedToolList(
  origin: BridgedCallOrigin,
  deps: BridgedToolDeps
): Promise<BridgedToolListResult> {
  try {
    if (!deps.limits.perComputer.hit(origin.computerId).allowed) return RATE_LIMITED;
    const admitted = await admit(origin, deps);
    if ('ok' in admitted) return admitted;
    const visible = (await deps.runner.list(admitted.run)).filter(
      (tool) => !hiddenFrom(tool, admitted, deps)
    );
    return { ok: true, tools: fitToOneAnswer(visible) };
  } catch {
    return refusal('tools_unavailable', 'The tool list could not be read.');
  }
}

/**
 * The tools that fit one `tools.list` answer: each one valid on its own, and
 * as many as fit the frame, in order. The relay never sends a list it cannot
 * read.
 */
function fitToOneAnswer(tools: readonly RelayToolSummary[]): RelayToolSummary[] {
  const fitting: RelayToolSummary[] = [];
  // `{"tools":[]}`, then each tool and its comma.
  let bytes = 12;
  for (const tool of tools) {
    if (fitting.length === AGENT_COMPUTER_MAX_TOOLS) break;
    if (!RelayToolSummarySchema.safeParse(tool).success) continue;
    const size = Buffer.byteLength(JSON.stringify(tool), 'utf8') + 1;
    if (bytes + size > AGENT_COMPUTER_MAX_BODY_BYTES) continue;
    bytes += size;
    fitting.push(tool);
  }
  // The count above is the frame's own measure; this is the proof.
  while (fitting.length > 0 && !parseRelayCallResult('tools.list', { tools: fitting })) {
    fitting.pop();
  }
  return fitting;
}
