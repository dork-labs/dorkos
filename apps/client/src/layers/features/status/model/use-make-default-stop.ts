/**
 * "Start every new session in ⟨stop⟩?" — the decision behind the offer that
 * appears under the dial a person just moved (spec `trust-dial`, decision 6C).
 *
 * The component that draws the line owns none of this, because none of it is
 * about drawing: whether an offer is warranted depends on what the effective
 * default already is (config, plus the runtime's own starting mode), on an
 * answer this session gave earlier, and — when the stop is Full autonomy — on
 * whether this person has ever been told what that means.
 *
 * @module features/status/model/use-make-default-stop
 */
import { useCallback, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import type { PermissionModeDescriptor, PermissionStop } from '@dorkos/shared/agent-runtime';
import { useAutonomyAcknowledgement, useConfig, useUpdateConfig } from '@/layers/entities/config';
import { useHasDismissedDefaultStopOffer, useSessionChatStore } from '@/layers/entities/session';
import { isWorkingMode, resolveTrustStops } from '@/layers/shared/lib';
import type { MakeDefaultStopLineProps } from '../ui/MakeDefaultStopLine';

/** What {@link useMakeDefaultStop} hands back. */
export interface MakeDefaultStop {
  /**
   * Props for the line under the dial, or `null` when there is nothing to
   * offer. Null is the resting state and the common one — most stop changes are
   * a person doing something once, not setting a habit.
   */
  line: MakeDefaultStopLineProps | null;
  /**
   * Tell the hook a person just picked a mode in this session. Called with a
   * runtime mode id; a mode that is a way of working, or one whose stop is
   * already the effective default, produces no offer.
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
 * @param opts.sessionId - The session whose dial was moved.
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
  const updateConfig = useUpdateConfig();
  const queryClient = useQueryClient();
  const autonomyAck = useAutonomyAcknowledgement();
  const dismissed = useHasDismissedDefaultStopOffer(sessionId);
  const dismissOffer = useSessionChatStore((s) => s.dismissDefaultStopOffer);
  const [offeredStop, setOfferedStop] = useState<PermissionStop | null>(null);
  const [pendingDescriptor, setPendingDescriptor] = useState<PermissionModeDescriptor | null>(null);

  const defaults = config?.executionDefaults;
  // A session that has not bound to a runtime yet is read against the server's
  // default runtime — the same fallback `useCapabilitiesForRuntime` applies to
  // the profile this hook is handed, so the override and the modes are always
  // read for one runtime rather than two.
  const forRuntime = runtime ?? defaults?.runtime;
  // Per runtime first, then the global one — the same precedence the server
  // resolves a new session with, so this comparison and that resolution can
  // never disagree about what "already the default" means.
  const configured =
    defaults?.perRuntime.find((entry) => entry.runtime === forRuntime)?.trustStop ??
    defaults?.trustStop ??
    null;
  const runtimeDefaultStop = declaredModes.find((d) => d.id === runtimeDefaultMode)?.stop;
  const effectiveDefault = configured ?? runtimeDefaultStop;
  // `canRemember` answers exactly the question that matters here: does config
  // round-trip on this install at all. False in Obsidian.
  const canWrite = autonomyAck.canRemember;

  const offerFor = useCallback(
    (mode: string) => {
      const descriptor = declaredModes.find((d) => d.id === mode);
      // A way of working is not a trust level, so it is not a default either.
      if (!descriptor || isWorkingMode(descriptor)) return;
      if (!canWrite || dismissed) return;
      if (descriptor.stop === effectiveDefault) return;
      setOfferedStop(descriptor.stop);
    },
    [declaredModes, canWrite, dismissed, effectiveDefault, setOfferedStop]
  );

  /**
   * Write the global default, optionally recording the acknowledgement in the
   * SAME patch — the config route refuses a Full-autonomy default without one,
   * and two requests would race.
   */
  const persist = useCallback(
    (stop: PermissionStop, withAck: boolean) => {
      updateConfig.mutate(
        {
          ...(withAck ? { ui: { autonomyAcknowledgedAt: new Date().toISOString() } } : {}),
          runtimes: { defaultTrustStop: stop },
        },
        {
          onSuccess: () => {
            void queryClient.invalidateQueries({ queryKey: ['config'] });
          },
        }
      );
      setOfferedStop(null);
    },
    [updateConfig, queryClient, setOfferedStop]
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

  const onExpire = useCallback(() => setOfferedStop(null), [setOfferedStop]);

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
          onExpire,
          pending: updateConfig.isPending,
        }
      : null,
    offerFor,
    pendingDescriptor,
    confirm,
    cancel,
  };
}
