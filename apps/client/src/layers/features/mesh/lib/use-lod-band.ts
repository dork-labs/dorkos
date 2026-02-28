import { useStore, type ReactFlowState } from '@xyflow/react';

/** Level-of-detail bands for topology graph nodes. */
export type LodBand = 'compact' | 'default' | 'expanded';

const ZOOM_COMPACT = 0.6;
const ZOOM_EXPANDED = 1.2;

/** Derives the LOD band from the current zoom level. */
function deriveBand(zoom: number): LodBand {
  if (zoom < ZOOM_COMPACT) return 'compact';
  if (zoom > ZOOM_EXPANDED) return 'expanded';
  return 'default';
}

/**
 * Returns the current LOD band derived from React Flow's zoom level.
 * Only re-renders when the band changes, not on every zoom tick.
 */
export function useLodBand(): LodBand {
  return useStore((s: ReactFlowState) => deriveBand(s.transform[2]));
}
