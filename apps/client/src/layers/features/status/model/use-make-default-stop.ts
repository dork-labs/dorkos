/**
 * "Start every new session in ⟨stop⟩?" — the decision behind the offer that
 * appears after a person moves the dial (spec `trust-dial`, decision 6C).
 *
 * The component that draws the line owns none of this, because none of it is
 * about drawing: whether an offer is warranted depends on what the effective
 * default already is (config, plus the runtime's own starting mode), on an
 * answer this session gave earlier, and — when the stop is Full autonomy — on
 * whether this person has ever been told what that means. The offer's few-second
 * life is owned here too, for a reason the browser showed: see {@link OFFER_MS}.
 *
 * ## Why this one still gates on the stop
 *
 * The session dial gates on `needsConsentRitual`, which is wider than the
 * autonomy position (DOR-816). This hook does not, and that is not an oversight:
 * what it writes is `defaultTrustStop`, a runtime-NEUTRAL stop resolved through
 * each runtime's own profile when a session is born. Only `'autonomy'` can mean
 * "does not ask" there — the same middle stop asks on one runtime and cannot on
 * another, so there is no never-asking value to gate. The per-runtime
 * consequence of the chosen stop is disclosed by Settings' living caption
 * instead (spec `trust-dial`, decisions 2A and 6).
 *
 * @module features/status/model/use-make-default-stop
 */
import { useCallback, useEffect, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import type { PermissionModeDescriptor, PermissionStop } from '@dorkos/shared/agent-runtime';
import { useAutonomyAcknowledgement, useConfig, useUpdateConfig } from '@/layers/entities/config';
import { settingsForRuntime, useRuntimeCapabilities } from '@/layers/entities/runtime';
import { useHasDismissedDefaultStopOffer, useSessionChatStore } from '@/layers/entities/session';
import { isWorkingMode, resolveTrustStops } from '@/layers/shared/lib';
import type { MakeDefaultStopLineProps } from '../ui/MakeDefaultStopLine';

/**
 * How long the offer stays before it withdraws itself, in ms.
 *
 * The timer lives HERE rather than in the component that draws the line, and
 * that is a fix rather than a preference. Driven from the component's mount, an
 * offer made while the line was not on screen never started its clock: the
 * Full-autonomy path opens a modal dialog, the dialog's focus grab closes the
 * dial popover the line used to live in (observed in a browser, 2026-08-01), and
 * the offer then sat un-expired until somebody next opened the popover — where
 * it read as a fresh question about a change made ten minutes ago. An offer's
 * life belongs to the offer.
 */
const OFFER_MS = 6_000;

/** Turn a failed config write into one sentence a person can act on. */
function describeWriteFailure(err: unknown): string {
  return (err instanceof Error && err.message) || 'Could not save that. Try again.';
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
  /**
   * The mode the consent dialog should describe while a Full-autonomy default
   * waits on it, or `null`. The dialog is rendered by the caller, beside the
   * one it already renders for the session's own autonomy door — a different
   * question, asked about a different scope.
   */
  pendingDescriptor: PermissionModeDescriptor | null;
  /** The person confirmed: record the consent and write the default, in one patch. */
  confirm: () => void;
  /** The person backed out; the session keeps the stop they chose. */
  cancel: () => void;
}

/**
 * Decide whether to offer "make this the default", and carry out the answer.
 *
 * The offer is withheld in three cases, and each is a different way of saying
 * the same thing — there is nothing here worth interrupting for:
 *
 * 1. **It already is the default.** Compared against the EFFECTIVE default —
 *    the configured stop where there is one, otherwise the stop this runtime's
 *    own starting mode sits at — so a fresh install offering "make Ask first
 *    the default" (which it already is) never happens.
 * 2. **This session said no.** Remembered per session and swept with it.
 * 3. **Nothing could store the answer.** Obsidian's in-process transport has no
 *    config behind it, and an offer that saves nothing is worse than no offer.
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
  const autonomyAck = useAutonomyAcknowledgement();
  const dismissed = useHasDismissedDefaultStopOffer(sessionId);
  const dismissOffer = useSessionChatStore((s) => s.dismissDefaultStopOffer);
  const [offeredStop, setOfferedStop] = useState<PermissionStop | null>(null);
  const [pendingDescriptor, setPendingDescriptor] = useState<PermissionModeDescriptor | null>(null);
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
  // — the same idiom `AutonomyConfirmDialog` uses to reset its checkbox — so
  // there is never a paint in which the stale offer is on screen and clickable.
  const [offerSession, setOfferSession] = useState(sessionId);
  if (offerSession !== sessionId) {
    setOfferSession(sessionId);
    setOfferedStop(null);
    setPendingDescriptor(null);
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
  // `canRemember` answers exactly the question that matters here: does config
  // round-trip on this install at all. False in Obsidian.
  const canWrite = autonomyAck.canRemember;

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
   * Write the default, optionally recording the acknowledgement in the SAME
   * patch — the config route refuses a Full-autonomy default without one, and
   * two requests would race.
   *
   * The offer SURVIVES a failure. A 428 (another tab pressed Reset between the
   * read and the write) or a 403 (login came on) has to be sayable and
   * retryable; dropping the line would leave a person who pressed a button with
   * nothing changed and nothing said.
   */
  const persist = useCallback(
    (stop: PermissionStop, withAck: boolean) => {
      setWriteError(null);
      updateConfig.mutate(
        {
          ...(withAck ? { ui: { autonomyAcknowledgedAt: new Date().toISOString() } } : {}),
          runtimes: targetSection
            ? { [targetSection]: { defaultTrustStop: stop } }
            : { defaultTrustStop: stop },
        },
        {
          onSuccess: () => {
            void queryClient.invalidateQueries({ queryKey: ['config'] });
            setOfferedStop(null);
          },
          onError: (err) => setWriteError(describeWriteFailure(err)),
        }
      );
    },
    [updateConfig, queryClient, targetSection, setOfferedStop, setWriteError]
  );

  const onMakeDefault = useCallback(() => {
    if (!offeredStop) return;
    if (offeredStop === 'autonomy' && autonomyAck.acknowledgedAt === null) {
      // Set-time is consent-time, here too. The person may have confirmed
      // autonomy for THIS session a moment ago, but that answer was about one
      // conversation; making it the standing default is the wider claim, and it
      // is the one the server requires a durable record for.
      const descriptor = resolveTrustStops(declaredModes).find((s) => s.stop === 'autonomy')?.mode;
      if (descriptor) {
        setPendingDescriptor(descriptor);
        return;
      }
    }
    persist(offeredStop, false);
  }, [offeredStop, autonomyAck.acknowledgedAt, declaredModes, persist, setPendingDescriptor]);

  const onDismiss = useCallback(() => {
    dismissOffer(sessionId);
    setOfferedStop(null);
  }, [dismissOffer, sessionId, setOfferedStop]);

  const confirm = useCallback(() => {
    setPendingDescriptor(null);
    persist('autonomy', true);
  }, [persist, setPendingDescriptor]);

  const cancel = useCallback(() => {
    setPendingDescriptor(null);
    setOfferedStop(null);
  }, [setPendingDescriptor, setOfferedStop]);

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
    pendingDescriptor,
    confirm,
    cancel,
  };
}
