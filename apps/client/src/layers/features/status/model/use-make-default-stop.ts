/**
 * "Start every new session in ⟨stop⟩?" — the decision behind the offer that
 * appears after a person moves the dial (spec `trust-dial`, decision 6C).
 *
 * The component that draws the line owns none of this, because none of it is
 * about drawing: whether an offer is warranted depends on what the effective
 * default already is (config, plus the runtime's own starting mode), on an
 * answer this session gave earlier. Every stop, Full autonomy included, is
 * written straight through: the consent ritual is retired (ADR 261006-225605).
 * The offer's few-second life is owned here too, for a reason the browser
 * showed: see {@link OFFER_MS}.
 *
 * @module features/status/model/use-make-default-stop
 */
import { useCallback, useEffect, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import type { PermissionModeDescriptor, PermissionStop } from '@dorkos/shared/agent-runtime';
import { useConfig, useUpdateConfig } from '@/layers/entities/config';
import { settingsForRuntime, useRuntimeCapabilities } from '@/layers/entities/runtime';
import { useHasDismissedDefaultStopOffer, useSessionChatStore } from '@/layers/entities/session';
import { isWorkingMode } from '@/layers/shared/lib';
import type { MakeDefaultStopLineProps } from '../ui/MakeDefaultStopLine';
import { configKeys } from '@/layers/entities/config';

/**
 * How long the offer stays before it withdraws itself, in ms.
 *
 * The timer lives HERE rather than in the component that draws the line, and
 * that is a fix rather than a preference. Driven from the component's mount, an
 * offer made while the line was not on screen never started its clock: the
 * popover the line lives in can close before the offer expires (observed in a
 * browser, 2026-08-01), and the offer then sat un-expired until somebody next
 * opened the popover — where it read as a fresh question about a change made
 * ten minutes ago. An offer's life belongs to the offer.
 */
const OFFER_MS = 6_000;

/** Turn a failed config write into one sentence a person can act on. */
function describeWriteFailure(err: unknown): string {
  return (err instanceof Error && err.message) || 'Couldn’t save that. Try again.';
}

/** What {@link useMakeDefaultStop} hands back. */
export interface MakeDefaultStop {
  /**
   * Props for the line, or `null` when nothing on this install could store the
   * answer. `stop` inside it is `null` whenever there is nothing to offer, which
   * is the resting state and the common one — most stop changes are a person
   * doing something once, not setting a habit.
   */
  line: MakeDefaultStopLineProps | null;
  /**
   * Tell the hook a person just picked a mode in this session AND the write
   * landed. Called with a runtime mode id; a mode that is a way of working, or
   * one whose stop is already the effective default, produces no offer.
   */
  offerFor: (mode: string) => void;
}

/**
 * Decide whether to offer "make this the default", and carry out the answer.
 *
 * The offer is withheld in three cases, and each is a different way of saying
 * the same thing — there is nothing here worth interrupting for:
 *
 * **It writes the leaf it compared.** Where this runtime carries an override,
 * the comparison was against THAT leaf, so accepting writes that leaf. Writing
 * the global one instead would leave the override in force: the person would
 * accept the offer, nothing about their sessions would change, and the same
 * question would come back on the next stop change, forever.
 *
 * @param opts.sessionId - The session whose dial was moved. A change withdraws
 *   any standing offer: it was made about that conversation, and the cockpit
 *   switches conversations without remounting anything (DOR-1237).
 * @param opts.runtime - The runtime this session is bound to, or nullish before
 *   it resolves (the server default answers for it, as everywhere else).
 * @param opts.declaredModes - That runtime's declared modes, in declared order.
 * @param opts.runtimeDefaultMode - The mode id this runtime starts sessions at.
 */
export function useMakeDefaultStop(opts: {
  sessionId: string;
  runtime: string | null | undefined;
  declaredModes: readonly PermissionModeDescriptor[];
  runtimeDefaultMode: string | undefined;
}): MakeDefaultStop {
  const { sessionId, runtime, declaredModes, runtimeDefaultMode } = opts;
  const { data: config } = useConfig();
  const { data: capabilityMap } = useRuntimeCapabilities();
  const updateConfig = useUpdateConfig();
  const queryClient = useQueryClient();
  const dismissed = useHasDismissedDefaultStopOffer(sessionId);
  const dismissOffer = useSessionChatStore((s) => s.dismissDefaultStopOffer);
  const [offeredStop, setOfferedStop] = useState<PermissionStop | null>(null);
  const [writeError, setWriteError] = useState<string | null>(null);

  // ## The offer belongs to the conversation it was made about (DOR-1237)
  //
  // The cockpit switches conversations by changing this prop — `ChatPanel` is
  // not keyed by session id — so nothing unmounts and every piece of state
  // below outlives the session that produced it. An offer left standing across
  // that switch is a question the person was never asked here, sitting one
  // click from a DURABLE write: accept it and `runtimes.<runtime>.defaultTrustStop`
  // moves to a stop chosen in a different conversation, on a runtime that may
  // not even be this one. That is the drift DOR-1237 recorded on a real install,
  // where the leaf went `autonomy` → `act` between two sign-offs.
  //
  // The dismissal was already session-scoped (`useHasDismissedDefaultStopOffer`),
  // which is the same rule stated for the "no" answer; this states it for the
  // offer itself. Adjusted during render on the change rather than in an effect
  // (React's "adjusting state when a prop changes"), so there is never a paint
  // in which the stale offer is on screen and clickable.
  const [offerSession, setOfferSession] = useState(sessionId);
  if (offerSession !== sessionId) {
    setOfferSession(sessionId);
    setOfferedStop(null);
    setWriteError(null);
  }

  const defaults = config?.executionDefaults;
  // A session that has not bound to a runtime yet is read against the server's
  // default runtime — the same fallback `useCapabilitiesForRuntime` applies to
  // the profile this hook is handed, so the override and the modes are always
  // read for one runtime rather than two.
  const forRuntime = runtime ?? defaults?.runtime;
  const override = defaults?.perRuntime.find((entry) => entry.runtime === forRuntime)?.trustStop;
  // Per runtime first, then the global one — the same precedence the server
  // resolves a new session with, so this comparison and that resolution can
  // never disagree about what "already the default" means.
  const configured = override ?? defaults?.trustStop ?? null;
  const runtimeDefaultStop = declaredModes.find((d) => d.id === runtimeDefaultMode)?.stop;
  const effectiveDefault = configured ?? runtimeDefaultStop;
  // Which leaf the comparison above was made against, and therefore the one
  // accepting the offer must write. `undefined` = the global leaf, which is
  // where a runtime that declares no config section lands: there is no
  // per-runtime key to write, and inventing one would write a leaf nothing
  // reads.
  //
  // A runtime the capability map has not answered for yet lands there too, but
  // only as a total function's last branch, never in practice: the offer is
  // gated on `declaredModes`, which comes from the same capability query, so
  // there is no state where the offer can fire while this lookup is still
  // empty. That matters because the fallback would be wrong if it were
  // reachable — writing the global leaf for a runtime carrying an override is
  // exactly the bug this hook exists to prevent (see above).
  const targetSection =
    override != null ? settingsForRuntime(capabilityMap, forRuntime)?.configSection : undefined;
  // Undefined while the config query is in flight: nothing can store the answer
  // yet, so nothing is offered.
  const canWrite = config !== undefined;

  // The offer's own clock, started by the offer rather than by whatever draws
  // it. No synchronous setState in this body — the withdrawal happens on the
  // timer, so there is nothing for React to cascade.
  useEffect(() => {
    if (!offeredStop) return;
    const timer = setTimeout(() => setOfferedStop(null), OFFER_MS);
    return () => clearTimeout(timer);
  }, [offeredStop]);

  const offerFor = useCallback(
    (mode: string) => {
      const descriptor = declaredModes.find((d) => d.id === mode);
      // A way of working is not a trust level, so it is not a default either.
      if (!descriptor || isWorkingMode(descriptor)) return;
      if (!canWrite || dismissed) return;
      if (descriptor.stop === effectiveDefault) return;
      setWriteError(null);
      setOfferedStop(descriptor.stop);
    },
    [declaredModes, canWrite, dismissed, effectiveDefault, setOfferedStop, setWriteError]
  );

  /**
   * Write the default to the leaf the comparison was made against.
   *
   * The offer SURVIVES a failure. A 403 (login came on) has to be sayable and
   * retryable; dropping the line would leave a person who pressed a button with
   * nothing changed and nothing said.
   */
  const onMakeDefault = useCallback(() => {
    if (!offeredStop) return;
    const stop = offeredStop;
    setWriteError(null);
    updateConfig.mutate(
      {
        runtimes: targetSection
          ? { [targetSection]: { defaultTrustStop: stop } }
          : { defaultTrustStop: stop },
      },
      {
        onSuccess: () => {
          void queryClient.invalidateQueries({ queryKey: configKeys.all });
          setOfferedStop(null);
        },
        onError: (err) => setWriteError(describeWriteFailure(err)),
      }
    );
  }, [offeredStop, updateConfig, queryClient, targetSection, setOfferedStop, setWriteError]);

  const onDismiss = useCallback(() => {
    dismissOffer(sessionId);
    setOfferedStop(null);
  }, [dismissOffer, sessionId, setOfferedStop]);

  return {
    line: canWrite
      ? {
          stop: offeredStop,
          onMakeDefault,
          onDismiss,
          pending: updateConfig.isPending,
          error: writeError,
        }
      : null,
    offerFor,
  };
}
