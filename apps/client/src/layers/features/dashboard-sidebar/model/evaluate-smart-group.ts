/**
 * Plain-language smart-group rule summary (smart-agent-groups, DOR-338).
 * Membership evaluation itself (`evaluateSmartGroup` + `SmartGroupCandidate`)
 * lives in `@dorkos/shared/smart-groups` (DOR-432) so the server and CLI can
 * compute it too; this file keeps only the describe/label helpers, which stay
 * client-only because they format labels via `getRuntimeDescriptor`.
 *
 * @module features/dashboard-sidebar/model/evaluate-smart-group
 */
import type { SmartGroupRules } from '@dorkos/shared/config-schema';
import { getRuntimeDescriptor } from '@/layers/entities/runtime';
import type { AttentionState } from '@/layers/entities/session';

/**
 * Human-readable labels for {@link AttentionState}, in rules-summary order.
 * Also the status-checkbox labels in the smart-group rule form.
 */
export const STATUS_LABELS: Record<AttentionState, string> = {
  'needs-attention': 'needs attention',
  active: 'active',
  idle: 'idle',
  fresh: 'new',
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
