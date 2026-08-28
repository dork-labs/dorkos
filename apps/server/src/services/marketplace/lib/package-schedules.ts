/**
 * Reading the `schedules[]` a package declares, whatever type it is.
 *
 * The slot lives on four of the five package types (`plugin`, `agent`,
 * `skill-pack`, `shape`) and deliberately not on `adapter`, which ships no
 * skills and installs with no agent attached. That makes `manifest.schedules` a
 * field TypeScript cannot reach without narrowing first, and every consumer
 * — the install materializer, the permission preview, the install-time cron
 * check — needs the same narrowing. Doing it once here keeps the exclusion in
 * one place: when a sixth type arrives, this function is the only thing that has
 * to decide whether it carries schedules.
 *
 * @module services/marketplace/lib/package-schedules
 */
import type { MarketplacePackageManifest } from '@dorkos/marketplace';
import type { PackageScheduleDecl } from '@dorkos/marketplace/manifest-schema';

/**
 * Every schedule a manifest declares, or an empty list for a type that has no
 * slot.
 *
 * @param manifest - Any validated package manifest.
 * @returns The declared schedules, never `undefined`.
 */
export function packageSchedules(
  manifest: MarketplacePackageManifest
): readonly PackageScheduleDecl[] {
  // An adapter has no `schedules` field at all — the schema refuses one.
  if (manifest.type === 'adapter') return [];
  // The schema's `.default([])` guarantees an array for anything that came
  // through a parse, but not everything does: a manifest read off disk by an
  // older build, or synthesized from a bare `.claude-plugin/plugin.json`, can
  // reach here with the key missing. Returning `[]` rather than trusting the
  // type keeps every consumer total — and one of those consumers decides what
  // uninstall DELETES, which is not a place to learn that a field was optional.
  return Array.isArray(manifest.schedules) ? manifest.schedules : [];
}

/**
 * What to call a schedule declaration in a message to a person.
 *
 * A by-reference entry is named by the skill it points at; an inline entry
 * carries its own name. One of the two is always present (the schema's
 * declaration-form rule guarantees it), but this stays total rather than
 * asserting, because it is used to BUILD validation errors — including the one
 * that fires when a malformed entry has neither.
 *
 * @param schedule - The declaration to name.
 * @param index - Its position in `schedules[]`, used for the last-resort label.
 * @returns A display name, never empty.
 */
export function scheduleDisplayName(schedule: PackageScheduleDecl, index: number): string {
  return schedule.skillRef ?? schedule.name ?? `#${index + 1}`;
}
