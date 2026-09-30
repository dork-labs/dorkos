/**
 * Runs flow's fleet conformance fixture against DorkOS's own implementation.
 *
 * The fixture (`__fixtures__/flow-fleet-conformance/`, vendored from
 * `dork-labs/marketplace` at the commit its `SOURCE.json` names) is the shared
 * contract for accounts and usage ledgers (marketplace `specs/flow-cli-core`
 * §1.4). flow proves its side in its own repo; this suite proves DorkOS's side
 * against the same cases. The case files whose functions live in the server
 * (accounts, prune, flow-run) run in
 * `apps/server/src/services/core/usage/__tests__/fleet-conformance.test.ts`.
 *
 * Warnings compare as sorted lists of codes: the codes are the contract, their
 * order and message text are not.
 */
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { Ajv } from 'ajv';
import { describe, expect, it } from 'vitest';
import {
  IMPLICIT_ACCOUNT_ID,
  ACCOUNT_ID_PATTERN,
  UsageLedgerSchema,
  WINDOW_KEY_PATTERN,
  codexObservations,
  mergeLedger,
  readWindow,
  toAccountUsage,
  type LedgerRuntime,
  type UsageLedger,
} from '../account-usage.js';
import { claudeAccountId, readClaudeAccountSettings } from '../config-schema.js';

const FIXTURE_DIR = path.resolve(
  import.meta.dirname,
  '..',
  '__fixtures__',
  'flow-fleet-conformance'
);

/** The contract majors this repo implements. A re-sync to another major must fail here first. */
const ADOPTED_MAJOR = 4;

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

function codes(warnings: readonly { code: string }[]): string[] {
  return warnings.map((w) => w.code).sort();
}

function expectedCodes(expected: unknown): string[] {
  return [...(expected as string[])].sort();
}

/** `config.json`'s `runtimes` key for each runtime. */
const CONFIG_KEYS: Record<LedgerRuntime, string> = {
  'claude-code': 'claudeCode',
  codex: 'codex',
  opencode: 'opencode',
};

/**
 * Which eligibility cases map onto {@link toAccountUsage}. flow's
 * `accountRoom` is a routing decision (the weekly reserve, a ceiling at 100%
 * with no status, model buckets left out); DorkOS's account state is what the
 * app shows. They agree on spend, local models, error signals and unknown
 * accounts, which is what DorkOS must get right. These three pin flow's
 * routing rules only, so they are skipped by name.
 */
const ELIGIBILITY_FLOW_ONLY = new Set([
  // The reserve is flow's routing policy; DorkOS has none.
  'the weekly window counts the reserve',
  // A window at 100% with no status reads as a warning in the app, not a limit.
  'a Codex window:<minutes> at 100 has no room',
  // The app shows a model bucket as a window; flow's room ignores it.
  'only model buckets is unknown',
]);

/** The runner for each case file this suite runs, by file name. */
const RUNNERS: Record<string, (c: Case) => void> = {
  'account-id.cases.json': ({ input, expected }) => {
    expect(
      claudeAccountId({
        label: input.label as string | null,
        path: input.path as string,
        taken: input.taken as string[],
      })
    ).toBe(expected.id);
  },

  'identity.cases.json': ({ input, expected }) => {
    const runtimes = (input.config as { runtimes?: Record<string, unknown> } | null)?.runtimes;
    const block = runtimes?.[CONFIG_KEYS[input.runtime as LedgerRuntime]];
    const result = readClaudeAccountSettings(block);
    expect(
      result.accounts.map((a) => ({
        id: a.id,
        path: a.path,
        label: a.label,
        color: a.colorIsDefault ? null : a.color,
        routable: a.id !== IMPLICIT_ACCOUNT_ID && ACCOUNT_ID_PATTERN.test(a.id),
      }))
    ).toEqual(expected.accounts);
    expect(codes(result.warnings)).toEqual(expectedCodes(expected.warnings));
  },

  'window-read.cases.json': ({ input, expected }) => {
    expect(readWindow(input.entry, new Date(input.now as string), input.key as string)).toEqual(
      expected.reading
    );
  },

  'ledger-merge.cases.json': ({ input, expected }) => {
    const result = mergeLedger(
      input.existing,
      input.observations as never[],
      new Date(input.now as string),
      { runtime: input.runtime as LedgerRuntime, accountId: input.accountId as string }
    );
    expect(result.changed).toBe(expected.changed);
    expect(result.ledger).toEqual(expected.ledger);
    expect(codes(result.warnings)).toEqual(expectedCodes(expected.warnings));
  },

  'codex-rate-limits.cases.json': ({ input, expected }) => {
    expect(codexObservations(input.rateLimits, input.observedAt as string, 'rollout')).toEqual(
      expected.observations
    );
  },

  'eligibility.cases.json': ({ name, input, expected }) => {
    const usage = toAccountUsage(
      (input.ledger as UsageLedger | null) ?? null,
      {
        runtime: input.runtime as LedgerRuntime,
        accountId: 'a',
        path: '/account',
        label: null,
        color: '#000000',
      },
      new Date(input.now as string)
    );
    const room = usage.state === 'unknown' ? null : usage.state !== 'limited';
    expect(room).toBe(expected.room);
    if (expected.spendRoom === false) expect(usage.limit?.window).toBe('spend');
    if (expected.spendRoom === true) {
      expect(usage.spend).not.toBeNull();
      expect(usage.limit?.window).not.toBe('spend');
    }
    if (expected.spendRoom === null) expect(usage.spend).toBeNull();
  },
};

/** Case files the server's conformance suite runs (their functions live there). */
const RUN_IN_SERVER = [
  'accounts.cases.json',
  'flow-run.cases.json',
  'project-eligibility.cases.json',
  'prune.cases.json',
];

/**
 * Case files that pin flow's own rules, which DorkOS does not implement:
 * routing policy (`fleet.json`) and the per-account room flow routes by.
 */
const FLOW_ONLY = ['fleet-policy.cases.json', 'room.cases.json'];

const caseFiles = readdirSync(FIXTURE_DIR)
  .filter((name) => name.endsWith('.cases.json'))
  .sort();

describe('the flow fleet conformance fixture', () => {
  // Purpose: a re-sync to a contract major this repo has not adopted fails
  // here with a clear message, not as a scatter of case failures.
  it(`is a contract version this repo implements (major ${ADOPTED_MAJOR})`, () => {
    const version = readFileSync(path.join(FIXTURE_DIR, 'CONTRACT_VERSION'), 'utf8').trim();
    const source = JSON.parse(readFileSync(path.join(FIXTURE_DIR, 'SOURCE.json'), 'utf8')) as {
      contractVersion: string;
    };
    expect(source.contractVersion, 'SOURCE.json disagrees with CONTRACT_VERSION').toBe(version);
    expect(
      Number(version.split('.')[0]),
      `The vendored fixture is contract ${version}; DorkOS implements major ${ADOPTED_MAJOR}. Adopt the new contract (spec claude-account-fleet §11) before re-syncing.`
    ).toBe(ADOPTED_MAJOR);
  });

  // Purpose: every case file is run somewhere or skipped by name, so a case
  // file a later contract adds cannot pass by never running.
  it('has a runner or a named skip for every case file', () => {
    expect(caseFiles).toEqual([...Object.keys(RUNNERS), ...RUN_IN_SERVER, ...FLOW_ONLY].sort());
  });

  for (const [file, runner] of Object.entries(RUNNERS)) {
    describe(file, () => {
      for (const c of load(file)) {
        // Purpose: one contract case; see the file's `about` for the rule.
        // The eligibility cases that pin flow's routing only are reported skipped.
        const skipped = file === 'eligibility.cases.json' && ELIGIBILITY_FLOW_ONLY.has(c.name);
        (skipped ? it.skip : it)(c.name, () => runner(c));
      }
    });
  }

  it('skips only eligibility cases that exist', () => {
    const names = new Set(load('eligibility.cases.json').map((c) => c.name));
    for (const name of ELIGIBILITY_FLOW_ONLY) expect(names.has(name), name).toBe(true);
  });
});

/**
 * Invalid examples `UsageLedgerSchema` still accepts, on purpose. The JSON
 * Schema is what a writer may write; `UsageLedgerSchema` is the same shape, but
 * it trusts the file's path for the runtime, so a file without `runtime` passes.
 * DorkOS reads files more leniently still, through `parseStoredLedger`.
 */
const READER_ACCEPTS = new Set(['no runtime']);

describe('the fixture ledger schema', () => {
  const ajv = new Ajv({ strict: true, allErrors: true });
  const validate = ajv.compile(
    JSON.parse(readFileSync(path.join(FIXTURE_DIR, 'usage-ledger.schema.json'), 'utf8')) as object
  );
  const examples = JSON.parse(
    readFileSync(path.join(FIXTURE_DIR, 'usage-ledger.examples.json'), 'utf8')
  ) as { valid: { name: string; value: unknown }[]; invalid: { name: string; value: unknown }[] };

  // Purpose: DorkOS's Zod schema and the contract's JSON Schema accept the same files.
  for (const example of examples.valid) {
    it(`both accept: ${example.name}`, () => {
      expect(validate(example.value), JSON.stringify(validate.errors)).toBe(true);
      expect(UsageLedgerSchema.safeParse(example.value).success).toBe(true);
    });
  }
  for (const example of examples.invalid) {
    it(`both reject: ${example.name}`, () => {
      expect(validate(example.value)).toBe(false);
      expect(UsageLedgerSchema.safeParse(example.value).success).toBe(
        READER_ACCEPTS.has(example.name)
      );
    });
  }

  it('names only invalid examples that exist as reader leniencies', () => {
    const names = new Set(examples.invalid.map((e) => e.name));
    for (const name of READER_ACCEPTS) expect(names.has(name), name).toBe(true);
  });

  // Purpose: every ledger in the merge cases gets the same verdict from both
  // schemas, and every ledger a merge writes is one a writer may write once the
  // unknown window keys the merge must keep are set aside (flow's runner does
  // the same).
  it('agrees with UsageLedgerSchema on every ledger in the merge cases', () => {
    for (const c of load('ledger-merge.cases.json')) {
      const ledgers = [c.input.existing, c.expected.ledger].filter(
        (l): l is Record<string, unknown> =>
          typeof l === 'object' && l !== null && (l as { v?: unknown }).v === 1
      );
      for (const ledger of ledgers) {
        const withRuntime = 'runtime' in ledger;
        expect(UsageLedgerSchema.safeParse(ledger).success, c.name).toBe(
          validate(ledger) || !withRuntime
        );
      }
      if (c.expected.changed !== true) continue;
      const ledger = c.expected.ledger as { windows?: Record<string, unknown> };
      const writable = {
        ...ledger,
        windows: Object.fromEntries(
          Object.entries(ledger.windows ?? {}).filter(([key]) => WINDOW_KEY_PATTERN.test(key))
        ),
      };
      expect(validate(writable), `${c.name}: ${JSON.stringify(validate.errors)}`).toBe(true);
      expect(UsageLedgerSchema.safeParse(writable).success, c.name).toBe(true);
    }
  });
});
