/**
 * The boot gate: when the sidebar is allowed to stop being a skeleton.
 *
 * Separated from the hook that reads the queries so the rule can be tested as a
 * truth table rather than through ten mocked queries (spec
 * `sidebar-simplification` D6).
 *
 * @module features/dashboard-sidebar/model/boot/boot-gate
 */

/**
 * How long the panel waits for a source that will not answer.
 *
 * A ceiling, not a budget: past it the panel paints what it has and whatever is
 * still pending reads as empty, exactly as it did before there was a gate. A
 * gate with no timeout turns one slow query into a permanently blank sidebar,
 * which is worse than the pop-in it was meant to fix.
 *
 * **The timeout degrades per zone, not per pixel** — see {@link fleetKnown}.
 * One source is not allowed to degrade quietly, because painting without it
 * would not be "missing rows" but "wrong rows".
 */
export const BOOT_GATE_TIMEOUT_MS = 1500;

/**
 * Whether each source the panel paints from has answered.
 *
 * "Answered" means the query is no longer pending — a failure counts, because a
 * source that errored is not going to tell us any more than it already has and
 * the panel must not wait on it.
 */
export interface BootQueryFacts {
  /** `GET /api/config` — pins, groups, collapse state, mute state. */
  config: boolean;
  /** The room list — Channels and Direct messages. */
  rooms: boolean;
  /** The thread list — Today's thread rows. */
  threads: boolean;
  /** The fleet's directories — how many agent rows there will be. */
  mesh: boolean;
  /** The resolved manifests — every agent's real name and face (DOR-1143). */
  manifests: boolean;
  /**
   * Whether the fleet has any directories at all.
   *
   * When it has none there are no manifests to wait for and the manifests query
   * never runs (`useResolvedAgents` disables itself), so waiting on it would
   * hold the gate shut forever on an install with no agents.
   */
  hasAgentPaths: boolean;
  /** The recent-sessions window — Today's rows and the Agents section's order. */
  recents: boolean;
  /** The team roster — the header's team name. */
  roster: boolean;
  /**
   * Tool approvals waiting on a person — Heads up's largest source.
   *
   * A gate member since the adversarial review of D6: "paints once" has to
   * include Heads up, and this query is already open and cheap. Left out, an
   * install with a parked approval painted the panel and then grew a whole zone
   * at the top a beat later, pushing everything below it down — the exact
   * second beat the gate exists to remove.
   */
  approvals: boolean;
  /** Questions an agent asked and is parked on — a Heads up row each. */
  interactions: boolean;
  /** Scheduled runs waiting for a person to approve them — Heads up rows too. */
  scheduleApprovals: boolean;
}

/**
 * Whether every source the panel paints from has answered.
 *
 * @param facts - What each boot query has done so far.
 */
export function bootGateOpen(facts: BootQueryFacts): boolean {
  return (
    facts.config &&
    facts.rooms &&
    facts.threads &&
    facts.mesh &&
    (facts.manifests || !facts.hasAgentPaths) &&
    facts.recents &&
    facts.roster &&
    facts.approvals &&
    facts.interactions &&
    facts.scheduleApprovals
  );
}

/**
 * Whether the panel may draw anything whose identity comes from the fleet.
 *
 * **The one source that is not allowed to degrade on the timeout** (DOR-1143).
 * The other nine can: a pending room list reads as no rooms, and rooms arriving
 * late is a row appearing. Manifests are different in kind, because the fallback
 * for "no manifest" is a hash of the DIRECTORY and the real face is a hash of
 * the manifest's id — two different faces. So a panel that painted agent rows
 * while manifests were pending would not be missing anything; it would be
 * showing the wrong face and the wrong name, and changing both a moment later.
 * That is the defect the whole of D6 was written to kill, and the 1500 ms
 * ceiling re-introduced it for exactly the installs that need it least: the slow
 * ones, where mesh and manifests are two SERIAL round trips.
 *
 * So the timeout opens the gate — the panel paints, Today paints, Channels
 * paint — and the rows drawn from the fleet stay withheld until their manifests
 * land. The path-hash fallback keeps its one honest job: a directory the roster
 * has answered about and genuinely cannot name.
 *
 * **The mesh is part of the question, not just the manifests.** Before the mesh
 * answers there are no paths, so `hasAgentPaths` is `false` — which reads
 * exactly like "an install with no agents", the one case where there is nothing
 * to wait for. A browser probe caught it: with the mesh slow and the manifests
 * slower, this said "known" during the gap, the consumer latched that, and the
 * agent rows painted from the path hash after all. "We have not asked yet" is
 * not "there is nothing there".
 *
 * @param facts - What each boot query has done so far.
 */
export function fleetKnown(facts: BootQueryFacts): boolean {
  if (!facts.mesh) return false;
  return facts.manifests || !facts.hasAgentPaths;
}
