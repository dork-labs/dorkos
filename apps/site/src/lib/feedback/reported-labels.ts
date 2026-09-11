/**
 * Resolve the `reported/*` intake labels the feedback pipeline stamps on a new
 * Linear issue (DOR-1977).
 *
 * **Why intake gets a namespace of its own.** The kind a reporter picks on the
 * form is a *claim*, not a verdict. Writing that claim into `Bug` — the same
 * label triage uses to record what the thing actually turned out to be — puts
 * two different jobs in one slot with no way to tell which one you are reading.
 * (A real report came in tagged `Bug` because the reporter clicked "bug"; it
 * was a feature request, and nothing in the tracker said so.) So intake writes
 * `reported/defect`, `reported/idea` or `reported/feedback` on the intake
 * issue, and `Bug` / `Feature` / `Improvement` stay triage's vocabulary,
 * applied by a person on the work item when it is promoted. Both signals
 * survive, and you can always tell which one you are looking at.
 *
 * **Why the bug child is called `defect`.** `Bug`, `Feature` and `Improvement`
 * are workspace-level labels shared by every team, and Linear refuses to create
 * a group child whose name collides with a top-level label ("Label \"Bug\"
 * already exists in the workspace"). Child names may repeat across *groups*
 * (`type/idea` and `reported/idea` coexist happily), but not with a top-level
 * one. So the form's `bug` kind maps to `reported/defect`. This is forced by
 * Linear, not a preference — renaming it back is not available.
 *
 * **Why ids are looked up, not configured.** Three more label-id env vars is
 * three more things to provision, keep in sync across environments, and get
 * wrong silently. The group is identified by name instead, resolved once per
 * process and cached (see {@link reportedLabelIdsForKind}).
 *
 * **How the names read back.** Linear's GraphQL strips the group prefix: a
 * child of the `reported` group comes back as `name: "idea"` with
 * `parent { name: "reported" }`. There is no `"reported/idea"` string anywhere
 * in the API, so every match here is parent-name plus child-name — never a
 * literal slash.
 *
 * **Exclusivity, and why only a whole `labelIds` set is safe.** The `reported`
 * group is exclusive AND it *rejects* rather than swaps: adding a second member
 * to an issue that already carries one fails outright with
 * `INPUT_ERROR: labelIds not exclusive child labels` (measured 2026-09-10).
 * The pipeline is therefore only ever allowed to SET a complete `labelIds`
 * array — which is exactly what `issueCreate` does — carrying at most ONE
 * `reported/*` id. Never `issueAddLabel`, and never two members in one array.
 *
 * @module lib/feedback/reported-labels
 */
import type { FeedbackKind } from '@/db/feedback-schema';

import { linearGraphQL } from './linear-graphql';

/** The label group intake claims live under, lowercased for comparison. */
const REPORTED_GROUP_NAME = 'reported';

/**
 * Submission kind → the child label under `reported`. Every kind maps to one:
 * a plain `feedback` submission is a claim too ("this is neither a defect nor
 * a request"), and leaving it unlabelled made it the only kind you could not
 * filter for.
 */
const KIND_TO_REPORTED_CHILD: Record<FeedbackKind, string> = {
  // `defect`, not `bug` — see the module doc. Linear will not allow `bug`.
  bug: 'defect',
  idea: 'idea',
  feedback: 'feedback',
};

/**
 * Page size for the label lookup. Linear caps a page at 250, and one page is
 * the whole query — a team with more labels than this would silently miss the
 * group, which degrades to filing without a label like any other lookup miss.
 */
const LABEL_PAGE_SIZE = 250;

/**
 * Tighter than the default GraphQL cap. This is the least valuable leg of a
 * submission (a missing tag costs triage a filter; a missing report costs the
 * report), so it gets the smallest slice of the route's 10s budget.
 */
const LABEL_LOOKUP_TIMEOUT_MS = 2_500;

/** How long a good lookup is trusted. Labels are provisioned once and rarely move. */
const RESOLVED_TTL_MS = 15 * 60_000;

/**
 * How long a lookup that found nothing is trusted. Short, so a Linear blip or
 * a group that was just created recovers within a minute — but not zero, so a
 * misconfigured workspace does not add a round trip to every submission.
 */
const UNRESOLVED_TTL_MS = 60_000;

/**
 * How long the cache slot is held while a lookup is in flight, so a burst of
 * submissions shares one query instead of firing one apiece. Comfortably above
 * {@link LABEL_LOOKUP_TIMEOUT_MS}, since the entry re-stamps itself on settle.
 */
const IN_FLIGHT_TTL_MS = 30_000;

const TEAM_LABELS_QUERY = `
  query FeedbackReportedLabels($teamId: String!, $first: Int!) {
    team(id: $teamId) {
      labels(first: $first) {
        nodes {
          id
          name
          parent {
            name
          }
        }
      }
    }
  }
`;

interface TeamLabelsData {
  team?: {
    labels?: {
      nodes?: Array<{ id: string; name: string; parent?: { name?: string } | null }>;
    };
  } | null;
}

/** Resolved label id per kind. A kind is absent when its label could not be found. */
type ReportedLabelIds = Partial<Record<FeedbackKind, string>>;

interface LabelCacheEntry {
  teamId: string;
  /** Resolves to whatever was found. Never rejects — a failed lookup resolves `{}`. */
  ids: Promise<ReportedLabelIds>;
  /** Epoch ms after which this entry is refetched. Re-stamped once the lookup settles. */
  expiresAt: number;
}

let cache: LabelCacheEntry | null = null;

/** Collapse an error message to one bounded line for the log. */
function describeError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.replace(/\s+/g, ' ').trim().slice(0, 200);
}

/**
 * Fetch the team's labels and pick out the `reported` group's children.
 *
 * Never throws: a report is worth more than its tag, so every failure — a
 * network error, a bad key, a group somebody renamed by hand — resolves to an
 * empty map and the issue is filed unlabelled.
 */
async function fetchReportedLabelIds(apiKey: string, teamId: string): Promise<ReportedLabelIds> {
  try {
    const json = await linearGraphQL<TeamLabelsData>(
      apiKey,
      TEAM_LABELS_QUERY,
      { teamId, first: LABEL_PAGE_SIZE },
      LABEL_LOOKUP_TIMEOUT_MS
    );

    // Matching is parent-name + child-name because the API never spells the
    // group prefix: `reported/idea` reads back as `name: "idea"` under
    // `parent { name: "reported" }`. A literal slash match finds nothing.
    const byChildName = new Map<string, string>();
    for (const node of json.data?.team?.labels?.nodes ?? []) {
      if (node.parent?.name?.toLowerCase() !== REPORTED_GROUP_NAME) continue;
      byChildName.set(node.name.toLowerCase(), node.id);
    }

    const ids: ReportedLabelIds = {};
    for (const [kind, child] of Object.entries(KIND_TO_REPORTED_CHILD) as Array<
      [FeedbackKind, string]
    >) {
      const id = byChildName.get(child);
      if (id) ids[kind] = id;
    }
    if (Object.keys(ids).length === 0) {
      console.error('[feedback/linear] no reported/* labels found — filing without one', {
        teamId,
      });
    }
    return ids;
  } catch (error) {
    console.error('[feedback/linear] reported-label lookup failed — filing without one', {
      reason: describeError(error),
    });
    return {};
  }
}

/** Read the cached lookup, starting a fresh one when the slot is empty or stale. */
async function resolveReportedLabelIds(apiKey: string, teamId: string): Promise<ReportedLabelIds> {
  const now = Date.now();
  if (cache && cache.teamId === teamId && cache.expiresAt > now) return cache.ids;

  const entry: LabelCacheEntry = {
    teamId,
    expiresAt: now + IN_FLIGHT_TTL_MS,
    ids: fetchReportedLabelIds(apiKey, teamId),
  };
  cache = entry;

  const ids = await entry.ids;
  // Re-stamp only the slot still ours — a different team id may have replaced
  // it while this lookup was in flight.
  if (cache === entry) {
    const found = Object.keys(ids).length > 0;
    entry.expiresAt = Date.now() + (found ? RESOLVED_TTL_MS : UNRESOLVED_TTL_MS);
  }
  return ids;
}

/**
 * The `labelIds` a new intake issue should carry for `kind`: exactly one
 * `reported/*` id, or none at all when the lookup could not resolve it.
 *
 * The array is deliberately at most one element long — the `reported` group is
 * exclusive and rejects a set carrying two of its members (see the module doc).
 *
 * @param apiKey - The Linear API key, raw and unprefixed.
 * @param teamId - The team the intake issue is filed under.
 * @param kind - The kind the reporter picked on the form.
 */
export async function reportedLabelIdsForKind(
  apiKey: string,
  teamId: string,
  kind: FeedbackKind
): Promise<string[]> {
  const ids = await resolveReportedLabelIds(apiKey, teamId);
  const id = ids[kind];
  return id ? [id] : [];
}

/**
 * Drop the memoized lookup so the next call re-queries Linear.
 *
 * @internal Exported for testing only — the cache is process-lifetime otherwise.
 */
export function resetReportedLabelCache(): void {
  cache = null;
}
