/**
 * Pure smart-group rule evaluation and plain-language summary (smart-agent-
 * groups, DOR-338). A smart group's membership is never persisted — it is
 * re-derived on every render from the mesh metadata the sidebar already
 * holds (roster, resolved agent manifests, the attention map, recent-session
 * activity). Mesh stays the source of truth; `ui.sidebar` stores only the
 * `rules`, never a member list.
 *
 * @module features/dashboard-sidebar/model/evaluate-smart-group
 */
import type { SmartGroupRules } from '@dorkos/shared/config-schema';
import { getRuntimeDescriptor } from '@/layers/entities/runtime';
import type { AttentionState } from '@/layers/entities/session';

/** One agent's metadata as seen by rule evaluation — built once per render. */
export interface SmartGroupCandidate {
  /** The agent's project path — what `evaluateSmartGroup` returns. */
  projectPath: string;
  /** Execution runtime (e.g. `'claude-code'`, `'codex'`). */
  runtime: string;
  /** Mesh namespace, or `null` when the agent has none recorded. */
  namespace: string | null;
  /** Current attention state (from `useAgentAttentionMap`). */
  attention: AttentionState;
  /** Latest known session activity (epoch ms), or `null` if never active. */
  lastActivityAt: number | null;
}

/**
 * Whether `candidate` matches every PRESENT field in `rules` (AND across
 * fields). Within a field, any listed value passes (OR) — e.g.
 * `runtimes: ['codex', 'opencode']` matches either. An absent field imposes
 * no constraint. `lastActiveWithinMs` is inclusive at the boundary (mirrors
 * `deriveAttention`'s own `elapsed <= activeWithinMs` convention) and never
 * matches a candidate with no recorded activity.
 *
 * @param rules - The smart group's rule set.
 * @param candidate - The agent metadata to test.
 * @param now - Caller-supplied clock reading (epoch ms) — kept pure/testable.
 */
function matchesRules(
  rules: SmartGroupRules,
  candidate: SmartGroupCandidate,
  now: number
): boolean {
  if (rules.runtimes && !rules.runtimes.includes(candidate.runtime)) return false;
  if (rules.namespaces) {
    if (candidate.namespace === null || !rules.namespaces.includes(candidate.namespace)) {
      return false;
    }
  }
  if (rules.statuses && !rules.statuses.includes(candidate.attention)) return false;
  if (rules.lastActiveWithinMs !== undefined) {
    if (candidate.lastActivityAt === null) return false;
    if (now - candidate.lastActivityAt > rules.lastActiveWithinMs) return false;
  }
  if (rules.pathPrefix && !candidate.projectPath.startsWith(rules.pathPrefix)) return false;
  return true;
}

/**
 * Evaluate a smart group's `rules` against every candidate, returning the
 * matching project paths in their input order. Deterministic, no I/O — the
 * sidebar builds `candidates` once per render and memoizes this call on
 * (rules identity, candidates identity).
 *
 * @param rules - The smart group's rule set (schema-guaranteed ≥1 field).
 * @param candidates - Every known agent's metadata for this render.
 * @param now - Caller-supplied clock reading (epoch ms).
 */
export function evaluateSmartGroup(
  rules: SmartGroupRules,
  candidates: SmartGroupCandidate[],
  now: number
): string[] {
  return candidates.filter((c) => matchesRules(rules, c, now)).map((c) => c.projectPath);
}

/** Human-readable labels for {@link AttentionState}, in rules-summary order. */
const STATUS_LABELS: Record<AttentionState, string> = {
  'needs-attention': 'needs attention',
  active: 'active',
  idle: 'idle',
  inactive: 'inactive',
};

/** Common activity-window presets the create/edit form offers (spec §4). */
const ACTIVITY_WINDOW_LABELS: Record<number, string> = {
  [60 * 60 * 1000]: 'active in the last hour',
  [24 * 60 * 60 * 1000]: 'active in the last day',
  [7 * 24 * 60 * 60 * 1000]: 'active in the last week',
};

/** Join a list of phrases the way plain English does: "a", "a or b", "a, b, or c". */
function joinEnglish(parts: string[]): string {
  if (parts.length === 0) return '';
  if (parts.length === 1) return parts[0]!;
  if (parts.length === 2) return `${parts[0]} or ${parts[1]}`;
  return `${parts.slice(0, -1).join(', ')}, or ${parts[parts.length - 1]}`;
}

/** Describe an arbitrary `lastActiveWithinMs` outside the three UI presets. */
function describeActivityWindow(ms: number): string {
  const known = ACTIVITY_WINDOW_LABELS[ms];
  if (known) return known;
  const days = ms / (24 * 60 * 60 * 1000);
  if (Number.isInteger(days)) return `active in the last ${days} day${days === 1 ? '' : 's'}`;
  const hours = ms / (60 * 60 * 1000);
  const rounded = Math.round(hours * 10) / 10;
  return `active in the last ${rounded} hour${rounded === 1 ? '' : 's'}`;
}

/**
 * Render a smart group's `rules` as one plain-language line for the header
 * menu (e.g. `"Codex · active in the last hour"`) — the UI's honesty
 * contract: whatever this says is exactly what `evaluateSmartGroup` does,
 * nothing more. Field order matches the rule form: runtime, namespace,
 * status, activity window, path.
 *
 * @param rules - The smart group's rule set.
 */
export function describeRules(rules: SmartGroupRules): string {
  const parts: string[] = [];
  if (rules.runtimes && rules.runtimes.length > 0) {
    parts.push(joinEnglish(rules.runtimes.map((r) => getRuntimeDescriptor(r).label)));
  }
  if (rules.namespaces && rules.namespaces.length > 0) {
    parts.push(`in ${joinEnglish(rules.namespaces)}`);
  }
  if (rules.statuses && rules.statuses.length > 0) {
    parts.push(joinEnglish(rules.statuses.map((s) => STATUS_LABELS[s])));
  }
  if (rules.lastActiveWithinMs !== undefined) {
    parts.push(describeActivityWindow(rules.lastActiveWithinMs));
  }
  if (rules.pathPrefix) {
    parts.push(`under ${rules.pathPrefix}`);
  }
  return parts.length > 0 ? parts.join(' · ') : 'No rules set';
}
