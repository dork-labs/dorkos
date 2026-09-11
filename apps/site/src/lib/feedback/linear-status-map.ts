/**
 * Linear workflow state → publicly-visible feedback status (feedback-pipeline
 * Part 4, decision 260803-205035). Pure, side-effect-free — the webhook route
 * is the only caller.
 *
 * A Linear team's workflow states are free-text, per-team configurable
 * ("In Progress" can be renamed to anything), but every state also carries a
 * `type` that does not change when a team relabels its states.
 * {@link mapLinearStateToStatus} maps off `type` first because it is the
 * stable signal; the state `name` is only consulted as a fallback for the
 * rarer webhook payload shape that omits `type` (older Linear webhook
 * configurations send `state` as just `{ name }`).
 *
 * {@link TYPE_TO_STATUS} covers seven type values: `triage`, `backlog`,
 * `unstarted`, `started`, `completed`, `canceled` (also spelled `cancelled`)
 * and `duplicate`. It is not written as a closed transcription of Linear's
 * enum and claims no total: anything unrecognized resolves `undefined`, which
 * leaves the row's status alone rather than guessing at it, so a value added
 * upstream is inert here until someone maps it.
 *
 * Either path lands on the same four-plus-received public vocabulary
 * (`triaged`/`in_progress`/`shipped`/`closed`) — never a literal 1:1 mirror of
 * Linear's own state set, which is the point: the reporter's status page never
 * shows Linear internals.
 *
 * @module lib/feedback/linear-status-map
 */
import type { FeedbackStatus } from '@/db/feedback-schema';

/** The subset of a Linear webhook's `state` object this mapping reads. */
export interface LinearWebhookState {
  name?: string;
  type?: string;
}

/**
 * Publicly-reachable statuses this mapping can produce. `received` is
 * deliberately excluded — it is the row's initial state before Linear ever
 * sees it, never something a Linear state transitions back into.
 */
type MappedStatus = Exclude<FeedbackStatus, 'received'>;

/** Linear's `WorkflowState.type` values → DorkOS status. Authoritative. */
const TYPE_TO_STATUS: Record<string, MappedStatus> = {
  triage: 'triaged',
  backlog: 'triaged',
  unstarted: 'triaged',
  started: 'in_progress',
  completed: 'shipped',
  // Linear's GraphQL schema spells this both ways across API versions.
  canceled: 'closed',
  cancelled: 'closed',
  // A duplicate is closed, not still-being-triaged. The `name` fallback below
  // already catches this for the feedback team as configured today, whose
  // state is literally named "Duplicate" — so this key changes nothing now
  // and fixes no live bug. It is here so that renaming that state (to
  // "Dupe", "Already reported", anything) cannot silently strand a
  // reporter's status page at "triaged".
  duplicate: 'closed',
};

/**
 * Fallback for a webhook payload that sends only `state.name`, keyed by
 * Linear's own default workflow state names (lowercased). A team that renames
 * its states away from these defaults loses this fallback, but the `type`
 * mapping above covers that case — this table only matters when `type` is
 * absent from the payload entirely.
 */
const NAME_TO_STATUS: Record<string, MappedStatus> = {
  triage: 'triaged',
  backlog: 'triaged',
  todo: 'triaged',
  'in progress': 'in_progress',
  'in review': 'in_progress',
  done: 'shipped',
  canceled: 'closed',
  cancelled: 'closed',
  duplicate: 'closed',
};

/**
 * Map a Linear webhook's issue `state` to a publicly-visible status, or
 * `undefined` when the state is absent or maps to nothing (an unrecognized
 * `type` and an unrecognized `name`) — the caller's job is to leave the row's
 * status untouched in that case, not guess.
 *
 * @param state - The webhook payload's `data.state`, if present.
 */
export function mapLinearStateToStatus(
  state: LinearWebhookState | undefined
): MappedStatus | undefined {
  if (!state) return undefined;
  if (state.type) {
    const byType = TYPE_TO_STATUS[state.type.toLowerCase()];
    if (byType) return byType;
  }
  if (state.name) {
    return NAME_TO_STATUS[state.name.toLowerCase()];
  }
  return undefined;
}

/** The subset of a Linear webhook's issue `data` {@link resolveShippedVersion} reads. */
export interface LinearWebhookShippedFields {
  projectMilestone?: { name?: string } | null;
  cycle?: { name?: string } | null;
}

/**
 * Best-effort resolution of the version a shipped issue went out in.
 *
 * Linear has no first-class "released in version X" field for an arbitrary
 * team, so this reads whichever of the two conventions a "Feedback intake"
 * team is more likely to use: a project milestone named after the release
 * (checked first, since milestones are commonly used for release trains) or a
 * cycle name as a fallback. Resolves `undefined` when neither is set —
 * callers must treat that as "leave the row's existing `shippedVersion`
 * alone," never as clearing it, since a later webhook delivery may fill in
 * what an earlier one could not.
 *
 * @param data - The webhook payload's issue `data`.
 */
export function resolveShippedVersion(data: LinearWebhookShippedFields): string | undefined {
  return data.projectMilestone?.name || data.cycle?.name || undefined;
}
