import { memo, useEffect, useState } from 'react';
import {
  BaseEdge,
  EdgeLabelRenderer,
  getBezierPath,
  type EdgeProps,
  useStore,
  type ReactFlowState,
} from '@xyflow/react';
import { AnimatePresence, motion } from 'motion/react';
import { X } from 'lucide-react';
import { cn } from '@/layers/shared/lib';
import { sessionStrategyLabel } from '@/layers/entities/binding';
import { useRelayFlowStore } from '../model/relay-flow-store';
import { usePrefersReducedMotion } from '../lib/use-reduced-motion';
import { PULSE_MIN_ZOOM, PULSE_DURATION_MS } from '../config/relay-flow-constants';

const zoomSelector = (s: ReactFlowState) => s.transform[2];

/**
 * Data carried by binding edges in the topology graph.
 * The index signature satisfies @xyflow/react's `Record<string, unknown>` constraint.
 */
export interface BindingEdgeData extends Record<string, unknown> {
  /** Human-readable label shown on the edge. Falls back to sessionStrategy. */
  label?: string;
  /** Session strategy for the binding (per-chat, per-user, stateless). */
  sessionStrategy?: string;
  /** Specific chat ID filter for this binding. */
  chatId?: string;
  /** Channel type filter (e.g., 'private', 'group', 'channel'). */
  channelType?: string;
  /** Called with the edge ID when the delete button is clicked. */
  onDelete?: (edgeId: string) => void;
}

/** Resolve the display label: prefer explicit label, then a friendly strategy label, then 'Channel'. */
function resolveDisplayLabel(data: BindingEdgeData | undefined): string {
  if (data?.label) return data.label;
  if (data?.sessionStrategy) return sessionStrategyLabel(data.sessionStrategy);
  return 'Channel';
}

/** React Flow custom edge for adapter-agent bindings with hover-to-reveal label. */
function BindingEdgeInner({
  id,
  sourceX,
  sourceY,
  targetX,
  targetY,
  sourcePosition,
  targetPosition,
  data,
  selected,
}: EdgeProps) {
  const d = data as BindingEdgeData | undefined;
  const zoom = useStore(zoomSelector);
  const [hovered, setHovered] = useState(false);

  const [edgePath, labelX, labelY] = getBezierPath({
    sourceX,
    sourceY,
    targetX,
    targetY,
    sourcePosition,
    targetPosition,
  });

  const displayLabel = resolveDisplayLabel(d);
  const showLabel = (hovered || selected) && zoom >= 0.7;

  // Relay-flow pulse: a single --color-primary dot tracing the exact
  // edgePath, coalesced per edge, suppressed below the LOD threshold and
  // under reduced-motion (Decision 5 — nothing renders, not a static blip).
  const activity = useRelayFlowStore((s) => s.activity[id]);
  const clear = useRelayFlowStore((s) => s.clear);
  const prefersReduced = usePrefersReducedMotion();
  const showPulse = !!activity && !prefersReduced && zoom >= PULSE_MIN_ZOOM;

  // A pulse this edge declines to animate (zoomed out below the LOD
  // threshold, or the edge remounting into view after having been
  // viewport-culled) must not linger in the store — otherwise it survives
  // until conditions change and every suppressed edge replays at once, a
  // flurry instead of the live signal it was meant to be. `clear` here is
  // idempotent (a no-op once the entry is gone), so this never races the
  // in-flight animation's own `onAnimationComplete` cleanup.
  useEffect(() => {
    if (activity && !showPulse) clear(id);
  }, [activity, showPulse, clear, id]);

  function handleDelete(e: React.MouseEvent) {
    e.stopPropagation();
    d?.onDelete?.(id);
  }

  return (
    <>
      {/* Invisible wider hit area for hover detection */}
      <path
        d={edgePath}
        fill="none"
        stroke="transparent"
        strokeWidth={12}
        onMouseEnter={() => setHovered(true)}
        onMouseLeave={() => setHovered(false)}
      />
      <BaseEdge
        id={id}
        path={edgePath}
        className={cn(
          'transition-colors duration-150',
          selected ? 'stroke-primary stroke-2' : 'stroke-primary/60 stroke-2'
        )}
      />
      <AnimatePresence>
        {showPulse && (
          <motion.circle
            key={activity.nonce}
            r={3}
            className="fill-primary"
            style={{ offsetPath: `path("${edgePath}")` }}
            initial={{
              offsetDistance: activity.direction === 'inbound' ? '0%' : '100%',
              opacity: 0,
            }}
            animate={{
              offsetDistance: activity.direction === 'inbound' ? '100%' : '0%',
              opacity: [0, 1, 1, 0],
            }}
            exit={{ opacity: 0 }}
            transition={{ duration: PULSE_DURATION_MS / 1000, ease: 'easeInOut' }}
            onAnimationComplete={() => clear(id)}
          />
        )}
      </AnimatePresence>
      {showLabel && (
        <EdgeLabelRenderer>
          <div
            style={{
              transform: `translate(-50%, -50%) translate(${labelX}px,${labelY}px)`,
              pointerEvents: 'all',
              transition: 'opacity 150ms ease-out',
            }}
            className="nodrag nopan bg-background/90 flex max-w-[160px] flex-col items-center gap-0.5 rounded-md px-1.5 py-0.5 shadow-sm"
            role="presentation"
            onMouseEnter={() => setHovered(true)}
            onMouseLeave={() => setHovered(false)}
          >
            <div className="flex items-center gap-1">
              <span className="text-muted-foreground truncate text-[10px]">{displayLabel}</span>
              {selected && d?.onDelete && (
                <button
                  onClick={handleDelete}
                  className="text-destructive/60 hover:bg-destructive/10 hover:text-destructive ml-0.5 shrink-0 rounded-sm p-0.5"
                  aria-label="Remove channel"
                >
                  <X className="size-3" />
                </button>
              )}
            </div>
            {/* Filter badges — only shown when chatId or channelType present */}
            {(d?.chatId || d?.channelType) && (
              <div className="flex items-center gap-1">
                {d.chatId && (
                  <span className="bg-muted text-muted-foreground rounded px-1 py-px text-[9px]">
                    {d.chatId}
                  </span>
                )}
                {d.channelType && (
                  <span className="bg-muted text-muted-foreground rounded px-1 py-px text-[9px]">
                    {d.channelType}
                  </span>
                )}
              </div>
            )}
          </div>
        </EdgeLabelRenderer>
      )}
    </>
  );
}

/** Memoized React Flow custom edge for adapter-agent bindings. */
export const BindingEdge = memo(BindingEdgeInner);
