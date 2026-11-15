/**
 * The safety-guard pairing rule can fail (DOR-3596): the conformance suite only
 * ever meets runtimes that are supposed to pass, so this file shows each way a
 * declaration and its proofs can disagree is caught.
 *
 * @module test-utils/__tests__/runtime-guard-conformance
 */
import { describe, expect, it } from 'vitest';
import type { RuntimeCapabilities } from '@dorkos/shared/agent-runtime';
import { guardDeclarationProblems } from '../runtime-guard-conformance.js';

const proof = () => undefined;

describe('guardDeclarationProblems', () => {
  it('accepts a runtime that declares nothing and proves nothing', () => {
    expect(guardDeclarationProblems({})).toEqual([]);
    expect(guardDeclarationProblems({ guards: { protectedPaths: false } })).toEqual([]);
  });

  it('accepts every declared guard paired with its proof', () => {
    expect(
      guardDeclarationProblems(
        { guards: { protectedPaths: true, ownFolder: true } },
        { protectedPaths: proof, ownFolder: proof }
      )
    ).toEqual([]);
  });

  it('fails a guard declared with no proof', () => {
    const problems = guardDeclarationProblems({ guards: { protectedPaths: true } });
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain('declares `protectedPaths` but');
  });

  it('fails a proof for a guard the runtime does not declare', () => {
    const problems = guardDeclarationProblems(
      { guards: { ownFolder: false } },
      { ownFolder: proof }
    );
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain('proves `ownFolder` but does not declare it');
  });

  it('fails a key DorkOS does not read, on either side', () => {
    const misspelt = { guards: { protectedPath: true } } as unknown as Pick<
      RuntimeCapabilities,
      'guards'
    >;
    expect(guardDeclarationProblems(misspelt)).toEqual([
      '`guards.protectedPath` is not a guard DorkOS reads, so it protects nothing',
    ]);
    expect(
      guardDeclarationProblems({}, { teammateTier: proof } as unknown as Record<string, () => void>)
    ).toEqual(['a proof was given for `teammateTier`, which is not a guard']);
  });
});
