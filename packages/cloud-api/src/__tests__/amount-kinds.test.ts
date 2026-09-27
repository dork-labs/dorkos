/**
 * Amount kinds, the served denomination and the price list's cache rates.
 *
 * Every amount on this wire is an integer count of micro-units, and a renderer
 * has to know whether it is money or credits before it can show it: the same
 * string read the wrong way prints a price as a credit balance. These tests
 * hold the marks in place, prove the additions are additive, and keep the real
 * scale out of the corpus.
 */
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import * as billing from '../billing.js';
import * as contract from '../index.js';
import {
  PLACEHOLDER_CURRENCY,
  PLACEHOLDER_DENOMINATION,
  PLACEHOLDER_MICRO_PER_CREDIT,
} from './denomination-placeholder.js';
import { exportedSchemas, unwrap } from './schema-walk.js';

const fixturesRoot = path.resolve(import.meta.dirname, '..', '..', 'fixtures', 'v1');

/**
 * Every amount field, by the path from its exported schema, and its mark.
 *
 * The spec's table, written down where a change to it has to be deliberate.
 */
const EXPECTED_KINDS: Record<string, 'money' | 'credit'> = {
  'EntitlementLimitsSchema.includedCreditsMicro': 'credit',
  'EntitlementsSchema.limits.includedCreditsMicro': 'credit',
  'BalanceSchema.allowance.grantedMicro': 'credit',
  'BalanceSchema.allowance.remainingMicro': 'credit',
  'BalanceSchema.purchased.remainingMicro': 'credit',
  'BalanceSchema.pendingMicro': 'credit',
  'BalanceSchema.heldMicro': 'credit',
  'BalanceSchema.owedMicro': 'credit',
  'BalanceSchema.autoReload.ceilingMicro': 'money',
  'UsageRowSchema.listPriceMicro': 'money',
  'UsageRowSchema.dorkosPriceMicro': 'credit',
  'UsageResponseSchema.rows.listPriceMicro': 'money',
  'UsageResponseSchema.rows.dorkosPriceMicro': 'credit',
  'UsageResponseSchema.totals.listPriceMicro': 'money',
  'UsageResponseSchema.totals.dorkosPriceMicro': 'credit',
  'PriceListEntrySchema.inputMicro': 'credit',
  'PriceListEntrySchema.outputMicro': 'credit',
  'PriceListEntrySchema.cacheReadMicro': 'credit',
  'PriceListEntrySchema.cacheWriteMicro': 'credit',
  'PriceListResponseSchema.entries.inputMicro': 'credit',
  'PriceListResponseSchema.entries.outputMicro': 'credit',
  'PriceListResponseSchema.entries.cacheReadMicro': 'credit',
  'PriceListResponseSchema.entries.cacheWriteMicro': 'credit',
  'NudgeSchema.trailing30Micro': 'credit',
  'NudgeSchema.suggestedPlanPriceMicro': 'money',
  'NudgeSchema.savingMicro': 'money',
  'TopupRequestSchema.amountMicro': 'money',
  'OfferSchema.amountMicro': 'money',
  'OfferSchema.limits.includedCreditsMicro': 'credit',
  'OffersResponseSchema.offers.amountMicro': 'money',
  'OffersResponseSchema.offers.limits.includedCreditsMicro': 'credit',
  'StatementResponseSchema.lines.listPriceMicro': 'money',
  'StatementResponseSchema.lines.dorkosPriceMicro': 'credit',
  'StatementResponseSchema.totals.listPriceMicro': 'money',
  'StatementResponseSchema.totals.dorkosPriceMicro': 'credit',
  'RefundResponseSchema.refundedMicro': 'money',
};

/** The responses that carry amounts, each of which must accept a denomination. */
const DENOMINATED = [
  'EntitlementsSchema',
  'BalanceSchema',
  'UsageResponseSchema',
  'PriceListResponseSchema',
  'NudgeSchema',
  'OffersResponseSchema',
  'StatementResponseSchema',
] as const;

/** Reads the `amountKind` mark on a field, looking through its wrappers. */
function kindOf(node: z.ZodTypeAny): unknown {
  const seen = new Set<z.ZodTypeAny>();
  let current: z.ZodTypeAny | undefined = node;
  while (current && !seen.has(current)) {
    seen.add(current);
    const mark = z.globalRegistry.get(current)?.[contract.AMOUNT_KIND_META];
    if (mark !== undefined) return mark;
    const next = unwrap(current);
    current = next === current ? undefined : next;
  }
  return undefined;
}

/**
 * Every object field reachable from a schema, by dotted path.
 *
 * Written for this test rather than reusing `walk`, which visits a shared node
 * once per root: the same `CreditMicroSchema` instance sits in several fields,
 * and a walk that skipped the second one would pass an unmarked field unseen.
 */
function fields(root: z.ZodTypeAny, rootPath: string): Array<[string, z.ZodTypeAny]> {
  const found: Array<[string, z.ZodTypeAny]> = [];
  const visit = (node: z.ZodTypeAny, at: string, depth: number) => {
    if (depth > 20) return;
    const core = unwrap(node);
    const def = (core as unknown as { def: Record<string, unknown> }).def;
    const shape = def.shape as Record<string, z.ZodTypeAny> | undefined;
    if (shape) {
      for (const [key, value] of Object.entries(shape)) {
        found.push([`${at}.${key}`, value]);
        visit(value, `${at}.${key}`, depth + 1);
      }
    }
    const element = def.element as z.ZodTypeAny | undefined;
    if (element) visit(element, at, depth + 1);
    const options = def.options as z.ZodTypeAny[] | undefined;
    if (Array.isArray(options)) options.forEach((option) => visit(option, at, depth + 1));
  };
  visit(root, rootPath, 0);
  return found;
}

/** Every `.json` under `fixtures/v1`, relative to it, excluding the manifest. */
function fixtureFiles(dir = fixturesRoot, prefix = ''): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) found.push(...fixtureFiles(path.join(dir, entry.name), rel));
    else if (entry.name.endsWith('.json') && rel !== 'index.json') found.push(rel);
  }
  return found.sort();
}

/** Reads one fixture. */
function fixture(rel: string): Record<string, unknown> {
  return JSON.parse(readFileSync(path.join(fixturesRoot, rel), 'utf8')) as Record<string, unknown>;
}

describe('amount kinds', () => {
  it('marks every amount field in the contract exactly as the table says, and nothing else', () => {
    // Purpose: a new amount field added without a money or credit mark fails
    // here, and so does a field marked the wrong way round. Walks every
    // exported schema, not just billing, so an amount added to another route
    // group is caught too.
    const found: Record<string, unknown> = {};
    for (const [name, schema] of exportedSchemas()) {
      for (const [at, node] of fields(schema, name)) {
        const kind = kindOf(node);
        if (at.endsWith('Micro') || kind !== undefined) found[at] = kind;
      }
    }
    expect(found).toEqual(EXPECTED_KINDS);
  });

  it('keeps the wire shape and the TypeScript type of the amount they replace', () => {
    // Purpose: the marks are additive. Money and credit accept exactly what
    // MicroAmountSchema accepted, so no payload that parsed before fails now.
    const samples = [
      '0',
      '-0',
      '1',
      '-1',
      '1250000',
      '-4550',
      '9007199254740993',
      '1.5',
      '',
      '01',
      '1e6',
      ' 1',
    ];
    for (const sample of samples) {
      const before = contract.MicroAmountSchema.safeParse(sample).success;
      expect(contract.MoneyMicroSchema.safeParse(sample).success, sample).toBe(before);
      expect(contract.CreditMicroSchema.safeParse(sample).success, sample).toBe(before);
      const positiveBefore = contract.PositiveMicroAmountSchema.safeParse(sample).success;
      expect(contract.PositiveMoneyMicroSchema.safeParse(sample).success, sample).toBe(
        positiveBefore
      );
    }
    expect(contract.MoneyMicroSchema.safeParse(1250000).success).toBe(false);
    expect(contract.CreditMicroSchema.safeParse(1250000).success).toBe(false);
    // Type-level: both infer plain `string`, so a consumer's types do not move.
    const money: string = contract.MoneyMicroSchema.parse('1');
    const credit: string = contract.CreditMicroSchema.parse('1');
    expect([money, credit]).toEqual(['1', '1']);
  });

  it('leaves the old amount schemas exported and unmarked, for compatibility', () => {
    expect(z.globalRegistry.get(contract.MicroAmountSchema)?.[contract.AMOUNT_KIND_META]).toBe(
      undefined
    );
    expect(
      z.globalRegistry.get(contract.PositiveMicroAmountSchema)?.[contract.AMOUNT_KIND_META]
    ).toBe(undefined);
  });
});

describe('the denomination', () => {
  it('is optional on every amount-bearing response', () => {
    // Purpose: an older service sends none, and its responses must still parse.
    for (const name of DENOMINATED) {
      const schema = (contract as Record<string, unknown>)[name] as z.ZodObject;
      const field = schema.shape.denomination as z.ZodTypeAny | undefined;
      expect(field, `${name} has no denomination`).toBeDefined();
      expect((field as z.ZodTypeAny).safeParse(undefined).success, name).toBe(true);
    }
  });

  it('takes an ISO 4217 code and a positive integer scale, and nothing else', () => {
    const ok = contract.DenominationSchema.safeParse(PLACEHOLDER_DENOMINATION);
    expect(ok.success).toBe(true);
    for (const bad of [
      { currency: 'xts', microPerCredit: '250' },
      { currency: 'XT', microPerCredit: '250' },
      { currency: 'XTS', microPerCredit: '0' },
      { currency: 'XTS', microPerCredit: '-250' },
      { currency: 'XTS', microPerCredit: '2.5' },
      { currency: 'XTS', microPerCredit: 250 },
      { currency: 'XTS' },
    ]) {
      expect(contract.DenominationSchema.safeParse(bad).success, JSON.stringify(bad)).toBe(false);
    }
  });

  it('is not itself an amount, so it carries no amount mark', () => {
    for (const [at, node] of fields(contract.DenominationSchema, 'DenominationSchema')) {
      expect(kindOf(node), at).toBe(undefined);
    }
  });
});

describe('the price list cache rates', () => {
  it('are optional credit rates beside input and output', () => {
    const shape = contract.PriceListEntrySchema.shape;
    const entry = {
      modelId: 'md_x',
      displayName: 'x',
      unit: 'u',
      inputMicro: '1',
      outputMicro: '2',
    };
    expect(contract.PriceListEntrySchema.safeParse(entry).success).toBe(true);
    expect(
      contract.PriceListEntrySchema.safeParse({
        ...entry,
        cacheReadMicro: '3',
        cacheWriteMicro: '4',
      }).success
    ).toBe(true);
    expect(contract.PriceListEntrySchema.safeParse({ ...entry, cacheReadMicro: 3 }).success).toBe(
      false
    );
    expect(kindOf(shape.cacheReadMicro)).toBe('credit');
    expect(kindOf(shape.cacheWriteMicro)).toBe('credit');
  });
});

describe('the fixtures', () => {
  const denominated = fixtureFiles().filter((rel) => 'denomination' in fixture(rel));

  it('include a denominated example of every amount-bearing response', () => {
    const manifest = JSON.parse(readFileSync(path.join(fixturesRoot, 'index.json'), 'utf8')) as {
      fixtures: Record<string, string>;
    };
    const covered = new Set(denominated.map((rel) => manifest.fixtures[rel]));
    for (const name of DENOMINATED) expect(covered.has(name), name).toBe(true);
    const withCacheRates = fixtureFiles().filter((rel) =>
      JSON.stringify(fixture(rel)).includes('"cacheReadMicro"')
    );
    expect(withCacheRates.length).toBeGreaterThan(0);
  });

  it('still parse with every new field stripped, which is what an older service sends', () => {
    // Purpose: the additions are optional in practice, not just in the type.
    const manifest = JSON.parse(readFileSync(path.join(fixturesRoot, 'index.json'), 'utf8')) as {
      fixtures: Record<string, string>;
    };
    for (const rel of denominated) {
      const schema = (contract as Record<string, unknown>)[manifest.fixtures[rel]] as z.ZodTypeAny;
      const stripped = JSON.parse(
        JSON.stringify(fixture(rel), (key, value: unknown) =>
          key === 'denomination' || key === 'cacheReadMicro' || key === 'cacheWriteMicro'
            ? undefined
            : value
        )
      );
      const result = schema.safeParse(stripped);
      expect(result.success ? null : z.prettifyError(result.error), rel).toBeNull();
    }
  });

  it('carry only the placeholder denomination, so no real scale can enter the corpus', () => {
    // Purpose: the real scale is served, never published. Any fixture naming a
    // denomination other than the placeholder fails here.
    const offenders: string[] = [];
    const visit = (value: unknown, rel: string) => {
      if (Array.isArray(value)) value.forEach((item) => visit(item, rel));
      else if (typeof value === 'object' && value !== null) {
        for (const [key, inner] of Object.entries(value)) {
          if (key === 'microPerCredit' && inner !== PLACEHOLDER_MICRO_PER_CREDIT) {
            offenders.push(`${rel}: microPerCredit ${String(inner)}`);
          }
          if (key === 'currency' && inner !== PLACEHOLDER_CURRENCY) {
            offenders.push(`${rel}: currency ${String(inner)}`);
          }
          visit(inner, rel);
        }
      }
    };
    for (const rel of fixtureFiles()) visit(fixture(rel), rel);
    expect(offenders).toEqual([]);
    expect(denominated.length).toBeGreaterThan(0);
  });
});

describe('the JSON Schema', () => {
  /**
   * Whether `current` is `baseline` plus only what this change may add: an
   * `amountKind` keyword, a changed or new description, and new OPTIONAL
   * properties. Returns the first difference found, or null.
   */
  function additiveOver(baseline: unknown, current: unknown, at: string): string | null {
    const free = new Set(['description', contract.AMOUNT_KIND_META]);
    if (Array.isArray(baseline)) {
      if (!Array.isArray(current) || current.length !== baseline.length)
        return `${at}: array changed`;
      for (let index = 0; index < baseline.length; index += 1) {
        const diff = additiveOver(baseline[index], current[index], `${at}[${index}]`);
        if (diff) return diff;
      }
      return null;
    }
    if (typeof baseline === 'object' && baseline !== null) {
      if (typeof current !== 'object' || current === null || Array.isArray(current)) {
        return `${at}: no longer an object`;
      }
      const before = baseline as Record<string, unknown>;
      const after = current as Record<string, unknown>;
      for (const key of Object.keys(after)) {
        if (!(key in before) && !free.has(key)) return `${at}: new keyword ${key}`;
      }
      for (const [key, value] of Object.entries(before)) {
        if (free.has(key)) continue;
        if (!(key in after)) return `${at}: lost ${key}`;
        if (key === 'properties') {
          const props = after.properties as Record<string, unknown>;
          const required = new Set((after.required as string[] | undefined) ?? []);
          for (const added of Object.keys(props)) {
            if (!(added in (value as Record<string, unknown>)) && required.has(added)) {
              return `${at}: new REQUIRED property ${added}`;
            }
          }
          for (const [prop, inner] of Object.entries(value as Record<string, unknown>)) {
            const diff = additiveOver(inner, props[prop], `${at}.${prop}`);
            if (diff) return diff;
          }
          continue;
        }
        if (key === 'required') {
          const was = [...((value as string[]) ?? [])].sort();
          const now = [...((after.required as string[]) ?? [])].sort();
          if (JSON.stringify(was) !== JSON.stringify(now)) return `${at}: required changed`;
          continue;
        }
        const diff = additiveOver(value, after[key], `${at}.${key}`);
        if (diff) return diff;
      }
      return null;
    }
    return Object.is(baseline, current)
      ? null
      : `${at}: ${String(baseline)} became ${String(current)}`;
  }

  const baseline = JSON.parse(
    readFileSync(path.join(import.meta.dirname, 'baselines', 'billing-json-schema.json'), 'utf8')
  ) as Record<string, unknown>;

  it('changes only by amountKind, descriptions and new optional properties', () => {
    // Purpose: the baseline is the billing JSON Schema as published before the
    // amount kinds. Anything beyond the three permitted differences is a wire
    // change, and a wire change inside /v1 has to be additive.
    for (const [name, before] of Object.entries(baseline)) {
      const schema = (billing as Record<string, unknown>)[name];
      expect(schema, `${name} is no longer exported`).toBeInstanceOf(z.ZodType);
      const after = JSON.parse(
        JSON.stringify(z.toJSONSchema(schema as z.ZodTypeAny, { io: 'input' }))
      ) as unknown;
      expect(additiveOver(before, after, name)).toBeNull();
    }
  });

  it('emits the amount kind, so a consumer reading only the JSON Schema can tell them apart', () => {
    const emitted = z.toJSONSchema(contract.BalanceSchema, { io: 'input' }) as {
      properties: Record<string, Record<string, unknown>>;
    };
    expect(emitted.properties.heldMicro[contract.AMOUNT_KIND_META]).toBe('credit');
  });

  it('catches the change it exists to catch', () => {
    // Positive control: a comparator that passes everything proves nothing.
    const before = { type: 'object', properties: { a: { type: 'string' } }, required: ['a'] };
    expect(
      additiveOver(before, { ...before, properties: { a: { type: 'number' } } }, 'x')
    ).not.toBeNull();
    expect(
      additiveOver(
        before,
        {
          ...before,
          properties: { a: { type: 'string' }, b: { type: 'string' } },
          required: ['a', 'b'],
        },
        'x'
      )
    ).not.toBeNull();
    expect(additiveOver(before, { ...before, properties: {} }, 'x')).not.toBeNull();
    expect(
      additiveOver(
        before,
        {
          ...before,
          properties: {
            a: { type: 'string', amountKind: 'credit', description: 'd' },
            b: { type: 'string' },
          },
        },
        'x'
      )
    ).toBeNull();
  });
});
