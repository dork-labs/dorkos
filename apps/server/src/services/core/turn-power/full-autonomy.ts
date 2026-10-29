/**
 * What a person SET each conversation to, apart from any ceiling its turn carries, and whether
 * anybody can be asked in it (DOR-3394, the product owner's rule).
 *
 * A chat set to Full autonomy asks nobody anything. An outsider's mark, a carried ceiling or a
 * stranger's hold bounds the level a turn is recorded at (`turn-levels.ts`), and the permission
 * gate used to read that bounded level as a reason to put a card in front of a person. It now
 * asks here first: the level the chat itself is set to, the person's choice or the agent's level
 * it follows (DOR-3175), never lowered by a mark. Below Full every ask stays as it was, except
 * that a turn nobody is watching is refused at once instead of raising a card nobody can answer.
 *
 * When a marked turn in a Full chat does something a marked turn below Full is asked about (a
 * send, a destructive action, a standing change), one Activity line says so: no card was shown,
 * so the record is how a person finds it afterwards.
 *
 * Kept in memory, like the turn levels it is written beside, and bounded the same way. A chat this
 * process ran no turn on reads as not Full and as attended: the strict answer for asking, and the
 * ordinary one for waiting.
 *
 * @module services/core/turn-power/full-autonomy
 */
import type {
  TurnPermissionBound,
  TurnPermissionCeiling,
  TurnPermissionLevel,
} from '@dorkos/shared/agent-runtime';
import { sessionPath } from '@dorkos/shared/session-link';
import type { ActivityService } from '../../activity/activity-service.js';

/** How many conversations each set remembers, oldest dropped first. */
const MEMORY = 10_000;

/** Conversations whose latest turn ran in a chat set to Full autonomy. */
const fullChats = new Set<string>();
/** Conversations whose latest turn has nobody to ask (a scheduled run, an automatic carry-over). */
const unattendedChats = new Set<string>();

/** Add or drop one key, keeping the set bounded and the key newest. */
function keep(set: Set<string>, key: string, on: boolean): void {
  set.delete(key);
  if (!on) return;
  set.add(key);
  if (set.size > MEMORY) set.delete(set.values().next().value!);
}

/**
 * Whether a level is Full autonomy: it never asks and reaches everything, on whichever runtime
 * declared it (Claude Code's `bypassPermissions`, Codex's `danger-full-access`).
 *
 * @param level - A level, or nothing.
 */
export function isFullLevel(
  level: Pick<TurnPermissionLevel, 'asks' | 'reach'> | undefined
): boolean {
  return level !== undefined && level.asks === 'never' && level.reach === 'everything';
}

/**
 * The bounds of a ceiling that set what a chat is allowed to be, with every mark and stranger's
 * hold set aside: what "set to" means for asking (DOR-3394).
 *
 * The agent's own level travels as a plain level bound in the turn's ceiling (DOR-3175,
 * `agent-level-bound.ts`), and so does another of the owner's agents' unmarked level. Both are
 * kept: an agent a person set to Ask is never Full here, whatever its chat or schedule stores.
 * Dropped: the `runtime-default` bound (a stranger, a sender nobody can vouch for, a
 * continuation's hold), an empty list, and any level that carries the outsider or a teammate
 * mark. `undefined` when nothing is left.
 *
 * @param ceiling - The ceiling a turn, or its background work, carries.
 */
export function ownLevelBounds(
  ceiling: TurnPermissionCeiling | undefined
): TurnPermissionCeiling | undefined {
  if (ceiling === undefined) return undefined;
  const bounds = (Array.isArray(ceiling) ? ceiling : [ceiling]) as readonly TurnPermissionBound[];
  const kept = bounds.filter((bound): bound is TurnPermissionLevel => {
    if (typeof bound !== 'object' || bound === null) return false;
    const level = bound as TurnPermissionLevel;
    return level.outsider !== true && level.teammate === undefined;
  });
  if (kept.length === 0) return undefined;
  return kept.length === 1 ? kept[0]! : (kept as TurnPermissionCeiling);
}

/**
 * Record what the chat a turn runs in is set to, and whether anybody can be asked in it. Called by
 * the turn-level seam on every send, beside the turn's own (bounded) level.
 *
 * @param sessionId - The id the turn was sent under.
 * @param chosen - The level the chat is set to, with no ceiling applied.
 * @param nobodyToAsk - Whether the turn runs with nobody to answer a card.
 */
export function noteChosenTurn(
  sessionId: string,
  chosen: TurnPermissionLevel,
  nobodyToAsk: boolean
): void {
  keep(fullChats, sessionId, isFullLevel(chosen));
  keep(unattendedChats, sessionId, nobodyToAsk);
}

/**
 * Carry both answers to the id a runtime renamed a conversation to mid-turn.
 *
 * @param from - The id the turn was sent under.
 * @param to - The id the runtime renamed it to.
 */
export function aliasChosenTurn(from: string, to: string): void {
  if (from === to) return;
  if (fullChats.has(from)) keep(fullChats, to, true);
  if (unattendedChats.has(from)) keep(unattendedChats, to, true);
}

/**
 * Whether the chat a call came from is set to Full autonomy. `false` for no chat, or one this
 * process ran no turn on.
 *
 * @param sessionId - The calling chat, when the surface verified one.
 */
export function choseFullAutonomy(sessionId: string | null | undefined): boolean {
  return typeof sessionId === 'string' && fullChats.has(sessionId);
}

/**
 * Whether a card raised now in this chat has nobody to answer it. `false` for no chat.
 *
 * @param sessionId - The calling chat, when the surface verified one.
 */
export function turnHasNobodyToAsk(sessionId: string | null | undefined): boolean {
  return typeof sessionId === 'string' && unattendedChats.has(sessionId);
}

/**
 * What a call that would raise a card is told when nobody can answer it: it fails at once, and
 * says how to get it done.
 *
 * @param title - The action's title.
 */
export function nobodyToAskMessage(title: string): string {
  return (
    `"${title}" needs a person's OK, and nobody is watching this run, so it was refused ` +
    'without asking. Leave it for a run a person is watching, or ask them to allow it.'
  );
}

/** Drop everything recorded. Test-only seam. */
export function resetChosenTurns(): void {
  fullChats.clear();
  unattendedChats.clear();
}

let activity: Pick<ActivityService, 'emit'> | undefined;

/**
 * Wire (or clear) where the line for a marked Full turn's action is written. Called once at boot.
 *
 * @param next - The Activity log; `undefined` clears it.
 */
export function setMarkedFullActivity(next: Pick<ActivityService, 'emit'> | undefined): void {
  activity = next;
}

/** One action a marked turn in a Full chat ran without asking. */
export interface MarkedFullAction {
  /** The capability id or hand-registered tool name. */
  actionId: string;
  /** Its title, as a person reads it. */
  title: string;
  /** The agent, by its home folder, when known. */
  agentPath?: string;
  /** What to call the agent. */
  agentName?: string;
  /** The chat it ran in, when known. */
  sessionId?: string;
}

/**
 * Write the one Activity line for an action a marked turn in a Full chat ran without asking.
 * Never throws, and never names the action's arguments.
 *
 * @param action - What ran, and who ran it.
 */
export function recordMarkedFullAction(action: MarkedFullAction): void {
  if (!activity) return;
  const who = action.agentName ?? 'An agent';
  void activity.emit({
    actorType: 'agent',
    ...(action.agentPath ? { actorId: action.agentPath } : {}),
    actorLabel: who,
    category: 'agent',
    eventType: 'agent.marked_full_action',
    resourceType: 'capability',
    resourceId: action.actionId,
    resourceLabel: action.title,
    summary:
      `${who} ran "${action.title}" without asking: its chat is set to Full autonomy, and this ` +
      'turn read words from outside',
    ...(action.sessionId ? { linkPath: sessionPath({ session: action.sessionId }) } : {}),
    metadata: {
      actionId: action.actionId,
      ...(action.agentPath ? { agentPath: action.agentPath } : {}),
      ...(action.sessionId ? { sessionId: action.sessionId } : {}),
    },
  });
}

/** One thing a chat at Full autonomy did that a chat below Full is held or refused for. */
export interface FullAction {
  /** A short, stable id for what it was, such as `workspace.create`. */
  actionId: string;
  /** What it did, as a person reads it after the agent's name ("made the workspace p/w1"). */
  did: string;
  /** The limit a chat below Full meets there ("its repository's settings failed DorkOS's check"). */
  limit: string;
  /** The agent, by its home folder, when known. */
  agentPath?: string;
  /** What to call the agent. */
  agentName?: string;
  /** The chat it ran in, when known. */
  sessionId?: string;
}

/**
 * Write the one Activity line for something a chat at Full autonomy did that a chat below Full
 * is held or refused for (the owner's rule: Full has no limits, and the record is how a person
 * finds it afterwards). Never throws.
 *
 * @param action - What it did, the limit it went past, and who did it.
 */
export function recordFullAction(action: FullAction): void {
  if (!activity) return;
  const who = action.agentName ?? 'An agent';
  void activity.emit({
    actorType: 'agent',
    ...(action.agentPath ? { actorId: action.agentPath } : {}),
    actorLabel: who,
    category: 'agent',
    eventType: 'agent.marked_full_action',
    resourceType: 'action',
    resourceId: action.actionId,
    resourceLabel: action.did,
    summary:
      `${who} ${action.did} without being held: its chat is set to Full autonomy. Below Full, ` +
      `${action.limit}.`,
    ...(action.sessionId ? { linkPath: sessionPath({ session: action.sessionId }) } : {}),
    metadata: {
      actionId: action.actionId,
      ...(action.agentPath ? { agentPath: action.agentPath } : {}),
      ...(action.sessionId ? { sessionId: action.sessionId } : {}),
    },
  });
}
