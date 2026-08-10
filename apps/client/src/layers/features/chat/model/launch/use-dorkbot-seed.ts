/**
 * The `?seed=dorkbot-help` launch link — background Ask DorkBot hands its first
 * turn, exactly once (BC-48).
 *
 * It is the quiet sibling of `use-launch-prompt`. That one puts words in the
 * composer; this one puts nothing on screen at all. The composer stays empty and
 * focused, the person types their own question, and the seed rides that send as
 * `seedContext` — a hidden preamble the server renders into a `<seed_context>`
 * block. Nothing is ever typed on somebody's behalf.
 *
 * **Once, and only on the first send.** The latch is a module-level set keyed by
 * session, the same shape and for the same reasons as `use-launch-prompt`'s: a
 * remount is not a new launch, and StrictMode's double-invoke is not either. The
 * URL is spent the moment the seed is taken, so a refresh or a Back cannot
 * re-issue it.
 *
 * **A seed that can never apply is spent, not deferred.** A conversation that
 * already has history gets no seed — background about a page somebody left ten
 * turns ago is noise — and the param is dropped rather than left armed in the
 * address, which is the defect `use-launch-prompt` documents at length.
 *
 * **It never fakes one (spec R5).** Every fact is optional and omitted when
 * unknown, so a DorkBot session opened before the fleet or the config has
 * answered simply opens unseeded. That is a working Ask DorkBot, not an error.
 *
 * @module features/chat/model/launch/use-dorkbot-seed
 */
import { useCallback, useEffect, useRef } from 'react';
import { useShallow } from 'zustand/shallow';
import { takeAskDorkBotOrigin } from '@/layers/shared/lib';
import { useMeshAgentPaths } from '@/layers/entities/mesh';
import { useConfig } from '@/layers/entities/config';
import { useSessionListStore } from '@/layers/entities/session';
import { isNewer } from '@/layers/features/status';
import { buildDorkBotSeed, type DorkBotSeedFacts } from './build-dorkbot-seed';

/** The one value `?seed=` accepts — the sidebar's ✦ Ask DorkBot press. */
const DORKBOT_SEED_PARAM = 'dorkbot-help';

/** Sessions whose seed has been taken (or spent) this page session. */
const consumedSeeds = new Set<string>();

/**
 * Clear the seed latch.
 *
 * @internal Test-only: the set is module state deliberately, so a suite that
 * exercises two seeded sessions in a row has to reset it explicitly.
 */
export function __resetDorkBotSeedsForTest(): void {
  consumedSeeds.clear();
}

/** Inputs for {@link useDorkBotSeed}. */
export interface UseDorkBotSeedParams {
  /** The active session id, or null before one is resolved. */
  sessionId: string | null;
  /** The `?seed=` value from the route — anything but the literal is inert. */
  seed?: string;
  /** How many messages the conversation already has; a seed enters only an empty one. */
  messageCount: number;
  /**
   * Whether the durable stream's snapshot has landed. Until it does, "this
   * conversation is empty" is a loading state rather than a fact, so nothing is
   * spent on it.
   */
  hydrated: boolean;
  /** Called once the link is spent — the caller drops `seed` from the URL. */
  onConsumed?: () => void;
}

/**
 * Arm the Ask DorkBot seed for this session.
 *
 * @param params - The route's seed value and the conversation's state.
 * @returns A stable callback the send path calls on every turn. It answers with
 *   the seed on the first send of a seeded, empty conversation and with
 *   `undefined` every other time — which is what makes "first send only" a
 *   property of the code rather than of the caller.
 */
export function useDorkBotSeed({
  sessionId,
  seed,
  messageCount,
  hydrated,
  onConsumed,
}: UseDorkBotSeedParams): () => string | undefined {
  const armed = seed === DORKBOT_SEED_PARAM && sessionId !== null;

  // The fleet and the version. Both are queries the shell already observes, so
  // an extra observer here is a cache read rather than a fetch — and `enabled`
  // keeps even that idle on the overwhelming majority of sessions, which carry
  // no seed.
  const { data: mesh } = useMeshAgentPaths({ enabled: armed });
  const { data: config } = useConfig();
  // "Recent errors" as the fleet stream reports them, read off the store the
  // sidebar already keeps — not re-derived, and not a query, so arming a seed
  // costs a chat session nothing it was not already paying.
  const erroredSessionIds = useSessionListStore(
    useShallow((s) =>
      Object.entries(s.statuses)
        .filter(([, status]) => status.lifecycle === 'error')
        .map(([id]) => id)
    )
  );

  const factsRef = useRef<Omit<DorkBotSeedFacts, 'originPath'>>({
    agentNames: [],
    version: null,
    updateReady: false,
    erroredSessionIds: [],
  });
  const stateRef = useRef({ armed, sessionId, messageCount });
  const onConsumedRef = useRef(onConsumed);

  useEffect(() => {
    const latest = config?.latestVersion ?? null;
    const version = config?.version ?? null;
    factsRef.current = {
      agentNames: (mesh?.agents ?? []).map((agent) => agent.displayName ?? agent.name),
      version,
      updateReady: latest !== null && version !== null && isNewer(latest, version),
      erroredSessionIds,
    };
  }, [mesh, config, erroredSessionIds]);

  useEffect(() => {
    stateRef.current = { armed, sessionId, messageCount };
    onConsumedRef.current = onConsumed;
  }, [armed, sessionId, messageCount, onConsumed]);

  // Spend a seed that can never apply. A conversation with history is decided,
  // not waited on — leaving the param armed in the address is how a launch link
  // survives its own launch and lands on the next session that looks empty.
  useEffect(() => {
    if (!armed || sessionId === null || !hydrated || messageCount === 0) return;
    if (consumedSeeds.has(sessionId)) return;
    consumedSeeds.add(sessionId);
    onConsumed?.();
  }, [armed, sessionId, hydrated, messageCount, onConsumed]);

  return useCallback(() => {
    const state = stateRef.current;
    if (!state.armed || state.sessionId === null) return undefined;
    if (state.messageCount > 0) return undefined;
    if (consumedSeeds.has(state.sessionId)) return undefined;

    consumedSeeds.add(state.sessionId);
    // Spend the URL BEFORE the turn starts, for the reason the prompt link does:
    // the first message can re-key the session id and rewrite the address, and
    // that rewrite must not carry a live seed forward with it.
    onConsumedRef.current?.();
    // TAKEN, not read: the footer strip writes the origin on the way out, and
    // clearing it here means a later, unrelated seed cannot inherit a page
    // nobody was standing on.
    return buildDorkBotSeed({ ...factsRef.current, originPath: takeAskDorkBotOrigin() });
  }, []);
}
