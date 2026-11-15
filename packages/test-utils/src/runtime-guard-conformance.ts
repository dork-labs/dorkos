/**
 * The safety-guard half of the runtime conformance suite (DOR-3596): a guard a
 * runtime declares in `RuntimeCapabilities.guards` is one it really enforces.
 *
 * A guard is enforced in each runtime's own way (deny rules in Claude Code's
 * settings, a refusal in another runtime's approval step), so the suite cannot
 * drive one generically. Each runtime hands in a proof per guard instead: a
 * function that runs its own enforcement against a protected path and throws
 * when the guard does not hold. The rule this file holds every runtime to is
 * the pairing, both ways:
 *
 * - a declared guard with no proof fails, so no runtime can claim a guard by
 *   flipping a flag;
 * - a proof for a guard the runtime does not declare fails too, so a runtime
 *   that gains a guard has to say so, and DorkOS starts relying on it.
 *
 * Kept apart from `runtime-conformance.ts` and exported so the suite and its
 * proof of failure (`__tests__/runtime-guard-conformance.test.ts`) run the
 * SAME rule.
 *
 * @module test-utils/runtime-guard-conformance
 */
import { describe, expect, it } from 'vitest';
import {
  RUNTIME_GUARDS,
  declaresGuard,
  type AgentRuntime,
  type RuntimeCapabilities,
  type RuntimeGuard,
} from '@dorkos/shared/agent-runtime';

/**
 * One proof per guard a runtime declares. A proof runs the runtime's own
 * enforcement and throws (an `expect` is enough) when the guard does not hold.
 * It must be able to fail: check a protected path is refused AND that an
 * ordinary one is not, so a rule that refused everything would not pass either.
 */
export type RuntimeGuardProofs = Readonly<
  Partial<Record<RuntimeGuard, () => void | Promise<void>>>
>;

/**
 * What is wrong with how a runtime pairs its declared guards with its proofs,
 * one sentence per problem; empty when every declared guard has a proof and
 * every proof is for a declared guard.
 *
 * @param capabilities - The runtime's declared capabilities.
 * @param proofs - The proofs its conformance run handed in.
 */
export function guardDeclarationProblems(
  capabilities: Pick<RuntimeCapabilities, 'guards'>,
  proofs: RuntimeGuardProofs = {}
): string[] {
  const problems: string[] = [];
  const known: readonly string[] = RUNTIME_GUARDS;
  for (const key of Object.keys(capabilities.guards ?? {})) {
    if (!known.includes(key)) {
      problems.push(`\`guards.${key}\` is not a guard DorkOS reads, so it protects nothing`);
    }
  }
  for (const key of Object.keys(proofs)) {
    if (!known.includes(key))
      problems.push(`a proof was given for \`${key}\`, which is not a guard`);
  }
  for (const guard of RUNTIME_GUARDS) {
    const declared = declaresGuard(capabilities, guard);
    const proved = typeof proofs[guard] === 'function';
    if (declared && !proved) {
      problems.push(
        `declares \`${guard}\` but its conformance run hands in no proof that it holds (see RuntimeGuardProofs)`
      );
    }
    if (!declared && proved) {
      problems.push(
        `proves \`${guard}\` but does not declare it, so DorkOS treats the runtime as not having it`
      );
    }
  }
  return problems;
}

/**
 * Register the safety-guard cases for one runtime. Every runtime's
 * `conformance.test.ts` calls it beside `runtimeConformance`, a runtime that
 * declares no guard included, and the runtime capabilities census fails one
 * that does not.
 *
 * @param makeRuntime - Factory producing a fresh runtime.
 * @param proofs - One proof per guard the runtime declares.
 */
export function runtimeGuardConformance(
  makeRuntime: () => AgentRuntime,
  proofs: RuntimeGuardProofs = {}
): void {
  describe('safety guards', () => {
    it('every guard it declares comes with a proof, and every proof with a declaration', () => {
      expect(guardDeclarationProblems(makeRuntime().getCapabilities(), proofs)).toEqual([]);
    });

    for (const guard of RUNTIME_GUARDS) {
      const proof = proofs[guard];
      if (!proof) continue;
      it(`the declared \`${guard}\` guard holds`, async () => {
        expect(declaresGuard(makeRuntime().getCapabilities(), guard)).toBe(true);
        await proof();
      });
    }
  });
}
