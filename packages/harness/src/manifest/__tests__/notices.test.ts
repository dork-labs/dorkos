import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { manifestNotices } from '../notices.js';
import { parseHarnessManifest, RETIRED_MANIFEST_KEYS } from '../schema.js';

const here = dirname(fileURLToPath(import.meta.url));
// packages/harness/src/manifest/__tests__ -> repo root is five levels up.
const manifestPath = resolve(here, '../../../../../.agents/harness.manifest.json');
const liveManifest = (): unknown => JSON.parse(readFileSync(manifestPath, 'utf8'));

describe('manifestNotices', () => {
  it('VC-10: says nothing about a manifest that carries none of the retired keys', () => {
    // The quiet case has to stay quiet: a clean manifest earns no lines at all.
    const notices = manifestNotices(
      parseHarnessManifest({ version: 1, harnesses: ['claude-code'] })
    );
    expect(notices).toEqual([]);
  });

  it('VC-10: names each retired key that is still in the file, once', () => {
    // The `--check` line IS the migration notice: the manifest is a per-repo
    // file, so nothing rewrites it and the person is told what to delete.
    const notices = manifestNotices(
      parseHarnessManifest({
        version: 1,
        harnesses: ['claude-code'],
        skillWrappers: [{ target: 'codex', name: 'x' }],
        commandMappings: [],
        instructionProjections: [],
        skillBundles: [],
      })
    );
    expect(notices).toEqual([
      'skillWrappers in .agents/harness.manifest.json is no longer read — remove it',
      'commandMappings in .agents/harness.manifest.json is no longer read — remove it',
      'instructionProjections in .agents/harness.manifest.json is no longer read — remove it',
      'skillBundles in .agents/harness.manifest.json is no longer read — remove it',
    ]);
  });

  it('VC-10: covers every retired key', () => {
    // The list and the lines cannot drift: retiring another key means both.
    const all = Object.fromEntries(RETIRED_MANIFEST_KEYS.map((key) => [key, []]));
    const notices = manifestNotices(parseHarnessManifest({ version: 1, ...all }));
    expect(notices).toHaveLength(RETIRED_MANIFEST_KEYS.length);
    for (const key of RETIRED_MANIFEST_KEYS) {
      expect(notices.some((line) => line.startsWith(`${key} `))).toBe(true);
    }
  });

  it('VC-10: names a hookPolicies entry for a harness the manifest does not enable', () => {
    // A policy for a harness that is off does nothing, which is exactly the kind
    // of silent claim this ticket is about.
    const notices = manifestNotices(
      parseHarnessManifest({
        version: 1,
        harnesses: ['claude-code'],
        hookPolicies: [{ tool: 'cursor', projection: 'none' }],
      })
    );
    expect(notices).toEqual([
      'hookPolicies in .agents/harness.manifest.json names cursor, which this manifest does not enable',
    ]);
  });

  it('VC-10: names a hookPolicies entry whose tool is not a harness at all', () => {
    // A typo, or an agent DorkOS does not project to. Either way the entry is inert.
    const notices = manifestNotices(
      parseHarnessManifest({
        version: 1,
        harnesses: ['claude-code'],
        hookPolicies: [{ tool: 'windsurf', projection: 'none' }],
      })
    );
    expect(notices[0]).toContain('names windsurf');
    expect(notices[0]).toContain('claude-code, codex, cursor, gemini, copilot, opencode');
  });

  it('VC-10: says nothing about a hookPolicies entry for an enabled harness', () => {
    const notices = manifestNotices(
      parseHarnessManifest({
        version: 1,
        harnesses: ['claude-code', 'codex'],
        hookPolicies: [{ tool: 'codex', projection: 'generate' }],
      })
    );
    expect(notices).toEqual([]);
  });

  it('VC-10: names a tool that hookPolicies lists twice, since only the first is read', () => {
    // `hookPolicyFor` takes the first match, so a second entry decides nothing —
    // the same silent claim as a retired key, and invisible without a line.
    const notices = manifestNotices(
      parseHarnessManifest({
        version: 1,
        harnesses: ['claude-code', 'codex'],
        hookPolicies: [
          { tool: 'codex', projection: 'generate' },
          { tool: 'codex', projection: 'none' },
        ],
      })
    );
    expect(notices).toEqual([
      'hookPolicies in .agents/harness.manifest.json names codex more than once — only the first entry is read',
    ]);
  });

  it('VC-10: says nothing when each tool appears once', () => {
    const notices = manifestNotices(
      parseHarnessManifest({
        version: 1,
        harnesses: ['claude-code', 'codex'],
        hookPolicies: [
          { tool: 'codex', projection: 'generate' },
          { tool: 'claude-code', projection: 'none' },
        ],
      })
    );
    expect(notices).toEqual([]);
  });

  it("VC-10: reports this repo's own manifest as saying nothing that reaches nothing", () => {
    // The repo-hygiene edits DOR-1858 made — the four retired keys, and the
    // `cursor` entry for a harness this repo does not enable — kept honest by
    // the check itself. A standing notice nobody can clear is how people learn
    // to stop reading the output, so this repo's own manifest earns none.
    expect(manifestNotices(parseHarnessManifest(liveManifest()))).toEqual([]);
  });
});
