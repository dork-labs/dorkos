/**
 * The trust posture an install runs under (ADR `261006-225605`).
 *
 * Two answers, decided by the stored preset alone: an install on Careful has
 * asked for agents to ask first; every other install, including one that has
 * not chosen yet, is Trusted. Everything that loosens a default for our own
 * agents (schedules armed without asking, extensions approved at creation,
 * connected apps shared with every agent) reads this one function, so a
 * person who picks Careful turns all of them back off at once.
 *
 * @module shared/permissions/trust-posture
 */
import type { PermissionPreset } from './permission-schemas.js';

/** Whether agents act without asking (`trusted`) or ask first (`careful`). */
export type TrustPosture = 'trusted' | 'careful';

/**
 * The trust posture for a stored preset.
 *
 * @param preset - `permissions.preset` as stored; `null` or absent means not chosen.
 */
export function trustPosture(preset: PermissionPreset | null | undefined): TrustPosture {
  return preset === 'careful' ? 'careful' : 'trusted';
}
