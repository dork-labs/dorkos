/**
 * What extensions are asking a person about, kept live, and the answers a
 * person gives from the bell (spec `flow-multiproject` §7.5, §7.8).
 *
 * @module entities/extension/model/use-extension-decisions
 */
import { useMemo, useState, useSyncExternalStore } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import {
  DECISION_OFFER_GONE_CODE,
  DECISION_OFFER_TTL_MS,
  DECISION_STALE_CODE,
  DecisionActionResponseSchema,
  DecisionOfferResponseSchema,
  ListExtensionDecisionsResponseSchema,
  type DecisionActionRequest,
  type DecisionActionResponse,
  type ExtensionDecisionDTO,
  type ListExtensionDecisionsResponse,
  type PendingDecisionOffer,
} from '@dorkos/shared/extension-decision-schemas';
import { resolveApiBaseUrl } from '@/layers/shared/lib';
import { useEventSubscription } from '@/layers/shared/model';
import { extensionQueryKeys } from './use-pending-extension-approvals';

/** Shared empty lists, so a quiet inbox never mints fresh arrays. */
const NO_DECISIONS: readonly ExtensionDecisionDTO[] = [];
const NO_OFFERS: readonly PendingDecisionOffer[] = [];

/** The query key for the open decisions. */
export const extensionDecisionsKey = () => [...extensionQueryKeys.all, 'decisions'] as const;

/** What {@link useExtensionDecisions} answers with. */
export interface ExtensionDecisionsState {
  /** Open decisions of running extensions, oldest first. */
  decisions: readonly ExtensionDecisionDTO[];
  /** One-time follow-up offers a person has not answered yet. */
  offers: readonly PendingDecisionOffer[];
  /** True while the first read is in flight. */
  isLoading: boolean;
}

/** A failed request's own sentence, or the status when it sent none. */
async function failureOf(res: Response): Promise<Error & { code?: string }> {
  const body = (await res.json().catch(() => ({}))) as { error?: string; code?: string };
  const error: Error & { code?: string } = new Error(
    body.error ?? `The server answered ${res.status}`
  );
  if (body.code) error.code = body.code;
  return error;
}

/** Read the list once. */
async function fetchDecisions(): Promise<ListExtensionDecisionsResponse> {
  const res = await fetch(`${resolveApiBaseUrl()}/extension-decisions`);
  if (!res.ok) throw await failureOf(res);
  return ListExtensionDecisionsResponseSchema.parse(await res.json());
}

/**
 * Every open decision extensions raised, kept live: re-read when one arrives,
 * changes or ends (`standing_pending` / `standing_resolved` of kind
 * `extension.decision`) and when any extension reloads (its decisions show or
 * hide with it).
 */
export function useExtensionDecisions(): ExtensionDecisionsState {
  const queryClient = useQueryClient();
  const { data, isLoading } = useQuery({
    queryKey: extensionDecisionsKey(),
    queryFn: fetchDecisions,
  });

  const refresh = (raw: unknown) => {
    const kind = (raw as { kind?: unknown } | null)?.kind;
    if (kind !== undefined && kind !== 'extension.decision') return;
    void queryClient.invalidateQueries({ queryKey: extensionDecisionsKey() });
  };
  useEventSubscription('standing_pending', refresh);
  useEventSubscription('standing_resolved', refresh);
  useEventSubscription('extension_reloaded', () => refresh(null));

  return {
    decisions: data?.decisions ?? NO_DECISIONS,
    offers: data?.offers ?? NO_OFFERS,
    isLoading,
  };
}

/** One answer from the bell. */
export interface DecisionAnswerInput {
  /** The decision being answered, and the revision the person saw. */
  decision: Pick<ExtensionDecisionDTO, 'id' | 'extensionName' | 'revision'>;
  /** What the person chose. */
  request: Omit<DecisionActionRequest, 'revision'>;
}

/** A one-time offer this client holds: the reply to an answer it gave. */
interface LocalOffer {
  decisionId: string;
  text: string;
  expiresAt: number;
}

/**
 * Offers made in reply to an answer given HERE (spec `flow-multiproject`
 * §7.8): they show only on the client that answered, and only until this
 * page goes away, so a reload never shows one again.
 */
const localOffers = new Map<string, LocalOffer>();
/** Offers the bell actually drew while it was open, which closing it dismisses. */
const shownInBell = new Set<string>();
const offerListeners = new Set<() => void>();
let offerSnapshot: readonly PendingDecisionOffer[] = [];

/** Wakes the offers when the next one lapses, so a line left open disappears on time. */
let lapseTimer: ReturnType<typeof setTimeout> | null = null;

function publishOffers(): void {
  const now = Date.now();
  for (const [id, offer] of localOffers) {
    if (offer.expiresAt <= now) localOffers.delete(id);
  }
  if (lapseTimer) clearTimeout(lapseTimer);
  lapseTimer = null;
  const next = Math.min(...[...localOffers.values()].map((offer) => offer.expiresAt));
  if (Number.isFinite(next)) lapseTimer = setTimeout(publishOffers, next - now);
  offerSnapshot = [...localOffers.values()]
    .filter((offer) => offer.expiresAt > now)
    .map((offer) => ({
      decisionId: offer.decisionId,
      text: offer.text,
      expiresAt: new Date(offer.expiresAt).toISOString(),
    }));
  for (const listener of [...offerListeners]) listener();
}

function subscribeOffers(listener: () => void): () => void {
  offerListeners.add(listener);
  return () => {
    offerListeners.delete(listener);
  };
}

/**
 * The one-time offers this client should draw: the ones it got back from its
 * own answers, then the listed ones for a person's answer an extension
 * credited later.
 */
export function useDecisionOffers(): readonly PendingDecisionOffer[] {
  const local = useSyncExternalStore(
    subscribeOffers,
    () => offerSnapshot,
    () => NO_OFFERS
  );
  const { offers: listed } = useExtensionDecisions();
  return useMemo(() => {
    const seen = new Set(local.map((offer) => offer.decisionId));
    return [...local, ...listed.filter((offer) => !seen.has(offer.decisionId))];
  }, [local, listed]);
}

/**
 * Note that the bell drew an offer, so closing the bell dismisses it. Offers
 * drawn anywhere else (the Activity page) are never dismissed by the bell.
 *
 * @param decisionId - The decision the offer follows.
 */
export function markOfferShownInBell(decisionId: string): void {
  shownInBell.add(decisionId);
}

/** The offers the bell drew since it opened, emptied as they are handed back. */
export function takeOffersShownInBell(): string[] {
  const ids = [...shownInBell];
  shownInBell.clear();
  return ids;
}

/** What {@link useExtensionDecisionActions} hands its caller. */
export interface ExtensionDecisionActions {
  /**
   * Answer a decision. Resolves with what it came to (so the caller can follow
   * `navigate`), or null when it failed, after a message in plain words.
   */
  answer: (input: DecisionAnswerInput) => Promise<DecisionActionResponse | null>;
  /** Say "Yes" to, or quietly dismiss, a one-time follow-up offer. */
  answerOffer: (decisionId: string, accept: boolean) => void;
  /** Which answer is in flight for a decision, or null. Per row: two rows can be answered at once. */
  pendingFor: (decisionId: string) => DecisionActionRequest['action'] | null;
}

/**
 * Answer extensions' decisions from core's own UI, attributed to the person.
 *
 * A decision the extension keeps open stays on screen, with the extension's
 * message as a toast. Every answer re-reads the list, so a row that resolved
 * leaves. A follow-up offer that came back is held by this client alone. An
 * answer to a question that changed since it was drawn is refused, and the
 * list is read again so the person sees what is asked now.
 */
export function useExtensionDecisionActions(): ExtensionDecisionActions {
  const queryClient = useQueryClient();
  const [inFlight, setInFlight] = useState<ReadonlyMap<string, DecisionActionRequest['action']>>(
    () => new Map()
  );
  const refresh = () => {
    void queryClient.invalidateQueries({ queryKey: extensionDecisionsKey() });
  };

  const answer = async ({ decision, request }: DecisionAnswerInput) => {
    setInFlight((current) => new Map(current).set(decision.id, request.action));
    try {
      const res = await fetch(`${resolveApiBaseUrl()}/extension-decisions/${decision.id}/action`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...request, revision: decision.revision }),
      });
      if (!res.ok) {
        const err = await failureOf(res);
        // A question that changed is not a failure to shout about.
        if (err.code === DECISION_STALE_CODE) toast(err.message);
        else toast.error(err.message);
        return null;
      }
      const response = DecisionActionResponseSchema.parse(await res.json());
      if (response.message) toast(response.message);
      if (response.offer) {
        localOffers.set(decision.id, {
          decisionId: decision.id,
          text: response.offer.text,
          expiresAt: Date.now() + DECISION_OFFER_TTL_MS,
        });
        publishOffers();
      }
      return response;
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Couldn’t send that. Try again.');
      return null;
    } finally {
      setInFlight((current) => {
        const next = new Map(current);
        next.delete(decision.id);
        return next;
      });
      refresh();
    }
  };

  const offer = useMutation<string | null, Error, { decisionId: string; accept: boolean }>({
    mutationFn: async ({ decisionId, accept }) => {
      if (localOffers.delete(decisionId)) publishOffers();
      const res = await fetch(`${resolveApiBaseUrl()}/extension-decisions/${decisionId}/offer`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ accept }),
      });
      if (!res.ok) throw await failureOf(res);
      return DecisionOfferResponseSchema.parse(await res.json()).message;
    },
    onSuccess: (message) => {
      if (message) toast(message);
    },
    onError: (err: Error & { code?: string }, { accept }) => {
      // A dismiss of an offer that already lapsed is not news.
      if (!accept && err.code === DECISION_OFFER_GONE_CODE) return;
      toast.error(err.message);
    },
    onSettled: refresh,
    meta: { suppressErrorToast: true },
  });

  return {
    answer,
    answerOffer: (decisionId, accept) => offer.mutate({ decisionId, accept }),
    pendingFor: (decisionId) => inFlight.get(decisionId) ?? null,
  };
}
