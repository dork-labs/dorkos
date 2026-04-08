/**
 * Direction A — outbound CC compatibility regression test.
 *
 * Proves that every DorkOS-authored fixture passes BOTH:
 *   (1) the DorkOS passthrough schema (`MarketplaceJsonSchema`), AND
 *   (2) the strict CC compatibility oracle (`CcMarketplaceJsonSchema`),
 *
 * and that the marketplace.json carries ZERO DorkOS-specific inline
 * fields (the load-bearing sidecar-isolation assertion).
 *
 * The seed fixture at `fixtures/dorkos-seed/.claude-plugin/marketplace.json`
 * also passes `claude plugin validate` against a real CC 2.1.92 binary —
 * see `research/20260407_cc_validator_empirical_verify.md`.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

import { MarketplaceJsonSchema } from '../marketplace-json-schema.js';
import { CcMarketplaceJsonSchema, validateAgainstCcSchema } from '../cc-validator.js';
import { DorkosSidecarSchema } from '../dorkos-sidecar-schema.js';
import { mergeMarketplace } from '../merge-marketplace.js';
import { parseMarketplaceWithSidecar } from '../marketplace-json-parser.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const seedRoot = resolve(__dirname, '..', '..', 'fixtures', 'dorkos-seed');
const marketplacePath = resolve(seedRoot, '.claude-plugin', 'marketplace.json');
const sidecarPath = resolve(seedRoot, '.claude-plugin', 'dorkos.json');

/**
 * The set of DorkOS-specific keys that MUST NOT appear inline on a
 * plugin entry in `marketplace.json`. These live in the sidecar instead.
 * This is the structural assertion that enforces ADR-0236.
 */
const FORBIDDEN_INLINE_KEYS = [
  'type',
  'layers',
  'requires',
  'featured',
  'icon',
  'dorkosMinVersion',
  'pricing',
] as const;

describe('dorkos-seed fixture — Direction A bidirectional validation', () => {
  const raw = readFileSync(marketplacePath, 'utf8');

  it('parses via the DorkOS passthrough schema', () => {
    const result = MarketplaceJsonSchema.safeParse(JSON.parse(raw));
    expect(result.success).toBe(true);
  });

  it('parses via the strict CC-compatibility schema', () => {
    const result = CcMarketplaceJsonSchema.safeParse(JSON.parse(raw));
    expect(result.success).toBe(true);
  });

  it('validateAgainstCcSchema returns ok: true', () => {
    const result = validateAgainstCcSchema(JSON.parse(raw));
    expect(result.ok).toBe(true);
  });

  it('no plugin entry carries inline DorkOS-specific keys', () => {
    const parsed = JSON.parse(raw) as { plugins: Record<string, unknown>[] };
    for (const entry of parsed.plugins) {
      for (const forbidden of FORBIDDEN_INLINE_KEYS) {
        expect(
          entry[forbidden],
          `plugin "${String(entry.name)}" leaked inline key "${forbidden}"`
        ).toBeUndefined();
      }
    }
  });

  it('declares exactly 8 seed plugins', () => {
    const parsed = MarketplaceJsonSchema.parse(JSON.parse(raw));
    expect(parsed.plugins).toHaveLength(8);
  });

  it('uses the ./ prefix on every relative-path source', () => {
    const parsed = JSON.parse(raw) as { plugins: { source: unknown }[] };
    for (const entry of parsed.plugins) {
      if (typeof entry.source === 'string') {
        expect(entry.source.startsWith('./')).toBe(true);
      }
    }
  });
});

describe('dorkos-seed sidecar — merge and orphan handling', () => {
  const rawMarketplace = readFileSync(marketplacePath, 'utf8');
  const rawSidecar = readFileSync(sidecarPath, 'utf8');

  it('sidecar parses cleanly', () => {
    const result = DorkosSidecarSchema.safeParse(JSON.parse(rawSidecar));
    expect(result.success).toBe(true);
  });

  it('merge produces 8 entries with DorkOS extensions attached and zero orphans', () => {
    const marketplace = MarketplaceJsonSchema.parse(JSON.parse(rawMarketplace));
    const sidecar = DorkosSidecarSchema.parse(JSON.parse(rawSidecar));
    const { entries, orphans } = mergeMarketplace(marketplace, sidecar);

    expect(entries).toHaveLength(8);
    expect(orphans).toEqual([]);

    for (const entry of entries) {
      expect(entry.dorkos, `plugin "${entry.name}" missing sidecar entry`).toBeDefined();
      expect(entry.dorkos?.type).toBeDefined();
    }
  });

  it('parseMarketplaceWithSidecar returns the same result shape', () => {
    const result = parseMarketplaceWithSidecar(rawMarketplace, rawSidecar);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.merged).toHaveLength(8);
      expect(result.orphans).toEqual([]);
    }
  });

  it('canonical type distribution: 3 agents / 2 plugins / 2 skill-packs / 1 adapter', () => {
    const sidecar = DorkosSidecarSchema.parse(JSON.parse(rawSidecar));
    const counts: Record<string, number> = {};
    for (const entry of Object.values(sidecar.plugins)) {
      const t = entry.type ?? 'plugin';
      counts[t] = (counts[t] ?? 0) + 1;
    }
    expect(counts).toEqual({
      agent: 3,
      plugin: 2,
      'skill-pack': 2,
      adapter: 1,
    });
  });
});
