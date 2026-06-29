import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { HarnessManifestSchema, parseHarnessManifest, HARNESS_IDS } from '../schema.js';

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

  it('rejects a skillBundle that still carries a per-skill list', () => {
    // The per-bundle `skills` array is derivable from sourceRoot and must not be stored.
    const stale = {
      version: 1,
      skillBundles: [{ name: 'flow', sourceRoot: '.agents/flow/skills', skills: [{ name: 'a' }] }],
    };
    expect(() => parseHarnessManifest(stale)).toThrow();
  });

  it('fills defaults for a minimal manifest', () => {
    // Only `version` is required; harnesses + every policy array default.
    const m = parseHarnessManifest({ version: 1 });
    expect(m.harnesses).toEqual(['claude-code']);
    expect(m.skillBundles).toEqual([]);
    expect(m.claudeOnlySkills).toEqual([]);
  });

  it('records codex hooks as a generate projection', () => {
    // The spike found Codex now supports repo-local hooks; the manifest must say generate.
    const m = parseHarnessManifest(liveManifest());
    const codex = m.hookPolicies.find((h) => h.tool === 'codex');
    expect(codex?.projection).toBe('generate');
    expect(codex?.configPath).toBe('.codex/hooks.json');
  });

  it('rejects an unknown harness id', () => {
    // HarnessId is a closed enum of the five supported harnesses.
    expect(() => parseHarnessManifest({ version: 1, harnesses: ['notreal'] })).toThrow();
  });

  it('rejects a hookPolicy projection outside the allowed set', () => {
    // projection is native|generate|none only.
    expect(() =>
      parseHarnessManifest({ version: 1, hookPolicies: [{ tool: 'codex', projection: 'magic' }] })
    ).toThrow();
  });

  it('exposes the five supported harness ids', () => {
    // The closed enum backs both the schema and the UI target list.
    expect([...HARNESS_IDS]).toEqual(['claude-code', 'codex', 'cursor', 'gemini', 'copilot']);
    expect(HarnessManifestSchema.shape.harnesses).toBeDefined();
  });
});
