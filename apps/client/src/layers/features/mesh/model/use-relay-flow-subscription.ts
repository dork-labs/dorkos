/**
 * Bridges the global `/api/events` stream's `relay_flow` events to the
 * topology's per-edge {@link useRelayFlowStore}.
 *
 * Lives in `features/mesh/model` (NOT `entities/relay`) because an entity
 * cannot import a features-layer store — FSD's `shared ← entities ← features`
 * hierarchy makes the mesh store unreachable from an entity hook. The server
 * emits `relay_flow` keyed by binding participants (Decision 6 in the spec);
 * the client does only a trivial edge-id lookup, never subject parsing.
 *
 * @module features/mesh/model/use-relay-flow-subscription
 */
import { useEventSubscription } from '@/layers/shared/model';
import { RelayFlowEventSchema } from '@dorkos/shared/relay-schemas';
import { useRelayFlowStore } from './relay-flow-store';
import { usePrefersReducedMotion } from '../lib/use-reduced-motion';

/**
 * Subscribe to `relay_flow` and pulse the corresponding edge. Mount once for
 * the whole topology graph (not per-edge).
 *
 * @param enabled - Gate on the caller's `relayEnabled` flag. When false, no
 *   store writes happen — the store stays empty, degrading to nothing when
 *   relay is off. Also gated on reduced-motion: while the user prefers
 *   reduced motion, a pulse will never render, so it is never written
 *   either — an entry with nowhere to render is an entry that can only sit
 *   in the store until reduced-motion is turned off, at which point every
 *   accumulated edge would replay at once. The zoom/LOD gate stays in
 *   `BindingEdge` (this hook has no per-edge zoom to check against).
 */
export function useRelayFlowSubscription(enabled: boolean): void {
  const pulse = useRelayFlowStore((s) => s.pulse);
  const prefersReducedMotion = usePrefersReducedMotion();

  useEventSubscription('relay_flow', (raw) => {
    if (!enabled || prefersReducedMotion) return;
    const parsed = RelayFlowEventSchema.safeParse(raw);
    if (!parsed.success) return;
    const { bindingId, direction } = parsed.data;
    pulse(`binding:${bindingId}`, direction);
  });
}
