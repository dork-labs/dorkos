import { useEffect, useRef } from 'react';

import { useSessionListStore } from '@/layers/entities/session';
import { useTasks } from '@/layers/entities/tasks';
import { useExternalAdapterCatalog, useRelayEnabled } from '@/layers/entities/relay';
import { useRegisteredAgents } from '@/layers/entities/mesh';

import type { TourOccasion } from './tour-definitions';
import { useTours } from './use-tours';

/** The count at which each occasion tour becomes relevant. */
const TASKS_THRESHOLD = 1;
const RELAY_THRESHOLD = 1;
/** Mesh introduces itself on the *second* agent, so the fleet is worth touring. */
const MESH_THRESHOLD = 2;

/**
 * Watch for the first genuine use of a subsystem and offer its tour.
 *
 * Detection is client-side and observes 0-to-1 (1-to-2 for Mesh) transitions in
 * the live query caches while the app is open, so pre-existing users — whose
 * counts start already above the threshold — never see an offer. An offer never
 * fires during an active streaming turn (it defers until the turn ends rather
 * than interrupting), never when the tour is already seen or declined, and at
 * most one offer stands at a time. Mount once, high in the tree.
 */
export function useTourOccasions(): void {
  const { isSuppressed, setPendingOffer, pendingOfferId, runningDefinition } = useTours();

  const isStreaming = useSessionListStore((s) =>
    Object.values(s.statuses).some((status) => status.lifecycle === 'streaming')
  );

  const relayEnabled = useRelayEnabled();
  const { data: tasks } = useTasks();
  const { data: catalog } = useExternalAdapterCatalog(relayEnabled);
  const { data: mesh } = useRegisteredAgents();

  const taskCount = tasks?.length;
  const channelCount =
    relayEnabled && catalog
      ? catalog.reduce((n, entry) => n + entry.instances.length, 0)
      : undefined;
  const agentCount = mesh?.agents.length;

  const prevTasks = useRef<number | undefined>(undefined);
  const prevChannels = useRef<number | undefined>(undefined);
  const prevMesh = useRef<number | undefined>(undefined);

  useEffect(() => {
    // Detect one occasion, updating its baseline. Returns whether an offer now
    // stands (so a later occasion in the same pass does not also fire).
    const detect = (
      id: TourOccasion,
      count: number | undefined,
      threshold: number,
      ref: React.MutableRefObject<number | undefined>,
      blocked: boolean
    ): boolean => {
      if (count === undefined) return blocked;
      const prev = ref.current;
      if (prev === undefined) {
        ref.current = count;
        return blocked;
      }
      const crossed = prev < threshold && count >= threshold;
      if (!crossed) {
        ref.current = count;
        return blocked;
      }
      // Defer across a streaming turn: leave the baseline stale so the crossing
      // re-fires once the turn ends instead of interrupting it.
      if (isStreaming) return blocked;
      ref.current = count;
      if (blocked || isSuppressed(id)) return blocked;
      setPendingOffer(id);
      return true;
    };

    let blocked = pendingOfferId !== null || runningDefinition !== null;
    blocked = detect('tasks', taskCount, TASKS_THRESHOLD, prevTasks, blocked);
    blocked = detect('relay', channelCount, RELAY_THRESHOLD, prevChannels, blocked);
    detect('mesh', agentCount, MESH_THRESHOLD, prevMesh, blocked);
  }, [
    taskCount,
    channelCount,
    agentCount,
    isStreaming,
    pendingOfferId,
    runningDefinition,
    isSuppressed,
    setPendingOffer,
  ]);
}
