/**
 * Smart-group presets and the progressive-disclosure gate (smart-agent-
 * groups, DOR-338 spec §4-5). Pure — no React, no I/O — so the threshold and
 * preset derivation are unit-testable without rendering the sidebar.
 *
 * @module features/dashboard-sidebar/model/smart-group-presets
 */
import type { SmartGroupRules } from '@dorkos/shared/config-schema';
import { getRuntimeDescriptor } from '@/layers/entities/runtime';
import type { SmartGroupCandidate } from './evaluate-smart-group';

/** Minimum fleet size that unlocks the "Smart" group-create fork (spec §5). */
const DISCLOSURE_MIN_AGENTS = 8;
/** Minimum distinct runtimes that unlocks the fork, independent of fleet size (spec §5). */
const DISCLOSURE_MIN_RUNTIMES = 2;
/** A "By runtime" preset chip only appears for a runtime with at least this many agents. */
const BY_RUNTIME_PRESET_MIN_AGENTS = 2;

/**
 * Whether the fleet is large/varied enough to show the "Smart" group-create
 * fork and its preset chips. Below this, only "Manual" create is offered —
 * small cockpits see zero new chrome (spec §5, same spirit as DOR-329's
 * `groupsHintDismissed` threshold).
 *
 * @param candidates - Every known agent's metadata for this render.
 */
export function meetsSmartGroupDisclosureThreshold(candidates: SmartGroupCandidate[]): boolean {
  if (candidates.length >= DISCLOSURE_MIN_AGENTS) return true;
  const runtimes = new Set(candidates.map((c) => c.runtime));
  return runtimes.size >= DISCLOSURE_MIN_RUNTIMES;
}

/** A one-click starter for the smart-group create flow. */
export interface SmartGroupPreset {
  /** Chip label and the new group's initial name. */
  label: string;
  /** The rules the new group is created with. */
  rules: SmartGroupRules;
}

/** The "Active now" preset — needs-attention or actively-working agents. */
export function activeNowPreset(): SmartGroupPreset {
  return { label: 'Active now', rules: { statuses: ['needs-attention', 'active'] } };
}

/**
 * One "By runtime" preset per runtime with at least
 * {@link BY_RUNTIME_PRESET_MIN_AGENTS} agents in the current fleet, ordered by
 * agent count (most first) then runtime label. A single-agent runtime isn't
 * worth a dedicated group.
 *
 * @param candidates - Every known agent's metadata for this render.
 */
export function byRuntimePresets(candidates: SmartGroupCandidate[]): SmartGroupPreset[] {
  const counts = new Map<string, number>();
  for (const c of candidates) counts.set(c.runtime, (counts.get(c.runtime) ?? 0) + 1);
  return Array.from(counts.entries())
    .filter(([, count]) => count >= BY_RUNTIME_PRESET_MIN_AGENTS)
    .map(([runtime, count]) => ({ runtime, count, label: getRuntimeDescriptor(runtime).label }))
    .sort((a, b) => b.count - a.count || a.label.localeCompare(b.label))
    .map(({ runtime, label }) => ({
      label: `By runtime · ${label}`,
      rules: { runtimes: [runtime] },
    }));
}
