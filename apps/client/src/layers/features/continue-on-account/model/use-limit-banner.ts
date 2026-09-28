/**
 * Everything the out-of-usage banner reads and does (spec `claude-account-ui`
 * §6.7): the session's limit, who ran out and where the work may go, in the
 * app's own names, and the banner's writes.
 *
 * It makes no usage request: the limit rides the session stream, account
 * names and colors come from the config already cached, so a one-account
 * person pays nothing until a limit actually happens. The server decides the
 * state, the countdown targets and eligibility; nothing here ranks anything
 * (invariant 6).
 *
 * @module features/continue-on-account/model/use-limit-banner
 */
import { useEffect, useRef, useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useRuntimeCapabilities } from '@/layers/entities/runtime';
import { useModels, useSessionId } from '@/layers/entities/session';
import { useSessionAccount, type SessionAccount } from '@/layers/features/status';
import {
  limitStateOf,
  limitSubject,
  type LimitState,
  type SessionLimitView,
} from '@/layers/shared/lib';
import { accountKeys, useClaudeAccounts, useTransport } from '@/layers/shared/model';
import { canOpenPicker, isSelectable } from '../lib/continue-picker';
import { isCarryOverRefused } from '../lib/limit-banner';
import type { ModelName } from '../lib/limit-marker';
import { useAccountNamer, type NamedAccount } from './use-account-namer';
import { useContinuedHere } from './continue-here-store';
import { useContinueOptions } from './use-continue-options';

/** The runtime a session with no resolved runtime yet is read as. */
const DEFAULT_RUNTIME = 'claude-code';

/** The states in which the work may move to another account. */
const MOVABLE: ReadonlySet<LimitState> = new Set(['limited', 'handing-off', 'model-limited']);

/**
 * The session's account as the banner reads it: `useSessionAccount`'s answer,
 * or the same fields handed in by the Dev Playground.
 */
export type LimitBannerAccount = Pick<
  SessionAccount,
  'visible' | 'runtime' | 'accountId' | 'name' | 'limit' | 'trackerItem'
>;

/** What {@link useLimitBanner} reports. */
export interface LimitBanner {
  /** The session's account, as read (or as handed in). */
  account: LimitBannerAccount;
  /** The session's limit, or `null` when it has none. */
  limit: SessionLimitView | null;
  /** Where the limit stands, or `null` with no limit. */
  state: LimitState | null;
  /** The session's runtime. */
  runtime: string;
  /** Who ran out: the account's name with 2+ accounts, else the runtime's (`limitSubject`). */
  subject: string;
  /** Whether accounts are told apart on this runtime (the identity gate). */
  identityGate: boolean;
  /** Whether the picker may open (`canOpenPicker`) and the plan allows a carry-over. */
  canPick: boolean;
  /** Names and colors an account of this session's runtime by its registry id. */
  nameOf: (accountId: string) => NamedAccount;
  /** The runtime's models, for display names. */
  models: readonly ModelName[];
  /** Whether the person chose to continue here in this episode. */
  continuedHere: boolean;
  /** Choose to continue here for this episode. */
  continueHere: () => void;
  /** Wait for the reset (`POST …/wait`), with `autoResume` only when given. */
  wait: (autoResume?: boolean) => void;
  /** Carry the work over, or switch the model (`POST …/continue`). */
  continueOn: (body: { account?: string; model?: string }) => void;
  /** Open another session. */
  openSession: (sessionId: string) => void;
  /** Whether a write is in flight. */
  pending: boolean;
  /** What the last write failed with, in the server's words, or `null`. */
  failure: string | null;
}

/** The message a refused write carries, for the inline alert. */
function messageOf(error: unknown): string {
  return error instanceof Error && error.message ? error.message : "Couldn't do that. Try again.";
}

/**
 * Read and act on a session's usage limit, for the out-of-usage banner.
 *
 * @param sessionId - The session.
 * @param injected - The session's account, handed in instead of read (the Dev Playground).
 */
export function useLimitBanner(sessionId: string, injected?: LimitBannerAccount): LimitBanner {
  const transport = useTransport();
  const queryClient = useQueryClient();
  const [, setSessionId] = useSessionId();
  // Never a usage fetch, even with the gate open: the banner reads the cache.
  const live = useSessionAccount(sessionId, { fetchUsage: false });
  const account: LimitBannerAccount = injected ?? live;
  const limit = account.limit;
  const state = limit ? limitStateOf(limit) : null;
  const runtime = account.runtime ?? DEFAULT_RUNTIME;
  const identityGate = account.visible;

  const nameOf = useAccountNamer();
  // Only Claude Code has a registry to name its accounts from; any other
  // runtime is named by `limitSubject` (its runtime's name).
  const ownLabel =
    runtime === DEFAULT_RUNTIME && limit?.accountId ? nameOf(limit.accountId).name : account.name;
  const subject = limitSubject({ runtime, accountLabel: ownLabel, identityGate });

  const models = useModels({ sessionId: sessionId || undefined, runtime }).data ?? [];

  // Whether the picker may open. With the gate closed only the server's
  // ranking can say so (another runtime's accounts, spec §7.3 N3), so it is
  // read then, and only while the work could move at all.
  const refused = limit ? isCarryOverRefused(limit.plan) : true;
  const movable = state !== null && MOVABLE.has(state) && !refused;
  // Asked only once the gate is known to be closed: while config and
  // capabilities load it reads closed, and asking then would be for nothing.
  const { isLoaded: accountsLoaded } = useClaudeAccounts();
  const { data: capabilities } = useRuntimeCapabilities();
  const gateKnown = accountsLoaded && capabilities !== undefined;
  // A model limit is reported even when no other account could take the work
  // (the server ranks it above wait-only), so it offers the picker only when
  // the ranking has an account that can be picked; that needs the gate too.
  const modelLimited = state === 'model-limited';
  const options = useContinueOptions(
    sessionId,
    movable && gateKnown && (modelLimited ? identityGate : !identityGate)
  );
  const canPick =
    movable &&
    (modelLimited
      ? identityGate && (options.data?.ranking.accounts.some(isSelectable) ?? false)
      : canOpenPicker(identityGate, options.data?.ranking, runtime));

  const { continuedHere, continueHere } = useContinuedHere(sessionId, limit?.since ?? null);

  // A refused write belongs to the state it was made in: kept with that
  // state's key, and not shown once the limit has moved on.
  const since = limit?.since ?? null;
  const stateKey = `${since}:${state}`;
  const [failed, setFailed] = useState<{ key: string; message: string } | null>(null);
  const setFailure = (message: string | null) =>
    setFailed(message === null ? null : { key: stateKey, message });
  const onError = (error: unknown) => setFailure(messageOf(error));
  const waitMutation = useMutation({
    mutationFn: (body: { autoResume?: boolean }) => transport.waitForReset(sessionId, body),
    retry: false,
    onError,
  });
  const continueMutation = useMutation({
    mutationFn: (body: { account?: string; model?: string }) =>
      transport.continueSession(sessionId, body),
    retry: false,
    onError,
    onSuccess: (answer) => {
      // A carry-over names the new session; a model switch names this one; a
      // flow run names none (flow reports the move, and the banner shows it).
      if (answer.sessionId && answer.sessionId !== sessionId) setSessionId(answer.sessionId);
    },
  });

  // When the limit clears, the episode was just written to the history: read
  // it again so the transcript's marker replaces the banner.
  const previousSince = useRef<string | null>(since);
  useEffect(() => {
    if (previousSince.current !== null && since === null) {
      void queryClient.invalidateQueries({ queryKey: accountKeys.limitHistory(sessionId) });
    }
    previousSince.current = since;
  }, [since, sessionId, queryClient]);

  return {
    account,
    limit,
    state,
    runtime,
    subject,
    identityGate,
    canPick,
    nameOf,
    models,
    continuedHere,
    continueHere,
    wait: (autoResume) => {
      setFailure(null);
      waitMutation.mutate(autoResume === undefined ? {} : { autoResume });
    },
    continueOn: (body) => {
      setFailure(null);
      continueMutation.mutate(body);
    },
    openSession: (id) => setSessionId(id),
    pending: waitMutation.isPending || continueMutation.isPending,
    failure: failed?.key === stateKey ? failed.message : null,
  };
}
