/**
 * Pure smart-group rule evaluation (smart-agent-groups, DOR-338). A smart
 * group's membership is never persisted — it is re-derived on demand from
 * the caller's own agent/mesh metadata against the group's {@link
 * SmartGroupRules}. Runtime-neutral so the server and CLI can compute
 * membership too, not just the client sidebar that originated it (DOR-432).
 *
 * @module shared/smart-groups
 */
import type { SmartGroupRules } from './config-schema.js';

/**
 * One candidate's attention state, mirroring {@link
 * SmartGroupRules.statuses}'s enum without importing a client-only type.
 */
type SmartGroupCandidateStatus = NonNullable<SmartGroupRules['statuses']>[number];

/**
 * One agent's metadata as seen by rule evaluation. Callers build one of
 * these per candidate agent from whatever roster/mesh data they have —
 * the shape is intentionally minimal and structural, not tied to any
 * particular Agent entity.
 */
export interface SmartGroupCandidate {
  /** The agent's project path — what `evaluateSmartGroup` returns. */
  projectPath: string;
  /** Execution runtime (e.g. `'claude-code'`, `'codex'`). */
  runtime: string;
  /** Mesh namespace, or `null` when the agent has none recorded. */
  namespace: string | null;
  /** Current attention state. */
  attention: SmartGroupCandidateStatus;
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
 * caller builds `candidates` once per evaluation and (client-side) memoizes
 * this call on (rules identity, candidates identity).
 *
 * @param rules - The smart group's rule set (schema-guaranteed ≥1 field).
 * @param candidates - Every known agent's metadata for this evaluation.
 * @param now - Caller-supplied clock reading (epoch ms).
 */
export function evaluateSmartGroup(
  rules: SmartGroupRules,
  candidates: SmartGroupCandidate[],
  now: number
): string[] {
  return candidates.filter((c) => matchesRules(rules, c, now)).map((c) => c.projectPath);
}
