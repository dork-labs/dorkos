/**
 * Proof that the conformance suite's directory-grants gate can FAIL (spec
 * `agent-home-desk` §4.6).
 *
 * The suite only ever runs against adapters that are supposed to pass, so a
 * green run is no evidence these rules fire. These drive the same two
 * evaluators the suite calls with what a wrong runtime would produce: no
 * declaration at all, a read grant handed as writable, and a grant that
 * survived into a turn that did not carry it.
 */
import { describe, expect, it } from 'vitest';
import {
  CONFORMANCE_GRANT_TURNS,
  evaluateDirectoryGrantsDeclaration,
  evaluateHandedGrants,
  type HandedGrants,
} from '../runtime-conformance.js';

const A = '/dorkos-conformance/grant-a';
const B = '/dorkos-conformance/grant-b';
const C = '/dorkos-conformance/grant-c';

function handed(overrides: Partial<HandedGrants> = {}): HandedGrants {
  return { writable: [], readOnly: [], readOpen: [], ...overrides };
}

describe('evaluateDirectoryGrantsDeclaration', () => {
  it('fails a runtime that declares neither a driver nor a reason', () => {
    expect(evaluateDirectoryGrantsDeclaration(false, undefined)).toMatch(
      /no `directoryGrantTurns`/
    );
    // Whitespace declares nothing.
    expect(evaluateDirectoryGrantsDeclaration(false, '   ')).toMatch(/no `directoryGrantTurns`/);
  });

  it('fails a runtime that wires the driver AND claims it cannot be proven', () => {
    expect(evaluateDirectoryGrantsDeclaration(true, 'no backend')).toMatch(/dead copy/);
  });

  it('passes exactly one of the two', () => {
    expect(evaluateDirectoryGrantsDeclaration(true, undefined)).toBeNull();
    expect(evaluateDirectoryGrantsDeclaration(false, 'test-mode has no backend')).toBeNull();
  });
});

describe('evaluateHandedGrants', () => {
  it('passes a runtime that hands each turn exactly its own set', () => {
    expect(
      evaluateHandedGrants(CONFORMANCE_GRANT_TURNS, [
        handed({ writable: [A], readOnly: [B] }),
        handed({ writable: [C] }),
      ])
    ).toEqual([]);
    // A sandbox that reads everywhere hands a read grant as read-open.
    expect(
      evaluateHandedGrants(CONFORMANCE_GRANT_TURNS, [
        handed({ writable: [A], readOpen: [B] }),
        handed({ writable: [C] }),
      ])
    ).toEqual([]);
  });

  it('fails a runtime whose grants from turn one survive into turn two', () => {
    const problems = evaluateHandedGrants(CONFORMANCE_GRANT_TURNS, [
      handed({ writable: [A], readOnly: [B] }),
      handed({ writable: [A, C], readOnly: [B] }),
    ]);
    expect(problems).toHaveLength(2);
    expect(problems.join('\n')).toMatch(/turn 2 still reached .*grant-a/);
    expect(problems.join('\n')).toMatch(/turn 2 still reached .*grant-b/);
  });

  it('fails a runtime that hands a read grant as writable', () => {
    expect(
      evaluateHandedGrants(CONFORMANCE_GRANT_TURNS, [
        handed({ writable: [A, B] }),
        handed({ writable: [C] }),
      ]).join('\n')
    ).toMatch(/READ grant .*grant-b was handed as writable/);
  });

  it('fails a runtime that hands a folder around a read grant as writable', () => {
    expect(
      evaluateHandedGrants(CONFORMANCE_GRANT_TURNS, [
        handed({ writable: [A, '/dorkos-conformance'], readOnly: [B] }),
        handed({ writable: [C] }),
      ]).join('\n')
    ).toMatch(/READ grant .*grant-b sits inside the writable folder \/dorkos-conformance/);
  });

  it('fails a runtime that drops a grant', () => {
    const problems = evaluateHandedGrants(CONFORMANCE_GRANT_TURNS, [
      handed({ writable: [A] }),
      handed(),
    ]);
    expect(problems.join('\n')).toMatch(/turn 1: read grant .*grant-b was not handed at all/);
    expect(problems.join('\n')).toMatch(/turn 2: write grant .*grant-c was not handed/);
  });
});
