/**
 * Tests for PermissionPreviewBuilder.
 *
 * Most tests build a fresh in-memory fixture package inside a temp dir, build
 * a preview against an isolated temp `dorkHome`, and assert the relevant
 * preview field. A mock detector keeps the bulk of these tests focused on
 * preview composition. One integration-style test wires the real
 * `ConflictDetector` to verify the end-to-end conflict path.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtemp, rm, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type {
  AdapterPackageManifest,
  AgentPackageManifest,
  PluginPackageManifest,
  SkillPackPackageManifest,
} from '@dorkos/marketplace';
import type { AdapterManager } from '../../relay/adapter-manager.js';
import { ConflictDetector } from '../conflict-detector.js';
import { PermissionPreviewBuilder, type ConflictDetectorLike } from '../permission-preview.js';

interface ExtensionFixture {
  id: string;
  contributions?: Record<string, boolean>;
  externalHosts?: string[];
  secrets?: Array<{ key: string; label: string; required?: boolean; description?: string }>;
}

interface SkillFixture {
  name: string;
  description: string;
  cron?: string;
}

interface FixtureOptions {
  extensions?: ExtensionFixture[];
  tasks?: SkillFixture[];
}

/**
 * Build a minimal valid plugin manifest. Pass overrides to inject `requires`
 * or other fields the test cares about.
 */
function pluginManifest(
  name: string,
  overrides: Partial<PluginPackageManifest> = {}
): PluginPackageManifest {
  return {
    schemaVersion: 1,
    name,
    version: '1.0.0',
    type: 'plugin',
    description: `${name} test fixture`,
    tags: [],
    layers: [],
    requires: [],
    extensions: [],
    ...overrides,
  };
}

/**
 * Build a minimal valid adapter manifest with the given configFields.
 * `secrets` are inserted as password configFields.
 */
function adapterManifest(name: string): AdapterPackageManifest {
  return {
    schemaVersion: 1,
    name,
    version: '1.0.0',
    type: 'adapter',
    description: `${name} adapter fixture`,
    tags: [],
    layers: [],
    requires: [],
    adapterType: 'webhook',
  };
}

/** Build a minimal valid agent manifest. */
function agentManifest(name: string): AgentPackageManifest {
  return {
    schemaVersion: 1,
    name,
    version: '1.0.0',
    type: 'agent',
    description: `${name} agent fixture`,
    tags: [],
    layers: [],
    requires: [],
  };
}

/** Build a minimal valid skill-pack manifest. */
function skillPackManifest(name: string): SkillPackPackageManifest {
  return {
    schemaVersion: 1,
    name,
    version: '1.0.0',
    type: 'skill-pack',
    description: `${name} skill-pack fixture`,
    tags: [],
    layers: [],
    requires: [],
  };
}

/**
 * Materialize a fixture package on disk: a manifest.json plus optional
 * `.dork/extensions/<id>/extension.json` and `.dork/tasks/<name>/SKILL.md`
 * directories. Returns the absolute package path.
 */
async function createFixturePackage(
  root: string,
  manifest:
    | PluginPackageManifest
    | SkillPackPackageManifest
    | AgentPackageManifest
    | AdapterPackageManifest,
  options: FixtureOptions = {}
): Promise<string> {
  const pkgPath = join(root, manifest.name);
  await mkdir(pkgPath, { recursive: true });
  await writeFile(join(pkgPath, 'manifest.json'), JSON.stringify(manifest, null, 2));

  for (const ext of options.extensions ?? []) {
    const extDir = join(pkgPath, '.dork', 'extensions', ext.id);
    await mkdir(extDir, { recursive: true });
    const extManifest: Record<string, unknown> = {
      id: ext.id,
      name: ext.id,
      version: '1.0.0',
    };
    if (ext.contributions) extManifest.contributions = ext.contributions;
    const serverCapabilities: Record<string, unknown> = {};
    if (ext.externalHosts) serverCapabilities.externalHosts = ext.externalHosts;
    if (ext.secrets) serverCapabilities.secrets = ext.secrets;
    if (Object.keys(serverCapabilities).length > 0) {
      extManifest.serverCapabilities = serverCapabilities;
    }
    await writeFile(join(extDir, 'extension.json'), JSON.stringify(extManifest, null, 2));
  }

  for (const task of options.tasks ?? []) {
    const taskDir = join(pkgPath, '.dork', 'tasks', task.name);
    await mkdir(taskDir, { recursive: true });
    const fmLines: string[] = [`name: ${task.name}`, `description: ${task.description}`];
    if (task.cron) fmLines.push(`cron: '${task.cron}'`);
    const skillContent = `---\n${fmLines.join('\n')}\n---\n\nTask body for ${task.name}.\n`;
    await writeFile(join(taskDir, 'SKILL.md'), skillContent);
  }

  return pkgPath;
}

/** Materialize an installed package marker so `requires` resolution can find it. */
async function installPlugin(dorkHome: string, name: string): Promise<void> {
  const dir = join(dorkHome, 'plugins', name);
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, 'manifest.json'), JSON.stringify({ name, type: 'plugin' }));
}

describe('PermissionPreviewBuilder', () => {
  let dorkHome: string;
  let pkgRoot: string;
  let detector: ConflictDetectorLike;
  let builder: PermissionPreviewBuilder;

  beforeEach(async () => {
    dorkHome = await mkdtemp(join(tmpdir(), 'permission-preview-home-'));
    pkgRoot = await mkdtemp(join(tmpdir(), 'permission-preview-pkg-'));
    detector = { detect: vi.fn().mockResolvedValue([]) };
    builder = new PermissionPreviewBuilder(dorkHome, detector);
  });

  afterEach(async () => {
    await rm(dorkHome, { recursive: true, force: true });
    await rm(pkgRoot, { recursive: true, force: true });
  });

  describe('plugin package with extensions and tasks', () => {
    it('populates fileChanges, extensions, and tasks from a fixture plugin', async () => {
      const manifest = pluginManifest('code-review-suite');
      const pkgPath = await createFixturePackage(pkgRoot, manifest, {
        extensions: [
          {
            id: 'review-extension',
            contributions: { 'session-sidebar': true, 'message-toolbar': true },
          },
        ],
        tasks: [
          { name: 'nightly-review', description: 'Review every night', cron: '0 0 * * *' },
          { name: 'weekly-summary', description: 'Summarize the week' },
        ],
      });

      const preview = await builder.build(pkgPath, manifest);

      // fileChanges — manifest.json plus the two extension/task files
      expect(preview.fileChanges.length).toBeGreaterThan(0);
      const expectedManifestPath = join(dorkHome, 'plugins', 'code-review-suite', 'manifest.json');
      expect(preview.fileChanges.some((f) => f.path === expectedManifestPath)).toBe(true);
      // Every entry in a brand-new install is `create`
      for (const fc of preview.fileChanges) {
        expect(fc.action).toBe('create');
      }

      // extensions
      expect(preview.extensions).toHaveLength(1);
      expect(preview.extensions[0]?.id).toBe('review-extension');
      expect(preview.extensions[0]?.slots).toEqual(
        expect.arrayContaining(['session-sidebar', 'message-toolbar'])
      );

      // tasks
      expect(preview.tasks).toHaveLength(2);
      const nightly = preview.tasks.find((t) => t.name === 'nightly-review');
      expect(nightly?.cron).toBe('0 0 * * *');
      const weekly = preview.tasks.find((t) => t.name === 'weekly-summary');
      expect(weekly?.cron).toBeNull();

      // conflicts placeholder is empty until task 2.3 wires the detector in
      expect(preview.conflicts).toEqual([]);
    });

    it('skips node_modules, .git, and dist when walking files', async () => {
      const manifest = pluginManifest('walker-test');
      const pkgPath = await createFixturePackage(pkgRoot, manifest);
      // Add forbidden subdirectories with content
      for (const ignored of ['node_modules', '.git', 'dist']) {
        const dir = join(pkgPath, ignored, 'nested');
        await mkdir(dir, { recursive: true });
        await writeFile(join(dir, 'should-not-appear.txt'), 'ignore me');
      }

      const preview = await builder.build(pkgPath, manifest);

      const ignoredHits = preview.fileChanges.filter(
        (f) =>
          f.path.includes(`${dorkHome}/plugins/walker-test/node_modules`) ||
          f.path.includes(`${dorkHome}/plugins/walker-test/.git`) ||
          f.path.includes(`${dorkHome}/plugins/walker-test/dist`)
      );
      expect(ignoredHits).toEqual([]);
    });
  });

  describe('adapter package secrets', () => {
    it('collects secrets from extension manifests bundled in an adapter package', async () => {
      const manifest = adapterManifest('slack-adapter');
      const pkgPath = await createFixturePackage(pkgRoot, manifest, {
        extensions: [
          {
            id: 'slack-bridge',
            secrets: [
              {
                key: 'slack_token',
                label: 'Slack API Token',
                required: true,
                description: 'Bot token from api.slack.com',
              },
              { key: 'slack_signing_secret', label: 'Signing Secret', required: false },
            ],
          },
        ],
      });

      const preview = await builder.build(pkgPath, manifest);

      expect(preview.secrets).toHaveLength(2);
      const tokenSecret = preview.secrets.find((s) => s.key === 'slack_token');
      expect(tokenSecret).toBeDefined();
      expect(tokenSecret?.required).toBe(true);
      expect(tokenSecret?.description).toContain('Bot token');
      const signing = preview.secrets.find((s) => s.key === 'slack_signing_secret');
      expect(signing?.required).toBe(false);
    });
  });

  describe('externalHosts', () => {
    it('collects external hosts from extension manifests', async () => {
      const manifest = pluginManifest('openai-bridge');
      const pkgPath = await createFixturePackage(pkgRoot, manifest, {
        extensions: [
          {
            id: 'gpt-extension',
            externalHosts: ['https://api.openai.com', 'https://api.anthropic.com'],
          },
        ],
      });

      const preview = await builder.build(pkgPath, manifest);

      expect(preview.externalHosts).toEqual(
        expect.arrayContaining(['https://api.openai.com', 'https://api.anthropic.com'])
      );
      // No duplicates
      expect(new Set(preview.externalHosts).size).toBe(preview.externalHosts.length);
    });

    it('deduplicates hosts contributed by multiple extensions', async () => {
      const manifest = pluginManifest('multi-bridge');
      const pkgPath = await createFixturePackage(pkgRoot, manifest, {
        extensions: [
          { id: 'ext-a', externalHosts: ['https://api.openai.com'] },
          { id: 'ext-b', externalHosts: ['https://api.openai.com', 'https://api.cohere.ai'] },
        ],
      });

      const preview = await builder.build(pkgPath, manifest);

      expect(preview.externalHosts).toHaveLength(2);
      expect(preview.externalHosts).toEqual(
        expect.arrayContaining(['https://api.openai.com', 'https://api.cohere.ai'])
      );
    });
  });

  describe('requires resolution', () => {
    it('reports satisfied=true when a required plugin is installed at dorkHome', async () => {
      await installPlugin(dorkHome, 'pkg-a');
      const manifest = pluginManifest('depender', { requires: ['plugin:pkg-a'] });
      const pkgPath = await createFixturePackage(pkgRoot, manifest);

      const preview = await builder.build(pkgPath, manifest);

      expect(preview.requires).toHaveLength(1);
      expect(preview.requires[0]).toMatchObject({
        type: 'plugin',
        name: 'pkg-a',
        satisfied: true,
      });
    });

    it('reports satisfied=false when a required plugin is missing', async () => {
      const manifest = pluginManifest('depender', { requires: ['plugin:pkg-missing@^1.0.0'] });
      const pkgPath = await createFixturePackage(pkgRoot, manifest);

      const preview = await builder.build(pkgPath, manifest);

      expect(preview.requires).toHaveLength(1);
      expect(preview.requires[0]).toMatchObject({
        type: 'plugin',
        name: 'pkg-missing',
        version: '^1.0.0',
        satisfied: false,
      });
    });

    it('checks the agents directory for `agent:` requirements', async () => {
      const agentDir = join(dorkHome, 'agents', 'helper-bot');
      await mkdir(agentDir, { recursive: true });
      const manifest = pluginManifest('agent-consumer', { requires: ['agent:helper-bot'] });
      const pkgPath = await createFixturePackage(pkgRoot, manifest);

      const preview = await builder.build(pkgPath, manifest);

      expect(preview.requires[0]).toMatchObject({
        type: 'agent',
        name: 'helper-bot',
        satisfied: true,
      });
    });
  });

  describe('agent package destination', () => {
    it('routes file destinations to ${dorkHome}/agents/<name> for agent packages', async () => {
      const manifest = agentManifest('research-bot');
      const pkgPath = await createFixturePackage(pkgRoot, manifest);

      const preview = await builder.build(pkgPath, manifest);

      const expected = join(dorkHome, 'agents', 'research-bot', 'manifest.json');
      expect(preview.fileChanges.some((f) => f.path === expected)).toBe(true);
    });
  });

  describe('skill-pack package destination', () => {
    it('routes file destinations to ${dorkHome}/plugins/<name> for skill-pack packages', async () => {
      const manifest = skillPackManifest('writing-skills');
      const pkgPath = await createFixturePackage(pkgRoot, manifest);

      const preview = await builder.build(pkgPath, manifest);

      const expected = join(dorkHome, 'plugins', 'writing-skills', 'manifest.json');
      expect(preview.fileChanges.some((f) => f.path === expected)).toBe(true);
    });
  });

  describe('conflict detector wiring', () => {
    it('forwards detector results into preview.conflicts', async () => {
      const manifest = pluginManifest('clean-package');
      const pkgPath = await createFixturePackage(pkgRoot, manifest);
      const detectorReport = {
        level: 'warning' as const,
        type: 'slot' as const,
        description: 'forwarded from mock',
        conflictingPackage: 'other-pkg',
      };
      const customDetector: ConflictDetectorLike = {
        detect: vi.fn().mockResolvedValue([detectorReport]),
      };
      const customBuilder = new PermissionPreviewBuilder(dorkHome, customDetector);

      const preview = await customBuilder.build(pkgPath, manifest);

      expect(customDetector.detect).toHaveBeenCalledWith({
        packagePath: pkgPath,
        manifest,
        dorkHome,
        projectPath: undefined,
      });
      expect(preview.conflicts).toEqual([detectorReport]);
    });

    it('leaves conflicts empty when the detector finds nothing', async () => {
      const manifest = pluginManifest('clean-package');
      const pkgPath = await createFixturePackage(pkgRoot, manifest);

      const preview = await builder.build(pkgPath, manifest);

      expect(preview.conflicts).toEqual([]);
      expect(detector.detect).toHaveBeenCalledWith({
        packagePath: pkgPath,
        manifest,
        dorkHome,
        projectPath: undefined,
      });
    });

    it('reports a package-name conflict end-to-end via the real ConflictDetector', async () => {
      // Pre-install a package with the same name so the detector's rule 1 fires.
      await installPlugin(dorkHome, 'duplicate-pkg');

      const stubAdapterManager = {
        listAdapters: vi.fn().mockReturnValue([]),
      } as unknown as AdapterManager;
      const realDetector = new ConflictDetector(dorkHome, stubAdapterManager);
      const realBuilder = new PermissionPreviewBuilder(dorkHome, realDetector);

      const manifest = pluginManifest('duplicate-pkg');
      const pkgPath = await createFixturePackage(pkgRoot, manifest);

      const preview = await realBuilder.build(pkgPath, manifest);

      expect(preview.conflicts).toHaveLength(1);
      expect(preview.conflicts[0]).toMatchObject({
        level: 'error',
        type: 'package-name',
        conflictingPackage: 'duplicate-pkg',
      });
    });
  });
});
