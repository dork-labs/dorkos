/**
 * The one decision behind an agent setting a scheduled task's permission mode
 * (`tasks.set_mode`) or approving a waiting one (`tasks.approve`), DOR-3703.
 *
 * Asked twice for every call: by the tool gate before a card can be raised
 * (`agent-mode-escalation.ts`), and by the `tasks_*` tools on both MCP servers
 * right before they write. Both read this function, so the card and the write
 * cannot disagree. The HTTP routes do not use it: in phase 1 they refuse both
 * fields to every caller but a person, as before. Every rule is one of
 * Security's eight (ruling of 2026-11-02):
 *
 * - **Refused** (nothing is written, no card): a mode the runtime does not
 *   declare; a mode above THE CEILING, the lower of the caller's level (its
 *   calling turn's real level, and the lowest level for a caller DorkOS cannot
 *   name) and the task's agent's level, and Don't ask for a turn that read
 *   outside words (the message names the highest that fits). Within it an
 *   agent may set any mode, Bypass included for a Bypass agent (Dorian's rule,
 *   Nov 2). An approval of a task the caller made or last changed, or one a
 *   chat in its chain did, or one whose chain cannot be read; of a task with no
 *   record of its editor, or one a person declined; an approval sent with other
 *   changes; a status other than an approval; a new task under another agent.
 * - **Asks a person**, whatever the setting: a caller whose identity is not
 *   structural (anything but an agent's own tools inside its own chat); a turn
 *   that read outside words; another agent's task; a caller resolved through a
 *   linked worktree, for any mode above Default. An approval also asks when
 *   the task's own words came from outside, or it would arm a mode looser than
 *   {@link AGENT_MODE_WITHOUT_A_PERSON}.
 *   A raise above a mode a person held the task to (Undo, a decline,
 *   lowering it) asks until a person raises it themselves (M2).
 * - Otherwise the action's own permission decides: Blocked, Ask, or Allowed.
 *   A mode change follows Tasks & schedules; an approval carries the
 *   `standing-grant` consent, so an area-level Allowed still asks for it.
 *
 * @module services/tasks/agent-mode/agent-mode-decision
 */
import { PermissionModeSchema } from '@dorkos/shared/schemas';
import type { PermissionMode, Task } from '@dorkos/shared/types';
import type { TurnPermissionLevel } from '@dorkos/shared/agent-runtime';
import { CREDITS_ACCOUNT_ID } from '@dorkos/shared/account-usage';
import {
  clampModeToCeiling,
  isBypassSemantics,
  levelOfMode,
  READ_ONLY_LEVEL,
  resolveCeilingLevel,
  stricterLevel,
  type DeclaredModes,
} from '@dorkos/shared/permission-semantics';
import {
  resolvePermission,
  type AgentPermissions,
  type PermissionConfigInput,
  type ResolvedPermission,
} from '@dorkos/shared/permissions';
import type { ScheduleAgentEdits } from '../approvals/task-approvals.js';
import { CREDITS_SCHEDULE_AGENT_REFUSAL, OPERATOR_ONLY_TASK_CODE } from '../task-write-policy.js';
import {
  AGENT_MODE_AREA,
  AGENT_MODE_WITHOUT_A_PERSON,
  TASK_APPROVE_ACTION,
  TASK_SET_MODE_ACTION,
  type AgentModeAction,
} from './agent-mode-actions.js';
import {
  aboveCeilingMessage,
  AGENT_MODE_REFUSAL_ERROR,
  APPROVE_ALONE_MESSAGE,
  CREATE_WITH_STATUS_MESSAGE,
  NOT_AN_APPROVAL_MESSAGE,
  SELF_APPROVAL_MESSAGE,
  UNKNOWN_EDITOR_MESSAGE,
  UNKNOWN_MODE_MESSAGE,
  SCHEDULED_RAISE_CODE,
  SCHEDULED_RAISE_MESSAGE,
  DECLINED_MESSAGE,
  LINEAGE_UNKNOWN_MESSAGE,
  MODE_ALONE_MESSAGE,
} from './agent-mode-copy.js';
import { NOT_YOUR_AGENT_MESSAGE } from '../approvals/schedule-owner.js';
import { isRaise, ownAgentVouches, sameHome } from './agent-mode-attest.js';

/** Who is calling, as the decision reads it. Never read from the call's arguments. */
export interface AgentModeCaller {
  /**
   * The identity is structural: one of our agents' own tools, inside its own
   * chat. Only such a caller can be Allowed (Security ruling 1).
   */
  structural: boolean;
  /** The calling agent's verified home, when DorkOS can name one. */
  agentPath?: string;
  /** The calling chat, when there is one. */
  sessionId?: string;
  /** Other ids the chat's turn levels may be kept under (a rekeyed first turn). */
  turnSessionIds?: string[];
  /** The calling turn read words DorkOS cannot vouch for. */
  marked: boolean;
  /** The calling chat is a scheduled run of a task (Security ruling of Nov 3, condition 3). */
  scheduledRun?: boolean;
  /** That scheduled thing is a heartbeat beat, which counts as a scheduled run (MB2). */
  heartbeat?: boolean;
  /**
   * How DorkOS knows who the caller is (Security ruling C2/C3): its own home
   * folder, a linked git worktree mapped to a home (whose pointer files the
   * caller could have written), a folder no agent owns where only the turn's
   * dispatch named the agent, a token, or not at all.
   */
  resolved?: AgentIdentityResolution;
}

/** How a caller's identity was resolved, for the ceiling and the audit row. */
export type AgentIdentityResolution = 'home' | 'worktree' | 'dispatched' | 'token' | 'unidentified';

/** Why an approval is refused before anything else is read. */
const LINEAGE_UNKNOWN = 'lineage_unknown';

/** One call, as the decision reads it. */
export interface AgentModeCall {
  /** Which write it is. */
  door: 'create' | 'update';
  /** The raw write body (an update's fields, without its `id`). */
  body: Record<string, unknown>;
  /** The task as it stands, for an update. */
  task?: Task;
  /** Who last changed it, for an update. */
  edits?: ScheduleAgentEdits | null;
  /** The create's target: an agent id or `global`. */
  target?: string;
}

/** What the decision reads from the rest of DorkOS. Injected, so a test can fake each. */
export interface AgentModeSources {
  /** The modes the runtime a task runs on declares, or `undefined` when none is registered. */
  declaredModes: (runtime: string | null | undefined) => DeclaredModes | undefined;
  /** The mode an agent's unattended chats start at on that runtime, or `undefined` for its default. */
  agentLevelMode: (
    agentPath: string,
    runtime: string | null | undefined
  ) => Promise<string | undefined>;
  /** An agent's home by its Mesh id. */
  agentPathOf: (agentId: string) => string | undefined;
  /** The install's permission config. */
  readConfig: () => PermissionConfigInput;
  /** One agent's own permission settings; throws when they cannot be read. */
  readAgentPermissions: (agentPath: string) => Promise<AgentPermissions | undefined>;
  /** The chat that started a chat, or `null` for one nobody started. */
  startedBy: (sessionId: string) => string | null;
  /** The level the latest turn of a chat really ran at, or `undefined` when none ran here. */
  turnLevelOf: (sessionId: string) => TurnPermissionLevel | undefined;
}

/** Why a call needs a person whatever the setting, for the audit row and the tests. */
export type AgentModeAskReason =
  | 'not-structural'
  | 'marked-turn'
  | 'marked-task'
  | 'other-agent'
  | 'linked-worktree'
  | 'looser-than-dont-ask'
  | 'person-floor';

/** A refusal: nothing is written and nobody is asked. */
export interface AgentModeRefusal {
  kind: 'refuse';
  /** The envelope the door answers with. */
  body: { error: string; code: string; message: string; highestAllowed?: string };
}

/** A call that reaches either action and was not refused. */
export interface AgentModeDecided {
  kind: 'decided';
  /** What a person's settings and the rules above make of it. */
  state: 'allowed' | 'ask' | 'blocked';
  /** The resolved permission behind `state`, before the forced asks. */
  permission: ResolvedPermission;
  /** The action the card is raised for: the approval when there is one. */
  primary: AgentModeAction;
  /** Every action the call reaches. */
  actions: AgentModeAction[];
  /** Whether the call names a mode. */
  setsMode: boolean;
  /** Whether the call approves the task. */
  approves: boolean;
  /** The mode the task runs at after the call. */
  mode: PermissionMode;
  /** The mode it had, `null` on a create. */
  previousMode: PermissionMode | null;
  /**
   * Whether the mode is looser than Don't ask: a task runs at it only while a
   * person approved its current content (M-A).
   */
  aboveDontAsk: boolean;
  /** Whether the call raises the task's mode. */
  raise: boolean;
  /** Whether a scheduled run raises it: that waits for a person (condition 3). */
  scheduledRaise: boolean;
  /**
   * Whether the task's own agent vouches for it in place of a person
   * (`agent-mode-attest.ts`): with it, the mode may run above Don't ask on
   * content no person approved.
   */
  vouched: boolean;
  /** Why it asks whatever the setting; empty when only the setting decides. */
  asks: AgentModeAskReason[];
}

/** What the decision concluded. */
export type AgentModeDecision = { kind: 'none' } | AgentModeRefusal | AgentModeDecided;

/** The most chat hops a chain is walked, against a cycle nothing should make. */
const MAX_CHAIN = 32;

const STATE_RANK = { allowed: 0, ask: 1, blocked: 2 } as const;

function refuse(code: string, message: string, highestAllowed?: string): AgentModeRefusal {
  return {
    kind: 'refuse',
    body: {
      error: AGENT_MODE_REFUSAL_ERROR,
      code,
      message,
      ...(highestAllowed ? { highestAllowed } : {}),
    },
  };
}

/** A chat and every chat above it, nearest first. */
function chainOf(sessionId: string, sources: AgentModeSources): string[] {
  const chain = [sessionId];
  let current: string | null = sessionId;
  while (chain.length < MAX_CHAIN) {
    current = current ? sources.startedBy(current) : null;
    if (!current || chain.includes(current)) break;
    chain.push(current);
  }
  return chain;
}

/** Whether one chat started the other, at any distance, or they are the same chat. */
function shareAChain(a: string, b: string, sources: AgentModeSources): boolean {
  return chainOf(a, sources).includes(b) || chainOf(b, sources).includes(a);
}

/**
 * Whether the caller is the task's maker or last editor, or shares a chat chain
 * with either (Security ruling 5): a spin-off approving its parent's task, or a
 * parent approving its spin-off's, approves its own work.
 */
function isSelf(caller: AgentModeCaller, task: Task, edits: ScheduleAgentEdits): boolean {
  return (
    sameHome(caller.agentPath, task.proposedByAgentPath) ||
    sameHome(caller.agentPath, edits.lastEditedByAgentPath)
  );
}

/**
 * Whether the chat chain between the caller and the task's maker and last
 * editor can be read at all: every one of them names its chat. A chain DorkOS
 * cannot read could be the caller's own, so an approval across it is refused.
 */
function chainReadable(caller: AgentModeCaller, task: Task, edits: ScheduleAgentEdits): boolean {
  if (!caller.sessionId || !edits.lastEditedBySessionId) return false;
  return !task.proposedByAgentPath || !!task.proposedBySessionId;
}

/** {@link isSelf}, plus the chat chain (which {@link chainReadable} has vouched for). */
function isSelfOrChain(
  caller: AgentModeCaller,
  task: Task,
  edits: ScheduleAgentEdits,
  sources: AgentModeSources
): boolean {
  if (isSelf(caller, task, edits)) return true;
  const makers = [task.proposedBySessionId, edits.lastEditedBySessionId];
  return makers.some((made) => !!made && shareAChain(caller.sessionId!, made, sources));
}

/**
 * The caller's own level: the lower of its agent's level and the level its
 * calling turn really runs at (a chat held below its agent stays held), or the
 * lowest level there is for a caller DorkOS cannot name (Security ruling 1).
 */
async function levelOfCaller(
  caller: AgentModeCaller,
  runtime: string | null | undefined,
  declared: DeclaredModes,
  sources: AgentModeSources
): Promise<TurnPermissionLevel> {
  if (!caller.agentPath) return READ_ONLY_LEVEL;
  const agent = await levelOfAgent(caller.agentPath, runtime, declared, sources);
  if (!caller.structural) return agent;
  // A chat's tool call comes from a turn DorkOS recorded; one with no record
  // could be held lower than its agent, so it gets the lowest level (S-B). A
  // chat kept under more than one id is held to the strictest of them.
  const turns = [caller.sessionId, ...(caller.turnSessionIds ?? [])]
    .map((id) => (id ? sources.turnLevelOf(id) : undefined))
    .filter((level): level is TurnPermissionLevel => level !== undefined);
  return turns.length > 0 ? turns.reduce(stricterLevel, agent) : READ_ONLY_LEVEL;
}

/** The level an agent's unattended chats run at, on the task's runtime. */
async function levelOfAgent(
  agentPath: string,
  runtime: string | null | undefined,
  declared: DeclaredModes,
  sources: AgentModeSources
): Promise<TurnPermissionLevel> {
  const mode = await sources.agentLevelMode(agentPath, runtime);
  return levelOfMode(declared, mode) ?? resolveCeilingLevel(declared, 'runtime-default');
}

/** A declared mode's level, or reading only when the runtime does not declare it. */
function levelOf(declared: DeclaredModes, mode: string): TurnPermissionLevel {
  return levelOfMode(declared, mode) ?? READ_ONLY_LEVEL;
}

/** Whether a level admits a mode, by the same rule a chat's ceiling uses. */
function fits(declared: DeclaredModes, mode: string, level: TurnPermissionLevel): boolean {
  return clampModeToCeiling(declared, mode, level) === mode;
}

/**
 * Whether a mode is looser than an agent may land without a person
 * ({@link AGENT_MODE_WITHOUT_A_PERSON}), Bypass always included. A mode the
 * runtime does not declare needs a person too.
 *
 * @param declared - The modes the task's runtime declares.
 * @param mode - The mode the task would run at.
 */
export function modeNeedsAPerson(declared: DeclaredModes, mode: string): boolean {
  const descriptor = declared.values.find((m) => m.id === mode);
  if (!descriptor || isBypassSemantics(descriptor)) return true;
  const capLevel = levelOfMode(declared, AGENT_MODE_WITHOUT_A_PERSON) ?? READ_ONLY_LEVEL;
  return !fits(declared, mode, capLevel);
}

/** The status rules: what an agent's `status` may say, before anything else is read. */
function statusRefusal(call: AgentModeCall): AgentModeRefusal | null {
  if (!Object.hasOwn(call.body, 'status')) return null;
  if (call.door === 'create') return refuse('self_approval', CREATE_WITH_STATUS_MESSAGE);
  if (call.body.status !== 'active' || call.task?.status !== 'pending_approval') {
    return refuse(OPERATOR_ONLY_TASK_CODE, NOT_AN_APPROVAL_MESSAGE);
  }
  const others = Object.keys(call.body).filter((k) => k !== 'status' && k !== 'permissionMode');
  return others.length > 0 ? refuse('approve_alone', APPROVE_ALONE_MESSAGE) : null;
}

/** The home of the agent a task belongs to: its filed agent, or who made a global one. */
function ownerOf(call: AgentModeCall, caller: AgentModeCaller, sources: AgentModeSources) {
  if (call.door === 'create') {
    if (call.target === 'global') return caller.agentPath;
    return call.target ? sources.agentPathOf(call.target) : undefined;
  }
  const task = call.task!;
  return task.agentId ? sources.agentPathOf(task.agentId) : (task.proposedByAgentPath ?? undefined);
}

/** The strictest permission of the actions a call reaches. */
async function resolveActions(
  actions: AgentModeAction[],
  caller: AgentModeCaller,
  sources: AgentModeSources
): Promise<ResolvedPermission> {
  let agent: AgentPermissions | undefined;
  if (caller.agentPath) {
    try {
      agent = await sources.readAgentPermissions(caller.agentPath);
    } catch {
      // Settings nobody can read are not held: Blocked, as the tool gate answers.
      return { area: AGENT_MODE_AREA, state: 'blocked', source: 'agent-area', layer: 'agent' };
    }
  }
  const config = sources.readConfig();
  return actions
    .map((actionId) =>
      resolvePermission({
        area: AGENT_MODE_AREA,
        actionId,
        tier: 'act',
        // An approval arms work: only its own setting allows it. A mode change
        // follows the Tasks area like the rest of the tools (Dorian, Nov 2).
        ...(actionId === TASK_APPROVE_ACTION ? { consent: 'standing-grant' as const } : {}),
        config,
        ...(agent ? { agent } : {}),
        ...(caller.agentPath ? {} : { unidentified: true }),
        ...(caller.marked ? { strangerTurn: true } : {}),
      })
    )
    .reduce((a, b) => (STATE_RANK[b.state] > STATE_RANK[a.state] ? b : a));
}

/**
 * Decide one call that may reach `tasks.set_mode` or `tasks.approve`. A call
 * that names neither `permissionMode` nor `status` answers `none`.
 *
 * @param call - The write.
 * @param caller - Who is making it, as the surface verified.
 * @param sources - What the decision reads.
 */
export async function decideAgentModeCall(
  call: AgentModeCall,
  caller: AgentModeCaller,
  sources: AgentModeSources
): Promise<AgentModeDecision> {
  const setsMode = Object.hasOwn(call.body, 'permissionMode');
  const approves = Object.hasOwn(call.body, 'status');
  if (!setsMode && !approves) return { kind: 'none' };
  const statusRefused = statusRefusal(call);
  if (statusRefused) return statusRefused;
  const task = call.task;
  // A new task is filed only under the caller itself, or `global` (DOR-3640 R1),
  // asked here so nobody is shown a card for a create that would be refused.
  if (call.door === 'create' && caller.agentPath && call.target && call.target !== 'global') {
    if (!sameHome(sources.agentPathOf(call.target), caller.agentPath)) {
      return refuse('not_your_agent', NOT_YOUR_AGENT_MESSAGE);
    }
  }

  let requested: PermissionMode | undefined;
  if (setsMode) {
    const parsed = PermissionModeSchema.safeParse(call.body.permissionMode);
    if (!parsed.success) return refuse('unknown_mode', UNKNOWN_MODE_MESSAGE);
    requested = parsed.data;
  }

  if (approves) {
    // DorkOS credits spend the owner's money: theirs to arm, never an agent's (DOR-2678).
    if (task!.account === CREDITS_ACCOUNT_ID) {
      return refuse(CREDITS_SCHEDULE_AGENT_REFUSAL.code, CREDITS_SCHEDULE_AGENT_REFUSAL.message);
    }
    // A person declined it: theirs to change their mind about, never an agent's.
    if (task!.declined === true) return refuse('declined', DECLINED_MESSAGE);
    const edits = call.edits;
    if (!edits || !edits.lastEditedByAgentPath) {
      return refuse('self_approval', UNKNOWN_EDITOR_MESSAGE);
    }
    if (!chainReadable(caller, task!, edits))
      return refuse(LINEAGE_UNKNOWN, LINEAGE_UNKNOWN_MESSAGE);
    if (isSelfOrChain(caller, task!, edits, sources)) {
      return refuse('self_approval', SELF_APPROVAL_MESSAGE);
    }
  }

  const runtime =
    (typeof call.body.runtime === 'string' ? call.body.runtime : undefined) ?? task?.runtime;
  const declared = sources.declaredModes(runtime);
  const previousMode = task?.permissionMode ?? null;
  const mode = (requested ?? previousMode) as PermissionMode;
  const descriptor = declared?.values.find((m) => m.id === mode);
  const modeLevel = declared ? levelOfMode(declared, mode) : undefined;
  if (!declared || !descriptor || !modeLevel) return refuse('unknown_mode', UNKNOWN_MODE_MESSAGE);

  // THE CEILING, one rule (Dorian, Nov 2: an agent may set a schedule's mode
  // up to its own level, Bypass included): at most the lower of the caller's
  // real level and the task's agent's level; and a turn that read outside
  // words lands Don't ask at most.
  const owner = ownerOf(call, caller, sources);
  let ceiling = await levelOfCaller(caller, runtime, declared, sources);
  if (owner)
    ceiling = stricterLevel(ceiling, await levelOfAgent(owner, runtime, declared, sources));
  if (caller.marked)
    ceiling = stricterLevel(ceiling, levelOf(declared, AGENT_MODE_WITHOUT_A_PERSON));
  // Another agent's task is never refused a mode: a person decides it on a card,
  // whatever the mode (Security, Nov 2). The ceiling binds the caller's own.
  const othersTask =
    setsMode && !approves && !!caller.agentPath && !sameHome(owner, caller.agentPath);
  if (!othersTask && !fits(declared, mode, ceiling)) {
    const highest = clampModeToCeiling(declared, mode, ceiling);
    return refuse('above_ceiling', aboveCeilingMessage(highest), highest);
  }

  const asks: AgentModeAskReason[] = [];
  if (!caller.structural) asks.push('not-structural');
  if (caller.marked) asks.push('marked-turn');
  if (approves && task?.originMarks?.outsider === true) asks.push('marked-task');
  if (!sameHome(owner, caller.agentPath)) asks.push('other-agent');
  // A worktree pointer the caller could have forged, or a folder no agent owns,
  // asks above Default (C2): the folder itself does not vouch for the agent.
  const folderVouches = caller.resolved !== 'worktree' && caller.resolved !== 'dispatched';
  if (!folderVouches && !fits(declared, mode, levelOf(declared, 'default'))) {
    asks.push('linked-worktree');
  }
  // Arming at a mode looser than Don't ask is a person's call (first ruling,
  // unchanged for approvals: Dorian's rule covers setting modes, not arming).
  if (approves && modeNeedsAPerson(declared, mode)) asks.push('looser-than-dont-ask');
  // A person held the task to a mode (Undo, a decline, lowering it): an agent's
  // raise above it is theirs to approve until they raise it themselves (M2).
  const floor = call.edits?.personFloor;
  if (setsMode && floor && isRaise(declared, mode, floor)) asks.push('person-floor');
  const raise = setsMode && isRaise(declared, mode, previousMode);
  // A scheduled thing may only change timing or lower (M7). Parking the task at the
  // asked mode would put that mode one routine Approve from live, and let a run stop
  // any sibling by asking (MUST-H), so it writes nothing at all.
  if (raise && caller.scheduledRun === true && call.door === 'update') {
    return refuse(SCHEDULED_RAISE_CODE, SCHEDULED_RAISE_MESSAGE);
  }

  const actions: AgentModeAction[] = [
    ...(setsMode ? [TASK_SET_MODE_ACTION] : []),
    ...(approves ? [TASK_APPROVE_ACTION] : []),
  ] as AgentModeAction[];
  const permission = await resolveActions(actions, caller, sources);
  const state =
    permission.state === 'allowed' && asks.length > 0 ? ('ask' as const) : permission.state;
  // A card shows the task as it stands, so a mode a person must approve travels
  // alone: mixed with other changes, the person would approve work they never
  // saw (M1, round 3).
  const othersChanged = Object.keys(call.body).some((key) => key !== 'permissionMode');
  if (state === 'ask' && call.door === 'update' && !approves && othersChanged) {
    return refuse('mode_alone', MODE_ALONE_MESSAGE);
  }
  return {
    kind: 'decided',
    state,
    permission,
    primary: approves ? TASK_APPROVE_ACTION : TASK_SET_MODE_ACTION,
    actions,
    setsMode,
    approves,
    mode,
    previousMode,
    aboveDontAsk: modeNeedsAPerson(declared, mode),
    raise,
    scheduledRaise: raise && caller.scheduledRun === true,
    vouched: ownAgentVouches({
      caller,
      owner,
      proposer: call.door === 'update' ? task?.proposedByAgentPath : caller.agentPath,
      outsiderContent: task?.originMarks?.outsider === true,
      raise,
    }),
    asks,
  };
}
