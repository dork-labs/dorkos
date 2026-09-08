import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import {
  HarnessManifestSchema,
  parseHarnessManifest,
  HARNESS_IDS,
  RETIRED_MANIFEST_KEYS,
} from '../schema.js';

const here = dirname(fileURLToPath(import.meta.url));
// packages/harness/src/manifest/__tests__ -> repo root is five levels up.
const manifestPath = resolve(here, '../../../../../.agents/harness.manifest.json');
const liveManifest = (): unknown => JSON.parse(readFileSync(manifestPath, 'utf8'));

describe('HarnessManifestSchema', () => {
  it('accepts the live migrated .agents/harness.manifest.json', () => {
    // The real, slimmed repo manifest must validate — guards against drift between
    // the on-disk manifest and the schema.
    expect(() => parseHarnessManifest(liveManifest())).not.toThrow();
  });

  it('rejects a manifest that still carries a derivable sharedSkills array', () => {
    // strict() must reject the removed-but-stale derivable field (the drift guard);
    // the scanner reconstructs sharedSkills, so its presence is an error.
    const stale = {
      version: 1,
      sharedSkills: [
        {
          name: 'x',
          source: '.agents/skills/x',
          claudeProjection: { path: '.claude/skills/x', type: 'symlink' },
        },
      ],
    };
    expect(() => parseHarnessManifest(stale)).toThrow();
  });

  it('accepts, and ignores, every retired key whatever it holds', () => {
    // The four keys nothing reads (DOR-1858) stay ACCEPTED so an existing repo's
    // manifest still parses — `--enable` validates with this schema before it
    // writes a byte, and rejecting the file would cost a person a hand-edit
    // before any of it worked. Their CONTENTS are no longer anybody's business,
    // so a shape that used to be rejected (a bundle carrying a per-skill list)
    // now parses too.
    const carried = {
      version: 1,
      skillWrappers: [{ target: 'codex', name: 'x', whatever: true }],
      commandMappings: 'not even an array',
      instructionProjections: null,
      skillBundles: [{ name: 'flow', sourceRoot: '.agents/flow/skills', skills: [{ name: 'a' }] }],
    };
    expect(() => parseHarnessManifest(carried)).not.toThrow();
    expect(parseHarnessManifest(carried).harnesses).toEqual(['claude-code']);
  });

  it('still rejects a key it has never had', () => {
    // Retiring four keys did not open the door: `.strict()` is what catches the
    // derivable `sharedSkills` above, and a typo in a live key is caught the
    // same way.
    expect(() => parseHarnessManifest({ version: 1, harneses: ['codex'] })).toThrow();
  });

  it('fills defaults for a minimal manifest', () => {
    // Only `version` is required; harnesses + every policy array default.
    const m = parseHarnessManifest({ version: 1 });
    expect(m.harnesses).toEqual(['claude-code']);
    expect(m.hookPolicies).toEqual([]);
    expect(m.claudeOnlySkills).toEqual([]);
  });

  it('leaves a retired key it was not given off the parsed manifest', () => {
    // How presence is detected: Zod drops an absent optional key entirely, so
    // `manifest.skillWrappers !== undefined` is the whole test, and no JSON
    // value can fake it.
    const m = parseHarnessManifest({ version: 1 });
    expect(RETIRED_MANIFEST_KEYS.every((key) => m[key] === undefined)).toBe(true);
    expect(parseHarnessManifest({ version: 1, skillWrappers: [] }).skillWrappers).toEqual([]);
  });

  it('records codex hooks as a generate projection', () => {
    // The spike found Codex now supports repo-local hooks; the manifest must say generate.
    const m = parseHarnessManifest(liveManifest());
    const codex = m.hookPolicies.find((h) => h.tool === 'codex');
    expect(codex?.projection).toBe('generate');
    expect(codex?.configPath).toBe('.codex/hooks.json');
  });

  it('rejects an unknown harness id', () => {
    // HarnessId is a closed enum of the supported harnesses.
    expect(() => parseHarnessManifest({ version: 1, harnesses: ['notreal'] })).toThrow();
  });

  it('rejects a hookPolicy projection outside the allowed set', () => {
    // projection is native|generate|none only.
    expect(() =>
      parseHarnessManifest({ version: 1, hookPolicies: [{ tool: 'codex', projection: 'magic' }] })
    ).toThrow();
  });

  it('exposes the six supported harness ids', () => {
    // The closed enum backs both the schema and the UI target list.
    expect([...HARNESS_IDS]).toEqual([
      'claude-code',
      'codex',
      'cursor',
      'gemini',
      'copilot',
      'opencode',
    ]);
    expect(HarnessManifestSchema.shape.harnesses).toBeDefined();
  });
});
