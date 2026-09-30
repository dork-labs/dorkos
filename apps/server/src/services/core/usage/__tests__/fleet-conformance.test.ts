/**
 * Runs the case files of flow's fleet conformance fixture whose functions live
 * in the server: the account list with each runtime's `default`
 * (`accounts.cases`), which ledger files a removed account leaves behind
 * (`prune.cases`), the `flow-state.json` reader (`flow-run.cases`) and which
 * accounts may work in which projects (`project-eligibility.cases`, 4.2.0).
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
import { judgeEligibility, readEligibilityRules } from '../account-eligibility.js';

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

  'project-eligibility.cases.json': ({ input, expected }) => {
    // The canonical spelling the contract compares roots by: no trailing
    // slash, then the case's real paths (a folder absent from them is real).
    const realpaths = (input.realpath ?? {}) as Record<string, string>;
    const canonical = (dir: string) => {
      const trimmed = dir.length > 1 ? dir.replace(/\/+$/, '') : dir;
      return Object.hasOwn(realpaths, trimmed) ? realpaths[trimmed]! : trimmed;
    };
    // The project is the main checkout git reports for the folder, as
    // `resolveProjectRoot` asks it; a folder git does not know is no project.
    const git = input.git as Record<string, string>;
    const folder = input.folder as string | null;
    const root = folder !== null && Object.hasOwn(git, folder) ? canonical(git[folder]!) : null;
    const config = input.config as { runtimes: { claudeCode: unknown } };
    const verdict = judgeEligibility(
      readEligibilityRules(config.runtimes.claudeCode, canonical),
      input.account as string,
      root
    );
    expect(
      verdict.eligible ? { eligible: true } : { eligible: false, reason: verdict.reason }
    ).toEqual(expected);
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
    // Contract 4.1.0: a writer stamps `updatedAt` with its own clock
    // (`input.now`) on the record it writes, and only there, so a reader sees
    // that time as the record's last update and every other record's own.
    if (input.now !== undefined && expected.valid === true) {
      const written = (input.write as { issueId: string }).issueId;
      const before = input.state as Record<string, { updatedAt?: unknown }>;
      const after = read(expected.readBack) as Record<string, { updatedAt?: unknown }>;
      expect(after[written]?.updatedAt).toBe(input.now);
      for (const [issueId, record] of Object.entries(before)) {
        if (issueId !== written) expect(after[issueId]?.updatedAt).toBe(record.updatedAt);
      }
    }
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
