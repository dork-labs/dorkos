/**
 * Runs the case files of flow's fleet conformance fixture whose functions live
 * in the server: the account list with each runtime's `default`
 * (`accounts.cases`), which ledger files a removed account leaves behind
 * (`prune.cases`) and the `flow-state.json` reader (`flow-run.cases`).
 *
 * The fixture is vendored in `@dorkos/shared` (`src/__fixtures__/flow-fleet-conformance/`),
 * whose own conformance suite runs the rest and fails when a case file has no
 * runner in either place.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { LEDGER_RUNTIMES } from '@dorkos/shared/account-usage';
import { parseFlowRunState } from '../../../session/fleet/flow-run-link.js';
import { pruneTargets, resolveRuntimeAccounts } from '../runtime-accounts.js';

const FIXTURE_DIR = path.resolve(
  import.meta.dirname,
  '../../../../../../../packages/shared/src/__fixtures__/flow-fleet-conformance'
);

/** One case: `{ name, input, expected }`. */
interface Case {
  name: string;
  input: Record<string, unknown>;
  expected: Record<string, unknown>;
}

function load(name: string): Case[] {
  return (JSON.parse(readFileSync(path.join(FIXTURE_DIR, name), 'utf8')) as { cases: Case[] })
    .cases;
}

const RUNNERS: Record<string, (c: Case) => void> = {
  'accounts.cases.json': ({ input, expected }) => {
    // input.env is never passed: `default` resolves from config and the OS
    // home only (contract rev 6d), and the cases that set it prove so.
    const realpaths = input.realpath as Record<string, string>;
    const inputs = {
      config: input.config,
      home: input.home as string,
      realpath: (dir: string) => (Object.hasOwn(realpaths, dir) ? realpaths[dir]! : null),
    };
    const accounts = [];
    const warnings: string[] = [];
    for (const runtime of LEDGER_RUNTIMES) {
      const result = resolveRuntimeAccounts(runtime, inputs);
      warnings.push(...result.warnings.map((w) => w.code));
      for (const a of result.accounts) {
        accounts.push({
          runtime: a.runtime,
          id: a.id,
          key: `${a.runtime}:${a.id}`,
          implicit: a.implicit,
          isDefault: a.isDefault,
          path: a.path,
          canonicalPath: a.canonicalPath,
          label: a.label,
          color: a.storedColor,
          routable: a.routable,
          ledgerId: a.ledgerId,
        });
      }
    }
    expect(accounts).toEqual(expected.accounts);
    expect(warnings.sort()).toEqual([...(expected.warnings as string[])].sort());
  },

  'prune.cases.json': ({ input, expected }) => {
    expect(
      pruneTargets(
        input.registered as Record<string, string[]>,
        input.onDisk as Record<string, string[]>
      )
    ).toEqual(expected.remove);
  },

  'flow-run.cases.json': ({ input, expected }) => {
    const read = (state: unknown) => parseFlowRunState(JSON.stringify(state)) ?? {};
    expect(parseFlowRunState(JSON.stringify(input.state)) !== null).toBe(expected.valid);
    if (input.write === undefined) {
      expect(read(input.state)).toEqual(expected.readBack);
      return;
    }
    // DorkOS only reads flow-state.json; flow is its one writer. What a write
    // case pins for a reader is that the file before and after reads back
    // unchanged, unknown fields included.
    expect(read(input.state)).toEqual(input.state);
    expect(read(expected.readBack)).toEqual(expected.readBack);
  },
};

describe('the flow fleet conformance fixture (server)', () => {
  for (const [file, runner] of Object.entries(RUNNERS)) {
    describe(file, () => {
      for (const c of load(file)) {
        // Purpose: one contract case; see the file's `about` for the rule.
        it(c.name, () => runner(c));
      }
    });
  }
});
