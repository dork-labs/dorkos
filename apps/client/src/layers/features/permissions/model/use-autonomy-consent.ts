/**
 * The Full autonomy consent step for a permission write (spec
 * `agent-permissions` D16): choosing Full power, or giving one agent a Full
 * autonomy Files & commands stop, needs the person to have read what it means.
 *
 * The same contract as `useTrustStopWrites` in Settings, re-created here because
 * a feature's model may not import another feature's: ask first when no
 * acknowledgement is on file, send the acknowledgement WITH the write (one
 * request, so the stop can never land without the consent that licenses it),
 * and treat a `428 AUTONOMY_ACK_REQUIRED` from the server as the same question
 * rather than a failure. The server is the gate; this is how a person answers
 * it.
 *
 * @module features/permissions/model/use-autonomy-consent
 */
import { useCallback, useState } from 'react';
import type { PermissionModeDescriptor } from '@dorkos/shared/agent-runtime';
import { useAutonomyAcknowledgement } from '@/layers/entities/config';
import { CANONICAL_TRUST_STOPS } from '@/layers/shared/ui';

/** A write that can carry the acknowledgement. */
export type ConsentingWrite = (acknowledgeAutonomy?: true) => void;

/** What {@link useAutonomyConsent} hands back. */
export interface AutonomyConsent {
  /**
   * Run a write, asking first when it reaches Full autonomy and nothing is on file.
   *
   * @param reachesAutonomy - Whether this write moves a stop to Full autonomy.
   * @param write - The write; called with `true` once the person said yes.
   */
  run: (reachesAutonomy: boolean, write: ConsentingWrite) => void;
  /** Ask now: the server refused a write for want of the acknowledgement. */
  ask: (write: ConsentingWrite) => void;
  /** The descriptor the consent dialog reads out, or `null` when nothing waits. */
  descriptor: PermissionModeDescriptor | null;
  /** The person read it and said yes: send the waiting write with the acknowledgement. */
  confirm: () => void;
  /** They said no. Nothing was written. */
  cancel: () => void;
}

/**
 * The canonical Full autonomy stop. A preset or an agent's stop is not one
 * runtime's mode, so the dialog reads the product's own promise for the stop.
 */
const AUTONOMY = CANONICAL_TRUST_STOPS.find((stop) => stop.stop === 'autonomy') ?? null;

/**
 * Put a permission write that reaches Full autonomy through the consent step.
 *
 * @returns The consent state and its handlers.
 */
export function useAutonomyConsent(): AutonomyConsent {
  const { acknowledgedAt } = useAutonomyAcknowledgement();
  const [waiting, setWaiting] = useState<ConsentingWrite | null>(null);

  const ask = useCallback((write: ConsentingWrite) => setWaiting(() => write), []);

  const run = useCallback(
    (reachesAutonomy: boolean, write: ConsentingWrite) => {
      if (reachesAutonomy && acknowledgedAt === null) ask(write);
      else write();
    },
    [acknowledgedAt, ask]
  );

  const confirm = useCallback(() => {
    const write = waiting;
    setWaiting(null);
    write?.(true);
  }, [waiting]);

  const cancel = useCallback(() => setWaiting(null), []);

  return { run, ask, descriptor: waiting ? AUTONOMY : null, confirm, cancel };
}
