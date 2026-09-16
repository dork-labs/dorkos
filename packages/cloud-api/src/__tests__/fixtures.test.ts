/**
 * The conformance fixtures.
 *
 * `fixtures/v1/**.json` is the shared corpus the control plane consumes: one
 * example per shape, with `fixtures/v1/index.json` naming the exported schema
 * that validates each. Two sides implementing the same contract from the same
 * examples is the cheapest interoperability test there is, and it only works if
 * the examples are known to be valid — which is what this file establishes.
 *
 * The drift guard matters as much as the validation: a fixture on disk that the
 * manifest does not name is invisible to the control plane, and a manifest
 * entry with no file is a broken reference. Both fail here.
 */
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import * as contract from '../index.js';

const fixturesRoot = path.resolve(import.meta.dirname, '..', '..', 'fixtures', 'v1');

const manifest = JSON.parse(readFileSync(path.join(fixturesRoot, 'index.json'), 'utf8')) as {
  wireVersion: number;
  description: string;
  fixtures: Record<string, string>;
};

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

describe('conformance fixtures', () => {
  it('declares the wire version it is a corpus for', () => {
    expect(manifest.wireVersion).toBe(contract.WIRE_VERSION);
  });

  it('names every file on disk, and no file that is missing', () => {
    expect(Object.keys(manifest.fixtures).sort()).toEqual(fixtureFiles());
  });

  it('covers every route group', () => {
    const groups = new Set(Object.keys(manifest.fixtures).map((rel) => rel.split('/')[0]));
    expect([...groups].sort()).toEqual([
      'billing',
      'connections',
      'inference',
      'instances',
      'problem',
      'remote',
      'seats',
      'session',
    ]);
  });

  for (const [rel, schemaName] of Object.entries(manifest.fixtures)) {
    it(`validates ${rel} against ${schemaName}`, () => {
      const schema = (contract as Record<string, unknown>)[schemaName];
      expect(schema, `${schemaName} is not exported from the package root`).toBeInstanceOf(
        z.ZodType
      );
      const example = JSON.parse(readFileSync(path.join(fixturesRoot, rel), 'utf8'));
      const result = (schema as z.ZodTypeAny).safeParse(example);
      expect(result.success ? null : z.prettifyError(result.error)).toBeNull();

      // Zod strips unknown keys by default, so a misspelled or stray field
      // parses green and the corpus quietly stops describing what it claims to.
      // Comparing the parsed value back to the example catches exactly that: a
      // key the schema did not keep is a key the contract does not have.
      expect(
        JSON.parse(JSON.stringify(result.success ? result.data : {})),
        `${rel} carries a field ${schemaName} does not define`
      ).toEqual(example);
    });
  }

  it('reaches no real host, so nothing here can be mistaken for a live endpoint', () => {
    // RFC 2606 reserves `.invalid`: every URL in the corpus resolves nowhere on
    // purpose, so a fixture pasted into a test cannot accidentally call out.
    const offenders: string[] = [];
    for (const rel of fixtureFiles()) {
      const text = readFileSync(path.join(fixturesRoot, rel), 'utf8');
      for (const url of text.match(/https?:\/\/[^\s"']+/g) ?? []) {
        if (!/^https?:\/\/[^/]*\.invalid(\/|$)/.test(url)) offenders.push(`${rel}: ${url}`);
      }
    }
    expect(offenders).toEqual([]);
  });
});
