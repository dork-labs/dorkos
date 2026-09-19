/**
 * SLO floors and the constraint, both by fixed rule (plan §4.4).
 *
 * Floors: when an SLO is `met` or `ok` for 4 consecutive non-overlapping
 * weekly windows, each of its floor values tightens halfway to the objective.
 * A floor never loosens except through a ledger entry's `floor-release`,
 * applied once and recorded.
 *
 * Constraint precedence (the report names exactly one):
 *   1. a tripwire: a collector health failure, or a `headroom` breach
 *      (ratchet violations join this tier in phase 2);
 *   2. a quality SLO breach, in `ci/slos.yaml` order;
 *   3. the SLO with the most excess wait-hours against its objective.
 */
import type { Constraint, Floors, SloReading } from './data.ts';
import type { Slos } from './schemas.ts';
import { addDays, dayStart, isoWeek, round } from './time.ts';

/** A floor release taken from a ledger entry. */
export interface FloorRelease {
  ledgerId: string;
  slo: string;
  stat: string;
  value: number;
  reason: string;
}

/**
 * Current floor values by SLO id and stat; ci/slos.yaml's floors where
 * floors.json has none yet.
 *
 * @param slos - `ci/slos.yaml`.
 * @param floors - `floors.json`, or `null` before the first report.
 */
export function floorValues(
  slos: Slos,
  floors: Floors | null
): Record<string, Record<string, number>> {
  const out: Record<string, Record<string, number>> = {};
  for (const s of slos.slos) {
    out[s.id] = {
      ...Object.fromEntries((s.floor ?? []).map((t) => [t.stat, t.value])),
      ...floors?.slos[s.id]?.floor,
    };
  }
  return out;
}

/** The week after `week`, e.g. 2026-W38 -> 2026-W39. */
function nextWeek(week: string): string {
  const [y, w] = week.split('-W').map(Number) as [number, number];
  const jan4 = dayStart(`${y}-01-04`);
  const monday = addDays(
    jan4.toISOString().slice(0, 10),
    -((jan4.getUTCDay() || 7) - 1) + (w - 1) * 7
  );
  return isoWeek(dayStart(addDays(monday, 7)));
}

/**
 * Record one closed week's readings, apply any new floor releases, and
 * tighten every floor that has earned it.
 *
 * @param slos - `ci/slos.yaml`.
 * @param prior - The current floors.json, or `null`.
 * @param week - The closed ISO week the readings cover.
 * @param readings - That week's SLO readings.
 * @param releases - Floor releases from the ledger.
 * @param now - The clock.
 * @returns The new floors and one line per change.
 */
export function updateFloors(
  slos: Slos,
  prior: Floors | null,
  week: string,
  readings: readonly SloReading[],
  releases: readonly FloorRelease[],
  now: Date
): { floors: Floors; changes: string[] } {
  const values = floorValues(slos, prior);
  const floors: Floors = { schema: 1, updated_at: now.toISOString(), slos: {} };
  const changes: string[] = [];
  for (const slo of slos.slos) {
    const before = prior?.slos[slo.id];
    const entry = {
      floor: { ...values[slo.id] },
      weeks: [...(before?.weeks ?? [])],
      moved: [...(before?.moved ?? [])],
    };
    const reading = readings.find((r) => r.id === slo.id);
    if (reading && !entry.weeks.some((w) => w.week === week)) {
      entry.weeks.push({ week, status: reading.status });
      entry.weeks = entry.weeks.slice(-12);
    }
    for (const rel of releases.filter((r) => r.slo === slo.id)) {
      const why = `ledger ${rel.ledgerId}: ${rel.reason}`;
      if (entry.moved.some((m) => m.why === why && m.stat === rel.stat)) continue;
      const from = entry.floor[rel.stat];
      if (from === undefined) continue;
      entry.floor[rel.stat] = rel.value;
      entry.moved.push({ week, stat: rel.stat, from, to: rel.value, why });
      changes.push(`${slo.id} ${rel.stat} floor released ${from} -> ${rel.value} (${why})`);
    }
    const lastMove = entry.moved
      .map((m) => m.week)
      .sort()
      .at(-1);
    const since = entry.weeks.filter((w) => !lastMove || w.week > lastMove);
    const streak = since.slice(-4);
    const consecutive = streak.every((w, i) => i === 0 || nextWeek(streak[i - 1]!.week) === w.week);
    if (
      streak.length === 4 &&
      consecutive &&
      streak.every((w) => w.status === 'met' || w.status === 'ok')
    ) {
      for (const [stat, from] of Object.entries(entry.floor)) {
        const obj = slo.objective.find((t) => t.stat === stat);
        if (!obj || from === obj.value) continue;
        const to = round(from + (obj.value - from) / 2, 4);
        entry.floor[stat] = to;
        entry.moved.push({
          week,
          stat,
          from,
          to,
          why: '4 consecutive weeks met or ok: tightened halfway to the objective',
        });
        changes.push(`${slo.id} ${stat} floor tightened ${from} -> ${to}`);
      }
    }
    floors.slos[slo.id] = entry;
  }
  return { floors, changes };
}

const fmt = (r: SloReading) =>
  Object.entries(r.stats)
    .map(([k, v]) => `${k} ${v}`)
    .join(', ');

/**
 * Name the one constraint, by the fixed precedence.
 *
 * @param slos - `ci/slos.yaml`, whose order sets the quality tier's order.
 * @param readings - The current SLO readings.
 * @param healthFailures - The collector's health failures; any one is a tripwire.
 */
export function pickConstraint(
  slos: Slos,
  readings: readonly SloReading[],
  healthFailures: readonly string[]
): Constraint {
  if (healthFailures.length > 0) {
    return {
      tier: 'tripwire',
      id: 'collector-health',
      reason: `The collector's own health failed (${healthFailures.length} problem${healthFailures.length === 1 ? '' : 's'}); no other number can be trusted until it is fixed. First: ${healthFailures[0]}`,
    };
  }
  const byId = new Map(readings.map((r) => [r.id, r]));
  for (const slo of slos.slos.filter((s) => s.kind === 'tripwire')) {
    const r = byId.get(slo.id);
    if (r?.status === 'breach')
      return {
        tier: 'tripwire',
        id: slo.id,
        reason: `${slo.title}: ${fmt(r)}${r.note ? ` (${r.note})` : ''} breaches its floor.`,
      };
  }
  for (const slo of slos.slos.filter((s) => s.kind === 'quality')) {
    const r = byId.get(slo.id);
    if (r?.status === 'breach')
      return { tier: 'quality', id: slo.id, reason: `${slo.title}: ${fmt(r)} breaches its floor.` };
  }
  const ranked = readings
    .filter((r) => r.excess_hours !== null && r.excess_hours > 0)
    .sort((a, b) => b.excess_hours! - a.excess_hours! || a.id.localeCompare(b.id));
  const top = ranked[0];
  if (top) {
    return {
      tier: 'speed',
      id: top.id,
      reason: `${top.excess_hours} excess wait-hours against the objective over ${top.from} to ${top.to} (${fmt(top)}), the most of any SLO.`,
    };
  }
  return {
    tier: 'none',
    id: null,
    reason: 'Every SLO with enough data meets its objective or has no excess wait.',
  };
}
