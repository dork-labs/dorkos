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

/**
 * Subscribe to `relay_flow` and pulse the corresponding edge. Mount once for
 * the whole topology graph (not per-edge).
 *
 * @param enabled - Gate on the caller's `relayEnabled` flag. When false, no
 *   store writes happen — the store stays empty, degrading to nothing when
 *   relay is off. The subscription itself is not gated on reduced-motion;
 *   the store write is cheap and the render decision belongs to
 *   `BindingEdge`, keeping that gate in one place.
 */
export function useRelayFlowSubscription(enabled: boolean): void {
  const pulse = useRelayFlowStore((s) => s.pulse);

  useEventSubscription('relay_flow', (raw) => {
    if (!enabled) return;
    const parsed = RelayFlowEventSchema.safeParse(raw);
    if (!parsed.success) return;
    const { bindingId, direction } = parsed.data;
    pulse(`binding:${bindingId}`, direction);
  });
}
