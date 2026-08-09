/**
 * How mesh health is drawn on the topology page — the one place in the cockpit
 * that still draws it at all.
 *
 * Health used to ride every agent disc in the product as a coloured 2px ring
 * (`AgentAvatar`), which put a diagnostic about the last hour on every list row
 * and sat it 2px outside a "working right now" dot lit from the same fact. The
 * ring is gone (DOR-1052). What replaces it is this: health said out loud, on
 * the surface whose entire subject is health, with a word next to the colour so
 * it does not depend on telling green from amber.
 *
 * @module features/mesh/lib/health-display
 */
import type { AgentHealthStatus } from '@dorkos/shared/mesh-schemas';
import { STATUS_DOT_COLOR } from '@/layers/shared/ui';

/** What one health status is called, and what colour it wears. */
export interface HealthDisplay {
  /** The word for this status, shown wherever there is room for one. */
  label: string;
  /**
   * The dot's colour — a theme token, and where one exists, the same token the
   * rest of the cockpit signals with.
   *
   * **Nothing here animates.** Health is "when did we last hear from it", which
   * is a state; motion is reserved for things happening as you look at them.
   * The legend's green swatch used to ping, which said "live" about an agent
   * that may have been quiet for fifty-nine minutes.
   */
  dot: string;
}

/**
 * Every mesh health status, in the vocabulary the topology legend spells out.
 *
 * `stale` is the muted foreground rather than a status colour on purpose: "we
 * have not heard from it" is an absence, not a diagnosis.
 */
export const HEALTH_DISPLAY: Record<AgentHealthStatus, HealthDisplay> = {
  active: { label: 'Active', dot: STATUS_DOT_COLOR.working },
  inactive: { label: 'Inactive', dot: STATUS_DOT_COLOR['needs-you'] },
  stale: { label: 'Stale', dot: 'bg-muted-foreground/50' },
  unreachable: { label: 'Unreachable', dot: STATUS_DOT_COLOR.error },
};
