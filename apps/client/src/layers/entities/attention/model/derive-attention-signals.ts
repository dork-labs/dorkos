/**
 * Every source of "something needs you", folded into one ordered list. Pure
 * (BC-5, BC-6, BC-39).
 *
 * Pure so every rule in it is a table test rather than a timer mock. The hook
 * beside this one gathers the sources; this decides what they mean.
 *
 * @module entities/attention/model/derive-attention-signals
 */
import type { PendingApproval } from '@dorkos/shared/approval-schemas';
import type { InteractionPendingEvent } from '@dorkos/shared/interaction-events';
import type { SessionLifecycle } from '@dorkos/shared/session-stream';
import type { PendingInteractionDTO, Session, Task } from '@dorkos/shared/types';
import type { AttentionSignal } from './attention-signal';
import { describeInteraction } from './describe-interaction';
import {
  approvalSignalId,
  interactionSignalId,
  interactionSignalKind,
  scheduleSignalId,
} from './signal-ids';

/** Everything {@link deriveAttentionSignals} reads. */
export interface AttentionSources {
  /** Capability approvals waiting on a person. */
  approvals: readonly PendingApproval[];
  /**
   * Schedules an agent proposed and parked, oldest first.
   *
   * A first-class blockage since DOR-1391, not a list every surface joined on
   * beside this one: `tasks_create` never arms a schedule (DOR-504), so it runs
   * only when a person says yes.
   */
  schedules: readonly Task[];
  /** Every session the cockpit can see. */
  sessions: readonly Session[];
  /** Session id → coarse lifecycle, from the global session-list stream. */
  lifecycles: Readonly<Record<string, SessionLifecycle>>;
  /**
   * Every prompt anywhere in the fleet that is waiting on a person.
   *
   * Fleet-wide, not attached-only, and that is the whole of what changed here:
   * the kind of a blockage used to be knowable only for the one session this
   * window had hydrated, so every background agent's question was reported as a
   * permission prompt. The prompt itself now rides the global stream, so the
   * answer below is exact for every session.
   */
  interactions: readonly InteractionPendingEvent[];
  /** Agent directory → the disambiguated name to print. */
  agentNames: Readonly<Record<string, string>>;
}

/**
 * Where a permission prompt raised outside a session leads.
 *
 * The home surface's triage header holds the card, and it is answered in place
 * there — so the destination is the surface, not a per-approval detail route
 * that does not exist (`widgets/home/ui/PinnedTriageHeader.tsx`).
 */
const APPROVAL_HREF = '/';

/**
 * Where a parked schedule leads.
 *
 * The Tasks page, which is the one surface that shows a schedule whole — what
 * it runs, how often, and since when it has been waiting. The same destination
 * the OS banner for one already used (`features/notifications`), so a person
 * who taps the banner and a person who clicks the row land in the same place.
 */
const SCHEDULE_HREF = '/tasks';

/** What a parked schedule is asking for, in fixed words. */
const SCHEDULE_SECONDARY = 'Wants to run on a timer';

/**
 * The `/session` deep link for one session.
 *
 * Built with `URLSearchParams` rather than by interpolation because a `cwd` is
 * a filesystem path and routinely contains characters (`&`, spaces, `#`) that
 * silently truncate a hand-built query string.
 *
 * @param session - The session to open.
 */
function sessionHref(session: Session): string {
  const params = new URLSearchParams({ session: session.id });
  if (session.cwd) params.set('dir', session.cwd);
  return `/session?${params.toString()}`;
}

/**
 * What to call the agent behind a session.
 *
 * The disambiguated roster name when the session names a directory the roster
 * holds; otherwise the directory's own basename, which is what the operator
 * calls it anyway. A session with no `cwd` belongs to no agent (DOR-203) and
 * says so with its own title instead.
 *
 * @param session - The session.
 * @param agentNames - Agent directory → display name.
 */
function whoOf(session: Session, agentNames: Readonly<Record<string, string>>): string | null {
  const cwd = session.cwd;
  if (!cwd) return null;
  return agentNames[cwd] ?? cwd.split('/').pop() ?? cwd;
}

/**
 * One signal about a session, with the fields every session-shaped signal
 * shares already filled in.
 *
 * @param session - The session it is about.
 * @param sources - The snapshot, for the roster names.
 * @param rest - What makes this signal the kind it is.
 */
function sessionSignal(
  session: Session,
  sources: AttentionSources,
  rest: Pick<AttentionSignal, 'id' | 'kind' | 'secondary' | 'since'>
): AttentionSignal {
  const who = whoOf(session, sources.agentNames);
  return {
    ...rest,
    primary: who ?? session.title,
    deepLink: sessionHref(session),
    ...(session.cwd ? { agentPath: session.cwd } : {}),
  };
}

/**
 * The four blockages, gathered from every source that can raise one.
 *
 * Order inside the returned list carries no meaning — `rankNowItems` decides
 * priority (BC-6). What this decides is membership: a source not read here
 * cannot reach Heads up, which is how BC-5's allowlist is enforced by construction
 * rather than by a filter somebody could relax.
 *
 * **A DM never appears here, and neither does an unread channel** (BC-39). The
 * only room-shaped thing that could is an agent's question, and it arrives as
 * the session's blocking interaction — as a `question`, with the session's own
 * deep link — rather than as the room it happened to be asked in.
 *
 * @param sources - Everything the derivation reads.
 */
export function deriveAttentionSignals(sources: AttentionSources): AttentionSignal[] {
  const signals: AttentionSignal[] = [];

  // The oldest prompt each session is parked on — oldest because that is the one
  // that runs out first, and a session parked on two says so with the one that
  // needs answering soonest.
  const promptBySession = new Map<string, PendingInteractionDTO>();
  for (const pending of sources.interactions) {
    const held = promptBySession.get(pending.sessionId);
    if (held === undefined || pending.interaction.startedAt < held.startedAt) {
      promptBySession.set(pending.sessionId, pending.interaction);
    }
  }

  // ── Capability approvals: the one blockage that is not a session ──
  for (const approval of sources.approvals) {
    signals.push({
      id: approvalSignalId(approval.approvalId),
      kind: 'permission-prompt',
      primary: approval.requestedBy ?? approval.capabilityTitle,
      ...(approval.requestedBy === undefined ? {} : { secondary: approval.capabilityTitle }),
      since: approval.requestedAt,
      deepLink: APPROVAL_HREF,
    });
  }

  // ── Parked schedules: the other blockage that is not a session ──
  // The name a person gave it, never what it runs: a schedule's command is the
  // kind of detail the Tasks page shows and a one-line row does not.
  for (const task of sources.schedules) {
    signals.push({
      id: scheduleSignalId(task.id),
      kind: 'schedule-approval',
      primary: task.displayName ?? task.name,
      secondary: SCHEDULE_SECONDARY,
      since: task.createdAt,
      deepLink: SCHEDULE_HREF,
    });
  }

  // ── Sessions: blocked or wedged ──
  for (const session of sources.sessions) {
    const lifecycle = sources.lifecycles[session.id];

    if (lifecycle === 'blocked') {
      const interaction = promptBySession.get(session.id);
      // An elicitation is a prompt from an MCP server that the operator answers
      // exactly like a permission ask, so it reads as one. A question is its own
      // kind — and it is exact for every session now, attached or not, because
      // the prompt rides the fleet-wide stream.
      //
      // A `blocked` session with no prompt in hand is still possible and still
      // honest: a capability hold parks a turn on a person without raising one
      // of these, and so does a runtime that reported `blocked` before its
      // prompt arrived. It reads as a permission ask waiting on you, which is
      // what it is.
      //
      // The id and kind for a CAPTURED prompt come from `signal-ids.ts` — the
      // same functions `deriveWaitingItems` calls for the Inbox popover's own
      // per-item count, so the two can never classify the same interaction
      // differently.
      signals.push(
        sessionSignal(session, sources, {
          id:
            interaction === undefined
              ? `blocked:${session.id}`
              : interactionSignalId(interaction.id),
          kind:
            interaction === undefined
              ? 'permission-prompt'
              : interactionSignalKind(interaction.type),
          secondary:
            interaction === undefined ? 'Waiting on you' : describeInteraction(interaction),
          since:
            interaction === undefined
              ? session.updatedAt
              : new Date(interaction.startedAt).toISOString(),
        })
      );
      continue;
    }

    if (lifecycle === 'error') {
      signals.push(
        sessionSignal(session, sources, {
          id: `error:${session.id}`,
          kind: 'error',
          secondary: 'Stopped with an error',
          since: session.updatedAt,
        })
      );
    }

    // **A session that has merely gone quiet raises nothing here** (DOR-1391).
    // It used to raise one dismissible `idle-timeout` nudge, and the nudge was
    // the only thing in this list a person could wave away — which is why
    // nothing in it is dismissible any more. Going quiet is a guess about
    // somebody's afternoon rather than a blockage: nothing is stopped, nobody
    // is waiting, and a zone that asks for attention on a guess is a zone
    // people learn to skim. What it observed is still reported, once a day and
    // in the past tense, by the Today digest
    // (`features/dashboard-sidebar/model/use-digest-facts`).
  }

  return signals;
}
