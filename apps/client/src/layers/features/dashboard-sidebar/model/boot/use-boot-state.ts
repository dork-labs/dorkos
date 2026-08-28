/**
 * Where the sidebar is in its first paint (spec `sidebar-simplification` D6).
 *
 * **"Pending" and "empty" used to be the same value everywhere in the model**,
 * so the panel painted an empty `<div>` and then assembled itself in front of
 * the operator in about eight beats — Heads up, then pins and groups a round
 * trip late, then sixty rooms, then thirty agents that collapsed to a handful
 * when the recents landed, then every agent's name and face flipping at once.
 * This is the one bit that tells those two states apart, and everything about
 * the first paint hangs off it.
 *
 * **It reads queries, it does not make them.** Every hook called here is one
 * the cockpit already has open; they share a cache entry, so a second caller
 * costs a subscription and not a request. That is what lets the header block
 * (mounted in `AppShell`, outside the panel) and the panel itself agree about
 * the same boot without threading a prop between two component trees.
 *
 * @module features/dashboard-sidebar/model/boot/use-boot-state
 */
import { useEffect, useMemo, useState } from 'react';
import { useResolvedAgents } from '@/layers/entities/agent';
import {
  usePendingApprovals,
  usePendingInteractions,
  usePendingScheduleApprovals,
} from '@/layers/entities/attention';
import { useConfig } from '@/layers/entities/config';
import { useMeshAgentPaths } from '@/layers/entities/mesh';
import { useRooms, useThreads } from '@/layers/entities/room';
import { RECENT_SESSIONS_WINDOW, useRecentSessions } from '@/layers/entities/session';
import { useTeamRoster } from '@/layers/entities/team';
import { bootGateOpen, fleetKnown, BOOT_GATE_TIMEOUT_MS, type BootQueryFacts } from './boot-gate';
import { useRenderSlot } from '@/layers/shared/lib';

/**
 * How the panel came up.
 *
 * - `cold` — nothing was known at mount; the panel shows a skeleton.
 * - `warm` — every source was already in the cache at mount, and the panel can
 *   paint its final shape in the first frame.
 * - `settled` — the boot gate has opened; this is where a panel spends the rest
 *   of the session.
 */
export type BootPhase = 'cold' | 'warm' | 'settled';

/** What {@link useBootState} answers. */
export interface BootState {
  /** The phase, for callers that switch on one value. */
  phase: BootPhase;
  /** Whether the boot gate has opened. Never goes back to `false`. */
  settled: boolean;
  /**
   * Whether the manifests are in, so a row drawn from the fleet is drawn right.
   *
   * Separate from {@link BootState.settled} because the 1500 ms ceiling can open
   * the gate with this still `false`, and the two answers have to differ there:
   * the panel paints, and the rows whose faces and names come from manifests
   * wait. See `fleetKnown` for why this one source may not degrade.
   */
  fleetKnown: boolean;
  /**
   * Whether every boot source already had data in the very first frame.
   *
   * Latched at mount and never recomputed — it is a fact about how this mount
   * began, which is exactly what "should anything animate into place?" needs to
   * know. Task 3.2 adds the persisted cache that makes it true; until then it is
   * a seam that always reads `false` at runtime, and the reveal is always owed.
   */
  startedWarm: boolean;
}

/** A query whose freshness the gate reads. Structural, so tests can stand one up. */
interface GateQuery {
  status: 'pending' | 'success' | 'error';
  dataUpdatedAt: number;
}

/** A source has answered when it is no longer pending — an error counts. */
function answered(query: GateQuery): boolean {
  return query.status !== 'pending';
}

/** No paths, as one identity — a fresh `[]` per render would re-key the manifests query. */
const NO_PATHS: string[] = [];

/** How the three attention hooks report the same fact, since they hide their query. */
function attentionAnswered(state: { isLoading: boolean }): boolean {
  return !state.isLoading;
}

/**
 * The panel's boot phase.
 *
 * Safe to call from anywhere that draws part of the sidebar; every caller sees
 * the same answer because every caller reads the same query cache.
 *
 * **Every consumer latches independently, and that is currently safe.** Each
 * mount runs its own 1500 ms timer and its own `startedWarm` read, so two
 * consumers could in principle disagree. They cannot today: the panel, its
 * header, its bottom slot and Today all mount in the same commit, off one
 * router render, so their timers start within a frame of each other and they
 * read one shared query cache. Centralise this behind a provider the moment
 * either of those stops being true — a consumer mounted on a later route, or a
 * consumer that wants a different ceiling.
 */
export function useBootState(): BootState {
  const config = useConfig();
  const rooms = useRooms();
  const threads = useThreads();
  const mesh = useMeshAgentPaths();
  const recents = useRecentSessions(RECENT_SESSIONS_WINDOW);
  const roster = useTeamRoster();
  // Heads up's three sources. Cheap, already open, and the zone they feed is
  // the top of the panel — a late arrival there pushes everything down.
  const approvals = usePendingApprovals();
  const interactions = usePendingInteractions();
  const scheduleApprovals = usePendingScheduleApprovals();

  // The paths key the manifests query, so they have to be stable or every render
  // would re-key it. Derived through the joined string rather than held in a
  // ref: the identity then follows the VALUE, with nothing written during
  // render.
  const pathKey = (mesh.data?.agents ?? []).map((entry) => entry.projectPath).join('\0');
  const paths = useMemo(() => (pathKey === '' ? NO_PATHS : pathKey.split('\0')), [pathKey]);
  const manifests = useResolvedAgents(paths);

  // **The sources the panel's SHAPE comes from, named once.** Both answers below
  // are derived from this one object rather than from two hand-kept lists, which
  // is what a review of task 3.2 asked for: the lists had already drifted apart
  // in effect once (see `rosterResolved` in `use-sidebar-state.ts`), and a
  // seventh source added to one and forgotten in the other fails in the
  // hardest-to-see way — a panel that is subtly not warm on a reload.
  //
  // Heads up's three are deliberately NOT here. They belong to the gate (a late
  // Heads up pushes the whole panel down) but not to warmth, because they are
  // the three the persisted cache refuses to keep: a stale "three things need
  // you" that resolves to zero is a confident lie. Adding one here would make
  // every warm reload cold again.
  const shape = { config, rooms, threads, mesh, recents, roster };

  const facts: BootQueryFacts = {
    ...(Object.fromEntries(
      Object.entries(shape).map(([name, query]) => [name, answered(query)])
    ) as Record<keyof typeof shape, boolean>),
    manifests: answered(manifests),
    hasAgentPaths: paths.length > 0,
    approvals: attentionAnswered(approvals),
    interactions: attentionAnswered(interactions),
    scheduleApprovals: attentionAnswered(scheduleApprovals),
  };

  // Hydrated-at-mount, read once. A query that has never held data reports
  // `dataUpdatedAt: 0`, and the manifests query is disabled (so permanently 0)
  // on an install with no agents — which is warm, not cold, since there is
  // nothing left to wait for.
  const [startedWarm] = useState(
    () =>
      Object.values(shape).every((query) => query.dataUpdatedAt > 0) &&
      (paths.length === 0 || manifests.dataUpdatedAt > 0)
  );

  const [timedOut, setTimedOut] = useState(false);
  useEffect(() => {
    const timer = setTimeout(() => setTimedOut(true), BOOT_GATE_TIMEOUT_MS);
    return () => clearTimeout(timer);
  }, []);

  // Latched, so that once the panel has painted for real it never goes back to a
  // skeleton however the queries behave afterwards — a background refetch is not
  // a boot. Derived first and remembered second: `open` is already true on the
  // render the gate opens, and the state below only preserves it, so nothing
  // waits a frame for an effect.
  const open = bootGateOpen(facts) || timedOut;
  const everOpen = useRenderSlot(false);
  if (open) everOpen.write(true);
  const settled = open || everOpen.read();

  // Same latch, same reason: manifests answering is permanent, and a refetch
  // must not withdraw the fleet from a panel that has already drawn it.
  const fleet = fleetKnown(facts);
  const everFleet = useRenderSlot(false);
  if (fleet) everFleet.write(true);

  let phase: BootPhase = 'cold';
  if (settled) phase = 'settled';
  else if (startedWarm) phase = 'warm';

  return { phase, settled, fleetKnown: fleet || everFleet.read(), startedWarm };
}
