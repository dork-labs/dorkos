import { describe, it, expect } from 'vitest';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { parseMarketplaceJson } from '../marketplace-json-parser.js';
import type { PackageType } from '../package-types.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SEED_FIXTURE_PATH = path.join(
  __dirname,
  '..',
  '..',
  'fixtures',
  'dorkos-community-marketplace.json'
);

const EXPECTED_TYPE_DISTRIBUTION: Record<PackageType, number> = {
  agent: 3,
  plugin: 2,
  'skill-pack': 2,
  adapter: 1,
};

describe('dorkos-community-marketplace.json seed fixture', () => {
  it('parses against the latest MarketplaceJson schema', async () => {
    const content = await readFile(SEED_FIXTURE_PATH, 'utf-8');
    const result = parseMarketplaceJson(content);

    if (!result.ok) {
      throw new Error(`Seed fixture failed to parse: ${result.error}`);
    }
    expect(result.ok).toBe(true);
  });

  it('declares exactly 8 packages', async () => {
    const content = await readFile(SEED_FIXTURE_PATH, 'utf-8');
    const result = parseMarketplaceJson(content);
    if (!result.ok) throw new Error(result.error);

    expect(result.marketplace.plugins).toHaveLength(8);
  });

  it('matches the canonical 3 agents / 2 plugins / 2 skill-packs / 1 adapter distribution', async () => {
    const content = await readFile(SEED_FIXTURE_PATH, 'utf-8');
    const result = parseMarketplaceJson(content);
    if (!result.ok) throw new Error(result.error);

    const counts: Record<string, number> = {};
    for (const entry of result.marketplace.plugins) {
      const key = entry.type ?? 'plugin';
      counts[key] = (counts[key] ?? 0) + 1;
    }

    expect(counts).toEqual(EXPECTED_TYPE_DISTRIBUTION);
  });

  it('every package declares the required name, source, description, and type fields', async () => {
    const content = await readFile(SEED_FIXTURE_PATH, 'utf-8');
    const result = parseMarketplaceJson(content);
    if (!result.ok) throw new Error(result.error);

    for (const entry of result.marketplace.plugins) {
      expect(entry.name, `entry missing name: ${JSON.stringify(entry)}`).toBeTruthy();
      expect(entry.source, `${entry.name} missing source`).toBeTruthy();
      expect(entry.description, `${entry.name} missing description`).toBeTruthy();
      expect(entry.type, `${entry.name} missing type`).toBeTruthy();
    }
  });
});
