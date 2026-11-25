/**
 * The registry-level probes of the capability conformance suite: the tier gate
 * answers before any handler runs, and a person's decision is checked against
 * who asked. Split from `capability-conformance.ts` to keep it under the line
 * budget; both are re-exported from there.
 *
 * @module test-utils/capability-conformance-probes
 */
import * as invokeRefusal from './capability-invoke-refusal.js';
import type {
  ApprovalDecisionProbe,
  ApprovalDecisionProbeResult,
  ConformanceRegistry,
  ConformanceViolation,
} from './capability-conformance.js';

/**
 * Whether a payload is the tier gate's `approval_required` result: the status
 * discriminator, an approval id a person can decide, and retry instructions a
 * model can follow. Duck-typed so this suite stays free of a `@dorkos/server`
 * import.
 */
function isApprovalRequiredPayload(payload: unknown): boolean {
  if (!payload || typeof payload !== 'object') return false;
  const p = payload as Record<string, unknown>;
  return (
    p.status === 'approval_required' &&
    typeof p.approvalId === 'string' &&
    p.approvalId.length > 0 &&
    typeof p.approvalToken === 'string' &&
    p.approvalToken.length > 0 &&
    typeof p.message === 'string' &&
    typeof p.retry === 'object' &&
    p.retry !== null &&
    typeof (p.retry as Record<string, unknown>).instructions === 'string'
  );
}

/**
 * Prove that the tier gate is REACHED, for every `destructive` capability the
 * registry carries, by the only path any surface can use to run one.
 *
 * This replaced a hand-maintained list of adapter paths, each needing its own
 * probe (DOR-467). That list could only fail for a path already ON it, so the
 * surface that actually shipped ungated — the legacy marketplace routes — was
 * invisible to it: it was never added, so nothing was ever missing. The check is
 * now derived from the registry instead. Every capability the registry knows
 * about is driven through the registry's own `invoke`, with no trusted marker and
 * no approval, and a `destructive` one must come back refused.
 *
 * That covers every adapter at once, present and future, because the gate lives
 * INSIDE `invoke`: a new surface that reaches a capability inherits it, and a new
 * surface that does not reach a capability through `invoke` is caught by the
 * call-site scan in the server package instead (`__tests__/gate-bypass-scan.test.ts`),
 * which is the half a registry-shaped check cannot see.
 *
 * "No side effect" needs no separate probe here: a refusal is a REJECTION, so the
 * handler never ran. A gate that returned the right payload after doing the damage
 * would have to resolve, and would fail this check.
 *
 * @param registry - The composed registry under test.
 * @param sampleInputs - Per-capability sample input, keyed by capability id.
 * @param sampleContexts - Per-capability invocation context, keyed by capability id.
 * @returns Every violation found.
 */
export async function checkRegistryGateConformance(
  registry: ConformanceRegistry,
  sampleInputs: Record<string, unknown> = {},
  sampleContexts: Record<string, unknown> = {}
): Promise<ConformanceViolation[]> {
  const violations: ConformanceViolation[] = [];
  const add = (detail: string): void => void violations.push({ check: 'destructive-gate', detail });

  const destructive = registry.capabilities.filter((cap) => cap.tier === 'destructive');
  if (destructive.length === 0) {
    add(
      'the registry declares no `destructive` capability, so this check proves nothing — it is ' +
        'vacuously green and would stay green with the gate removed'
    );
  }

  for (const cap of destructive) {
    let refused = false;
    let thrown: unknown;
    try {
      const context = sampleContexts[cap.id];
      await (context === undefined
        ? registry.invoke(cap.id, sampleInputs[cap.id] ?? {})
        : registry.invoke(cap.id, sampleInputs[cap.id] ?? {}, context));
    } catch (err) {
      thrown = err;
      refused = true;
    }

    if (!refused) {
      add(
        `${cap.id}: registry.invoke RAN a destructive capability for an untrusted, unapproved ` +
          `caller — the tier gate is not inside invoke, so every surface that calls it is ungated`
      );
      continue;
    }
    if (!invokeRefusal.isGateRefusal(thrown)) {
      add(
        `${cap.id}: registry.invoke rejected, but not with a gate refusal — got ` +
          `${thrown instanceof Error ? `${thrown.name}: ${thrown.message}` : String(thrown)}`
      );
      continue;
    }
    if (!isApprovalRequiredPayload(thrown.decision.payload)) {
      add(
        `${cap.id}: the gate refused but its payload is not a structured approval_required ` +
          `(status, approvalId, approvalToken, message, retry.instructions), got ` +
          `${JSON.stringify(thrown.decision.payload)}`
      );
    }
  }

  return violations;
}

/**
 * Run the requester-cannot-decide probe and return all violations (empty means the
 * decide endpoint refused the requester and left the approval alone). Separated and
 * exported like the gate checker so a seeded bypass can be shown to FAIL it.
 *
 * @param probe - The probe, or `undefined` when the caller supplied none.
 * @returns Every violation found.
 */
export async function checkDecisionAuthorityConformance(
  probe: ApprovalDecisionProbe | undefined
): Promise<ConformanceViolation[]> {
  const violations: ConformanceViolation[] = [];
  const add = (detail: string): void =>
    void violations.push({ check: 'decision-authority', detail });

  if (!probe) {
    return [
      {
        check: 'decision-authority',
        detail:
          'no requesterDecideProbe supplied, so nothing proves the caller that asked for an ' +
          'approval cannot also grant it',
      },
    ];
  }

  let result: ApprovalDecisionProbeResult;
  try {
    result = await probe();
  } catch (err) {
    add(`probe threw instead of returning a decide outcome — ${String(err)}`);
    return violations;
  }

  if (result.status < 400) {
    add(
      `the decide endpoint answered ${result.status} to a caller presenting that approval's own ` +
        `retry token; a token holder must be refused, or it can approve its own destructive call`
    );
  }
  if (result.approvalDecided) {
    add(
      'the approval was DECIDED by the caller that requested it — the human half of the gate is optional'
    );
  }

  return violations;
}
