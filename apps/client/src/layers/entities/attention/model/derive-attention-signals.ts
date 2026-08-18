/**
 * Every source of "something needs you", folded into one ordered list. Pure
 * (BC-5, BC-6, BC-10, BC-39).
 *
 * Pure and clock-injected so the two rules with a threshold in them — the idle
 * window and its 24-hour cutoff — are table tests rather than timer mocks. The
 * hook beside this one gathers the sources; this decides what they mean.
 *
 * @module entities/attention/model/derive-attention-signals
 */
import type { PendingApproval } from '@dorkos/shared/approval-schemas';
import type { InteractionPendingEvent } from '@dorkos/shared/interaction-events';
import type { SessionLifecycle } from '@dorkos/shared/session-stream';
import type { PendingInteractionDTO, Session } from '@dorkos/shared/types';
import type { AttentionSignal } from './attention-signal';
import { describeInteraction } from './describe-interaction';

/**
 * How long a session must sit untouched before the product says anything.
 *
 * Thirty minutes, matching the stalled-session heuristic the home surface has
 * used since it shipped (`features/dashboard-attention`). Shorter would nudge
 * about a coffee break.
 */
export const IDLE_NUDGE_AFTER_MS = 30 * 60 * 1000;

/**
 * How stale is too stale to be worth mentioning.
 *
 * Past a day it is not a nudge, it is archaeology — and Today's overnight
 * boundary has already taken the row out of the operator's way (BC-18).
 */
export const IDLE_NUDGE_WINDOW_MS = 24 * 60 * 60 * 1000;

/**
 * How many idle nudges may exist at once.
 *
 * Module-private: it is a property of this rule, not a knob a caller sets.
 *
 * **One.** BC-10 states the restart cost as "a restart may re-surface at most
 * one nudge", which only reads as a bound if at most one exists to begin with.
 * It is also the etiquette rule (`meta/agent-etiquette.md`): over-participation
 * is the failure mode people complain about, and a fleet of thirty agents with
 * a nudge each is the loudest possible way to say nothing.
 */
const IDLE_NUDGE_LIMIT = 1;

/** Everything {@link deriveAttentionSignals} reads. */
export interface AttentionSources {
  /** The instant to reason from, epoch ms. The only clock this module has. */
  now: number;
  /** Capability approvals waiting on a person. */
  approvals: readonly PendingApproval[];
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
  /** Idle nudges the operator waved away in this window (BC-10). */
  dismissed: ReadonlySet<string>;
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
  rest: Pick<AttentionSignal, 'id' | 'kind' | 'secondary' | 'since' | 'dismissible'>
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
      id: `approval:${approval.approvalId}`,
      kind: 'permission-prompt',
      primary: approval.requestedBy ?? approval.capabilityTitle,
      ...(approval.requestedBy === undefined ? {} : { secondary: approval.capabilityTitle }),
      since: approval.requestedAt,
      deepLink: APPROVAL_HREF,
      dismissible: false,
    });
  }

  // ── Sessions: blocked, wedged, or gone quiet ──
  const idleCandidates: { session: Session; updatedAt: number }[] = [];
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
      const isQuestion = interaction?.type === 'question';
      signals.push(
        sessionSignal(session, sources, {
          id: `blocked:${interaction?.id ?? session.id}`,
          kind: isQuestion ? 'question' : 'permission-prompt',
          secondary:
            interaction === undefined ? 'Waiting on you' : describeInteraction(interaction),
          since:
            interaction === undefined
              ? session.updatedAt
              : new Date(interaction.startedAt).toISOString(),
          dismissible: false,
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
          dismissible: false,
        })
      );
      continue;
    }

    // Only a session that is doing nothing can be idle. A streaming turn is
    // working, and a blocked or wedged one has already said its piece above.
    if (lifecycle === 'streaming') continue;
    const updatedAt = Date.parse(session.updatedAt);
    if (Number.isNaN(updatedAt)) continue;
    const quietFor = sources.now - updatedAt;
    if (quietFor < IDLE_NUDGE_AFTER_MS || quietFor > IDLE_NUDGE_WINDOW_MS) continue;
    idleCandidates.push({ session, updatedAt });
  }

  // The most recently touched one, because the operator's attention is likeliest
  // to still be attached to it — and only that one (see IDLE_NUDGE_LIMIT).
  idleCandidates.sort((a, b) => b.updatedAt - a.updatedAt);
  for (const candidate of idleCandidates.slice(0, IDLE_NUDGE_LIMIT)) {
    signals.push(
      sessionSignal(candidate.session, sources, {
        id: `idle:${candidate.session.id}`,
        kind: 'idle-timeout',
        secondary: 'Went quiet',
        since: candidate.session.updatedAt,
        dismissible: true,
      })
    );
  }

  // Dismissal is applied HERE, not by whoever renders the list, so no rule
  // downstream ever has to ask whether something was waved away (BC-10). It can
  // only reach something DISMISSIBLE: a dismissed id that later belonged to a
  // permission prompt would otherwise hide a blockage nobody chose to hide, and
  // BC-42 is explicit that nothing else in Heads up can be waved away at all.
  return signals.filter((signal) => !(signal.dismissible && sources.dismissed.has(signal.id)));
}
