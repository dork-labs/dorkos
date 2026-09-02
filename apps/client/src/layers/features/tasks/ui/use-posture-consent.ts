/**
 * The one consent door on the task form, and the rule that decides when it
 * opens.
 *
 * A scheduled run has nobody to ask, so a posture that never asks is something a
 * person has to agree to rather than arrive at (spec `trust-dial`, decision 5,
 * widened 2026-08-01 by DOR-816). THREE choices on this form reach that posture,
 * and only one of them is the Permissions control:
 *
 * - picking a stop on the dial;
 * - picking a runtime, which hands an unchanged mode id to a runtime that reads
 *   it as never-asking (DOR-1615);
 * - picking an agent, which moves the runtime the task inherits the same way
 *   (DOR-1637).
 *
 * All three are answered here because a gate on one path is not a gate, and
 * three copies of one rule is how they come to disagree.
 *
 * @module features/tasks/ui/use-posture-consent
 */
import { useState } from 'react';
import { useRuntimeCapabilities } from '@/layers/entities/runtime';
import { needsConsentRitual } from '@/layers/shared/lib';
import type { PermissionModeDescriptor } from '@dorkos/shared/agent-runtime';
import type { PermissionMode } from '@dorkos/shared/types';

/**
 * A change waiting at the door: the mode being consented to, and what to write
 * once somebody says yes.
 *
 * Three different choices open this one door, so what gets applied cannot be
 * inferred from the descriptor. Each caller supplies it.
 */
interface PendingConsent {
  /** The mode as the runtime that will run it declared it. */
  descriptor: PermissionModeDescriptor;
  /** Write the change the person just confirmed. */
  apply: () => void;
}

/** What {@link usePostureConsent} is asked about. */
export interface PostureConsentInput {
  /** The mode the task holds right now, whatever a runtime makes of it. */
  permissionMode: PermissionMode;
  /**
   * The runtime this task's next run resolves to — its own choice, else its
   * agent's, else the server default — or `null` while nothing has answered.
   */
  effectiveRuntime: string | null;
}

/** The task form's consent door, and the two guards that open it. */
export interface PostureConsent {
  /**
   * The modes the effective runtime declares, in its own vocabulary — empty for
   * a runtime this machine has never heard of.
   */
  descriptors: readonly PermissionModeDescriptor[];
  /** The mode waiting at the door, or `null` while the door is shut. */
  pendingDescriptor: PermissionModeDescriptor | null;
  /**
   * Make a change of runtime, or hold it at the door when the runtime it lands
   * on would read the task's mode as never-asking.
   *
   * @param nextRuntime - The runtime this task would ACTUALLY run on afterwards.
   * @param apply - Writes the change, once it is allowed to happen.
   */
  guardRuntime: (nextRuntime: string | null, apply: () => void) => void;
  /**
   * Make a change of mode, or hold it at the door when the mode itself never
   * asks.
   *
   * @param descriptor - The mode being picked, or `undefined` for one this
   *   runtime never declared.
   * @param apply - Writes the change, once it is allowed to happen.
   */
  guardMode: (descriptor: PermissionModeDescriptor | undefined, apply: () => void) => void;
  /** Close the door without applying what it held. */
  dismiss: () => void;
  /** Apply what the door held, and close it. */
  confirm: () => void;
}

/**
 * Hold every widening on the task form behind one door.
 *
 * Nothing is written while the door is open, and dismissing writes nothing
 * either: every control on this form is driven by its own form field, so a
 * change that was never applied leaves the control exactly where it was and
 * there is no revert to perform.
 *
 * @param input - The mode the task holds and the runtime it will run on; see
 *   {@link PostureConsentInput}.
 */
export function usePostureConsent(input: PostureConsentInput): PostureConsent {
  const { permissionMode, effectiveRuntime } = input;
  const [pending, setPending] = useState<PendingConsent | null>(null);

  // The whole capability map rather than one runtime's slice: the guards below
  // ask the same question about a runtime nobody has chosen yet, and two lookups
  // that could disagree is how one door ends up open and the other shut.
  const { data: capabilityMap } = useRuntimeCapabilities();

  /**
   * The modes a runtime declares — none for one this machine has never heard of.
   *
   * Every `?.` down to the LAST link, which is not stylistic. A task's `runtime`
   * is any non-empty string (`UpdateTaskRequestSchema`), so it can be
   * `constructor` or `toString` — and `capabilities['constructor']` answers with
   * `Object`, an inherited member that is truthy and has no `permissionModes`.
   * The optional chain that stopped one link short read `.values` off `undefined`
   * and took the whole edit form down. Same rule `settingsForRuntime` follows.
   */
  const modesFor = (runtimeType: string | null): readonly PermissionModeDescriptor[] =>
    (runtimeType ? capabilityMap?.capabilities[runtimeType]?.permissionModes?.values : undefined) ??
    [];
  const descriptors = modesFor(effectiveRuntime);

  /**
   * Whether moving this task to `nextRuntime` would turn its stored mode into
   * one that never stops to ask.
   *
   * A mode id means whatever the runtime running it says it means, and the two
   * shipped meanings of `acceptEdits` are the live case: on Claude Code it asks
   * before a command, on Codex it cannot ask at all. Carrying the id across the
   * change is right — the alternative is silently rewriting somebody's setting —
   * so the CHANGE is what gets gated, by the same `needsConsentRitual` the dial
   * and the server's own door apply.
   *
   * Only a NEW never-asking posture opens the door. Somebody already sitting at
   * one has walked through it, and asking again on every runtime change would
   * make the question furniture. A mode the OLD runtime never declared counts as
   * new: nobody agreed to a posture that had no meaning a moment ago.
   */
  const widensToNeverAsking = (nextRuntime: string | null): PermissionModeDescriptor | null => {
    const next = modesFor(nextRuntime).find((d) => d.id === permissionMode);
    if (!next || !needsConsentRitual(next)) return null;
    const before = descriptors.find((d) => d.id === permissionMode);
    return before && needsConsentRitual(before) ? null : next;
  };

  return {
    descriptors,
    pendingDescriptor: pending?.descriptor ?? null,
    guardRuntime: (nextRuntime, apply) => {
      const widening = widensToNeverAsking(nextRuntime);
      if (widening) {
        setPending({ descriptor: widening, apply });
        return;
      }
      apply();
    },
    // The rule is `needsConsentRitual` — the server's own — not a stop
    // comparison, so a runtime that files a never-asking mode at the MIDDLE stop
    // is caught here too (DOR-816).
    guardMode: (descriptor, apply) => {
      if (descriptor && needsConsentRitual(descriptor)) {
        setPending({ descriptor, apply });
        return;
      }
      apply();
    },
    dismiss: () => setPending(null),
    confirm: () => {
      pending?.apply();
      setPending(null);
    },
  };
}
