/**
 * Every prompt anywhere in the fleet that is waiting on a person.
 *
 * The twin of {@link usePendingApprovals} next door, and it lives here for the
 * same reason: the attention entity's whole job is "what needs me", and an
 * entity may not read a sibling entity's model. A store in `entities/session`
 * would have made the one consumer that matters illegal.
 *
 * @module entities/attention/model/use-pending-interactions
 */
import { useMemo } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useShallow } from 'zustand/shallow';
import {
  InteractionPendingEventSchema,
  InteractionResolvedEventSchema,
  type InteractionPendingEvent,
  type PendingInteractionsResponse,
} from '@dorkos/shared/interaction-events';
import type { PendingInteractionDTO } from '@dorkos/shared/types';
import { useSessionStreamStore } from '@/layers/entities/session';
import { useEventSubscription, useTransport } from '@/layers/shared/model';
import { recordAskReceipt, settleAsk } from './ask-receipt-store';

/** Query key for the fleet-wide pending-prompt list. */
export const PENDING_INTERACTIONS_QUERY_KEY = ['pending-interactions'] as const;

/** Shared empty, so an unanswered query never mints a fresh array identity. */
const NO_INTERACTIONS: readonly InteractionPendingEvent[] = [];

/** What {@link usePendingInteractions} hands its consumers. */
export interface PendingInteractionsState {
  /** Every prompt waiting on a person, in the order the server listed them. */
  interactions: readonly InteractionPendingEvent[];
  /** True only on the very first load, before any answer has arrived. */
  isLoading: boolean;
}

/**
 * Every prompt anywhere in the fleet that is waiting on a person.
 *
 * Seeded on mount from `transport.listPendingInteractions()` and then kept live
 * by the global stream, so a window that opened after an Ask was raised shows it
 * as fast as one that was watching. There is no poll and no republish: the
 * countdown each card draws is local, off the interaction's own start time.
 *
 * ## The one rule about the two stores
 *
 * `entities/session`'s stream store holds `pendingInteractions` for the ONE
 * session this window has attached, fed by that session's seq'd stream. Both
 * stores hold the same ids. So:
 *
 * > The **global** store is the single source for the card family — the header
 * > pill, the sidebar, home, the room lane. The **per-session** store keeps
 * > owning the inline prompt inside the transcript. For an id present in both,
 * > `remainingMs` comes from the per-session DTO (it is seq'd and fresher) and
 * > `roomId` from the global one.
 *
 * The attached session therefore shows exactly one card in its transcript and
 * one entry in the tray, and answering either resolves both, because both are
 * retired by the same `interaction_resolved`.
 */
export function usePendingInteractions(): PendingInteractionsState {
  const transport = useTransport();
  const queryClient = useQueryClient();

  const { data, isLoading } = useQuery({
    queryKey: PENDING_INTERACTIONS_QUERY_KEY,
    queryFn: () => transport.listPendingInteractions(),
  });

  useEventSubscription('interaction_pending', (raw) => {
    const parsed = InteractionPendingEventSchema.safeParse(raw);
    if (!parsed.success) return;
    queryClient.setQueryData<PendingInteractionsResponse>(
      PENDING_INTERACTIONS_QUERY_KEY,
      (current) => {
        const interactions = current?.interactions ?? [];
        // Upsert, never append: the same prompt arrives twice whenever a refetch
        // races the event, and two cards for one question is the shape a person
        // reads as "it asked me again".
        const next = interactions.filter(
          (entry) => entry.interaction.id !== parsed.data.interaction.id
        );
        return { ...current, interactions: [...next, parsed.data] };
      }
    );
  });

  useEventSubscription('interaction_resolved', (raw) => {
    const parsed = InteractionResolvedEventSchema.safeParse(raw);
    if (!parsed.success) return;
    // The receipt first, so the card has something to say before it is taken out
    // of the list it is drawn from.
    recordAskReceipt(parsed.data.interactionId, {
      outcome: parsed.data.outcome,
      resolvedAt: parsed.data.resolvedAt,
      ...(parsed.data.resolvedBy ? { resolvedBy: parsed.data.resolvedBy } : {}),
      byThisWindow: false,
    });
    queryClient.setQueryData<PendingInteractionsResponse>(
      PENDING_INTERACTIONS_QUERY_KEY,
      (current) => {
        if (!current) return current;
        const settled = current.interactions.find(
          (entry) => entry.interaction.id === parsed.data.interactionId
        );
        if (settled === undefined) return current;
        // Hold the card on screen just long enough to say how it ended. It is
        // out of THIS list the moment it is answered, because it is not waiting
        // any more and no count may claim it is.
        settleAsk(settled);
        return {
          ...current,
          interactions: current.interactions.filter(
            (entry) => entry.interaction.id !== parsed.data.interactionId
          ),
        };
      }
    );
  });

  // The attached session's own DTOs, keyed by interaction id. `useShallow` holds
  // across status churn because the store is immer-backed: a `session_status`
  // leaves `pendingInteractions` structurally shared, so these keep their
  // identity until a prompt actually opens or closes.
  const attached = useSessionStreamStore(
    useShallow((state): Record<string, PendingInteractionDTO> => {
      const out: Record<string, PendingInteractionDTO> = {};
      for (const session of Object.values(state.sessions)) {
        for (const interaction of session.pendingInteractions) out[interaction.id] = interaction;
      }
      return out;
    })
  );

  const cached = data?.interactions;
  const interactions = useMemo(() => {
    if (!cached || cached.length === 0) return NO_INTERACTIONS;
    return cached.map((entry) => {
      const fresher = attached[entry.interaction.id];
      // Membership is the global list's to decide; the attached session only
      // ever refreshes the numbers on a row that is already there.
      return fresher === undefined ? entry : { ...entry, interaction: fresher };
    });
  }, [cached, attached]);

  return { interactions, isLoading };
}
