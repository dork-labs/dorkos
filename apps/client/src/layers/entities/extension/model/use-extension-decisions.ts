/**
 * What extensions are asking a person about, kept live, and the answers a
 * person gives from the bell (spec `flow-multiproject` §7.5, §7.8).
 *
 * @module entities/extension/model/use-extension-decisions
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import {
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
  /** The decision being answered. */
  decision: Pick<ExtensionDecisionDTO, 'id' | 'extensionName'>;
  /** What the person chose. */
  request: DecisionActionRequest;
}

/** What {@link useExtensionDecisionActions} hands its caller. */
export interface ExtensionDecisionActions {
  /**
   * Answer a decision. Resolves with what it came to (so the caller can follow
   * `navigate`), or null when it failed, after a toast in plain words.
   */
  answer: (input: DecisionAnswerInput) => Promise<DecisionActionResponse | null>;
  /** Say "Yes" to, or quietly dismiss, a one-time follow-up offer. */
  answerOffer: (decisionId: string, accept: boolean) => void;
  /** The decision whose answer is in flight, and which action, or null. */
  pending: { id: string; action: DecisionActionRequest['action'] } | null;
}

/**
 * Answer extensions' decisions from core's own UI, attributed to the person.
 *
 * A decision the extension keeps open stays on screen, with the extension's
 * message as a toast. Every answer re-reads the list, so a row that resolved
 * leaves and a follow-up offer appears under it.
 */
export function useExtensionDecisionActions(): ExtensionDecisionActions {
  const queryClient = useQueryClient();
  const refresh = () => {
    void queryClient.invalidateQueries({ queryKey: extensionDecisionsKey() });
  };

  const answer = useMutation<DecisionActionResponse, Error, DecisionAnswerInput>({
    mutationFn: async ({ decision, request }) => {
      const res = await fetch(`${resolveApiBaseUrl()}/extension-decisions/${decision.id}/action`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(request),
      });
      if (!res.ok) throw await failureOf(res);
      return DecisionActionResponseSchema.parse(await res.json());
    },
    onSuccess: (response) => {
      if (response.message) toast(response.message);
    },
    onError: (err) => {
      toast.error(err.message);
    },
    onSettled: refresh,
    meta: { suppressErrorToast: true },
  });

  const offer = useMutation<string | null, Error, { decisionId: string; accept: boolean }>({
    mutationFn: async ({ decisionId, accept }) => {
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
      if (!accept && err.code === 'offer_gone') return;
      toast.error(err.message);
    },
    onSettled: refresh,
    meta: { suppressErrorToast: true },
  });

  return {
    answer: (input) => answer.mutateAsync(input).catch(() => null),
    answerOffer: (decisionId, accept) => offer.mutate({ decisionId, accept }),
    pending: answer.isPending
      ? { id: answer.variables.decision.id, action: answer.variables.request.action }
      : null,
  };
}
