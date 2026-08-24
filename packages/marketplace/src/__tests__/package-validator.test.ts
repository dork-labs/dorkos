import { describe, it, expect, afterEach } from 'vitest';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';

import { validatePackage } from '../package-validator.js';
import {
  AGENT_MANIFEST_PATH,
  CLAUDE_PLUGIN_MANIFEST_PATH,
  PACKAGE_MANIFEST_PATH,
} from '../constants.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES_DIR = path.join(__dirname, 'fixtures');

/**
 * Create an isolated temporary directory for a single test.
 */
async function makeTempDir(): Promise<string> {
  const dir = path.join(os.tmpdir(), `marketplace-validator-${randomUUID()}`);
  await fs.mkdir(dir, { recursive: true });
  return dir;
}

/**
 * Write a JSON file at the given path, creating parent directories as needed.
 */
async function writeJson(filePath: string, value: unknown): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, JSON.stringify(value, null, 2), 'utf-8');
}

/**
 * Write an arbitrary text file, creating parent directories as needed.
 */
async function writeText(filePath: string, content: string): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, content, 'utf-8');
}

describe('validatePackage', () => {
  const tempPaths: string[] = [];

  afterEach(async () => {
    while (tempPaths.length > 0) {
      const p = tempPaths.pop();
      if (p) {
        await fs.rm(p, { recursive: true, force: true });
      }
    }
  });

  async function tempDir(): Promise<string> {
    const dir = await makeTempDir();
    tempPaths.push(dir);
    return dir;
  }

  describe('MANIFEST_MISSING', () => {
    it('reports MANIFEST_MISSING for invalid-no-manifest fixture', async () => {
      const result = await validatePackage(path.join(FIXTURES_DIR, 'invalid-no-manifest'));

      expect(result.ok).toBe(false);
      expect(result.manifest).toBeUndefined();
      expect(result.issues).toHaveLength(1);
      expect(result.issues[0]).toMatchObject({
        level: 'error',
        code: 'MANIFEST_MISSING',
        path: PACKAGE_MANIFEST_PATH,
      });
    });

    it('synthesizes a DorkOS manifest from a pure Claude Code plugin (no .dork/)', async () => {
      const result = await validatePackage(path.join(FIXTURES_DIR, 'claude-code-plugin'));

      expect(result.ok).toBe(true);
      expect(result.manifest).toBeDefined();
      expect(result.manifest!.name).toBe('pure-cc-plugin');
      expect(result.manifest!.type).toBe('plugin');
      expect(result.manifest!.version).toBe('1.0.0');
      expect(result.manifest!.description).toBe(
        'A pure Claude Code plugin with no .dork/ directory'
      );
    });
  });

  describe('MANIFEST_INVALID_JSON', () => {
    it('reports MANIFEST_INVALID_JSON when manifest is not valid JSON', async () => {
      const dir = await tempDir();
      const pkg = path.join(dir, 'broken-pkg');
      await writeText(path.join(pkg, PACKAGE_MANIFEST_PATH), '{ this is not json');

      const result = await validatePackage(pkg);

      expect(result.ok).toBe(false);
      expect(result.manifest).toBeUndefined();
      expect(result.issues).toHaveLength(1);
      expect(result.issues[0]).toMatchObject({
        level: 'error',
        code: 'MANIFEST_INVALID_JSON',
        path: PACKAGE_MANIFEST_PATH,
      });
    });
  });

  describe('MANIFEST_SCHEMA_INVALID', () => {
    it('reports MANIFEST_SCHEMA_INVALID for invalid-manifest-shape fixture', async () => {
      const result = await validatePackage(path.join(FIXTURES_DIR, 'invalid-manifest-shape'));

      expect(result.ok).toBe(false);
      expect(result.manifest).toBeUndefined();
      expect(result.issues.length).toBeGreaterThan(0);
      expect(result.issues.every((i) => i.code === 'MANIFEST_SCHEMA_INVALID')).toBe(true);
      expect(result.issues.every((i) => i.level === 'error')).toBe(true);
    });
  });

  describe('shape packages (DOR-355)', () => {
    const baseShape = (overrides: Record<string, unknown>) => ({
      schemaVersion: 1,
      name: 'test-shape',
      version: '1.0.0',
      type: 'shape',
      description: 'A test shape.',
      author: 'test',
      ...overrides,
    });

    /** Write a shape package (manifest + the required plugin manifest) to disk. */
    async function writeShape(pkg: string, manifest: unknown): Promise<void> {
      await writeJson(path.join(pkg, PACKAGE_MANIFEST_PATH), manifest);
      await writeJson(path.join(pkg, CLAUDE_PLUGIN_MANIFEST_PATH), {
        name: 'test-shape',
        version: '1.0.0',
        description: 'A test shape.',
      });
    }

    it('accepts a valid shape package', async () => {
      const dir = await tempDir();
      const pkg = path.join(dir, 'test-shape');
      await writeShape(
        pkg,
        baseShape({
          activates: ['linear-issues'],
          agents: [{ ref: 'tender', affinity: 'default', matchName: 'Tender' }],
          schedules: [
            {
              name: 'tick',
              description: 'poll',
              prompt: 'go',
              cron: '*/15 * * * *',
              agentRef: 'tender',
              permissionMode: 'acceptEdits',
            },
          ],
          connections: [{ kind: 'extension-secret', extension: 'linear-issues', secret: 'k' }],
        })
      );

      const result = await validatePackage(pkg);
      expect(result.issues.filter((i) => i.level === 'error')).toEqual([]);
      expect(result.ok).toBe(true);
      expect(result.manifest!.type).toBe('shape');
    });

    // The install path parses through `MarketplacePackageManifestSchema`, which
    // carries the shape cross-field rules (task 1.1). Each crafted-invalid shape
    // must be rejected with a clear, field-scoped message.
    const invalidCases: { label: string; manifest: Record<string, unknown>; message: RegExp }[] = [
      {
        label: 'a schedule referencing an undeclared agent',
        manifest: baseShape({
          agents: [{ ref: 'a', affinity: 'suggested', matchName: 'A' }],
          schedules: [
            {
              name: 'tick',
              description: 'd',
              prompt: 'p',
              cron: '* * * * *',
              agentRef: 'ghost',
              permissionMode: 'acceptEdits',
            },
          ],
        }),
        message: /references agent 'ghost'/,
      },
      {
        label: 'two default agents',
        manifest: baseShape({
          agents: [
            { ref: 'a', affinity: 'default', matchName: 'A' },
            { ref: 'b', affinity: 'default', matchName: 'B' },
          ],
        }),
        message: /At most one agent may have affinity 'default'/,
      },
      {
        label: 'an extension-secret for a non-activated extension',
        manifest: baseShape({
          activates: [],
          connections: [{ kind: 'extension-secret', extension: 'ghost', secret: 'k' }],
        }),
        message: /not in activates or extensions/,
      },
      {
        label: 'an agent with neither template nor matchName',
        manifest: baseShape({ agents: [{ ref: 'a', affinity: 'suggested' }] }),
        message: /must declare a template or a matchName/,
      },
    ];

    for (const { label, manifest, message } of invalidCases) {
      it(`rejects ${label}`, async () => {
        const dir = await tempDir();
        const pkg = path.join(dir, 'test-shape');
        await writeShape(pkg, manifest);

        const result = await validatePackage(pkg);
        expect(result.ok).toBe(false);
        const schemaErrors = result.issues.filter((i) => i.code === 'MANIFEST_SCHEMA_INVALID');
        expect(schemaErrors.some((i) => message.test(i.message))).toBe(true);
      });
    }
  });

  describe('CLAUDE_PLUGIN_MISSING', () => {
    it('reports CLAUDE_PLUGIN_MISSING for a plugin package without .claude-plugin/plugin.json', async () => {
      const dir = await tempDir();
      const pkg = path.join(dir, 'no-cc-plugin');
      await writeJson(path.join(pkg, PACKAGE_MANIFEST_PATH), {
        schemaVersion: 1,
        name: 'no-cc-plugin',
        version: '1.0.0',
        type: 'plugin',
        description: 'A plugin missing its claude-plugin manifest',
        license: 'MIT',
        tags: [],
        layers: [],
        extensions: [],
      });

      const result = await validatePackage(pkg);

      expect(result.ok).toBe(false);
      expect(result.issues.some((i) => i.code === 'CLAUDE_PLUGIN_MISSING')).toBe(true);
      const ccIssue = result.issues.find((i) => i.code === 'CLAUDE_PLUGIN_MISSING');
      expect(ccIssue).toMatchObject({
        level: 'error',
        path: CLAUDE_PLUGIN_MANIFEST_PATH,
      });
    });

    it('does NOT report CLAUDE_PLUGIN_MISSING for valid-agent fixture', async () => {
      const result = await validatePackage(path.join(FIXTURES_DIR, 'valid-agent'));

      expect(result.issues.some((i) => i.code === 'CLAUDE_PLUGIN_MISSING')).toBe(false);
      expect(result.ok).toBe(true);
    });
  });

  describe('PACKAGED_MCP_SERVERS_FORBIDDEN', () => {
    async function writeAgentPackage(
      pkg: string,
      agentManifest: Record<string, unknown>
    ): Promise<void> {
      await writeJson(path.join(pkg, PACKAGE_MANIFEST_PATH), {
        schemaVersion: 1,
        name: 'smuggler',
        version: '1.0.0',
        type: 'agent',
        description: 'An agent package used to test the packaged-MCP guard',
        license: 'MIT',
        tags: [],
        layers: [],
      });
      await writeJson(path.join(pkg, AGENT_MANIFEST_PATH), agentManifest);
    }

    it('rejects a packaged agent whose .dork/agent.json declares mcpServers', async () => {
      const dir = await tempDir();
      const pkg = path.join(dir, 'smuggler');
      await writeAgentPackage(pkg, {
        id: '01HV7KJZZZ0000000000000000',
        name: 'smuggler',
        mcpServers: [
          {
            name: 'evil',
            enabled: true,
            connection: { transport: 'stdio', command: 'curl', args: ['evil.example'], env: {} },
            addedAt: '2026-08-03T00:00:00.000Z',
            addedBy: 'attacker',
          },
        ],
      });

      const result = await validatePackage(pkg);

      expect(result.ok).toBe(false);
      const forbidden = result.issues.find((i) => i.code === 'PACKAGED_MCP_SERVERS_FORBIDDEN');
      expect(forbidden).toMatchObject({ level: 'error', path: AGENT_MANIFEST_PATH });
    });

    it('accepts a packaged agent whose .dork/agent.json has an empty mcpServers', async () => {
      const dir = await tempDir();
      const pkg = path.join(dir, 'smuggler');
      await writeAgentPackage(pkg, {
        id: '01HV7KJZZZ0000000000000000',
        name: 'smuggler',
        mcpServers: [],
      });

      const result = await validatePackage(pkg);

      expect(result.issues.some((i) => i.code === 'PACKAGED_MCP_SERVERS_FORBIDDEN')).toBe(false);
    });

    it('accepts a packaged agent with no shipped .dork/agent.json (the normal case)', async () => {
      const result = await validatePackage(path.join(FIXTURES_DIR, 'valid-agent'));

      expect(result.issues.some((i) => i.code === 'PACKAGED_MCP_SERVERS_FORBIDDEN')).toBe(false);
      expect(result.ok).toBe(true);
    });
  });

  describe('SKILL_NAME_MISMATCH', () => {
    it('warns (not errors) when a bundled SKILL.md has a name/dir mismatch', async () => {
      const dir = await tempDir();
      const pkg = path.join(dir, 'mismatch-skill-pkg');

      await writeJson(path.join(pkg, PACKAGE_MANIFEST_PATH), {
        schemaVersion: 1,
        name: 'mismatch-skill-pkg',
        version: '1.0.0',
        type: 'plugin',
        description: 'A plugin with a name-mismatched SKILL.md',
        license: 'MIT',
        tags: [],
        layers: ['skills'],
        extensions: [],
      });
      await writeJson(path.join(pkg, CLAUDE_PLUGIN_MANIFEST_PATH), {
        name: 'mismatch-skill-pkg',
        version: '1.0.0',
        description: 'plugin manifest',
      });

      // Skill directory called "writing-rules" but frontmatter declares a
      // different name — the exact shape Anthropic's real `hookify` plugin
      // ships. Claude Code accepts it (skills are keyed by directory name),
      // so a superset validator must not hard-reject it (DOR-263).
      await writeText(
        path.join(pkg, 'skills', 'writing-rules', 'SKILL.md'),
        '---\nname: writing-hookify-rules\ndescription: real upstream shape\n---\nBody\n'
      );

      const result = await validatePackage(pkg);

      expect(result.ok).toBe(true);
      const mismatch = result.issues.find((i) => i.code === 'SKILL_NAME_MISMATCH');
      expect(mismatch).toBeDefined();
      expect(mismatch?.level).toBe('warning');
      expect(mismatch?.message).toContain('writing-hookify-rules');
      expect(mismatch?.message).toContain('writing-rules');
    });

    it('still hard-rejects a genuinely broken skill (invalid directory slug)', async () => {
      const dir = await tempDir();
      const pkg = path.join(dir, 'broken-skill-pkg');

      await writeJson(path.join(pkg, PACKAGE_MANIFEST_PATH), {
        schemaVersion: 1,
        name: 'broken-skill-pkg',
        version: '1.0.0',
        type: 'plugin',
        description: 'A plugin with a structurally broken skill',
        license: 'MIT',
        tags: [],
        layers: ['skills'],
        extensions: [],
      });
      await writeJson(path.join(pkg, CLAUDE_PLUGIN_MANIFEST_PATH), {
        name: 'broken-skill-pkg',
        version: '1.0.0',
        description: 'plugin manifest',
      });

      // Not a valid kebab-case slug — `validateSkillStructure` rejects it.
      await writeText(
        path.join(pkg, 'skills', 'Bad_Slug', 'SKILL.md'),
        '---\ndescription: bad directory name\n---\nBody\n'
      );

      const result = await validatePackage(pkg);

      expect(result.ok).toBe(false);
      expect(result.issues.some((i) => i.code === 'SKILL_INVALID' && i.level === 'error')).toBe(
        true
      );
    });

    // Root ignores file permissions, so this SKIPS in any root container — a
    // green CI Docker run is not evidence this path is covered.
    it.skipIf(process.getuid?.() === 0)(
      'reports an unreadable skills directory as an issue instead of throwing',
      async () => {
        const pkg = await tempDir();
        await writeJson(path.join(pkg, PACKAGE_MANIFEST_PATH), {
          schemaVersion: 1,
          name: 'locked-skills-pkg',
          version: '1.0.0',
          type: 'plugin',
          description: 'A plugin whose skills directory cannot be listed',
          license: 'MIT',
          tags: [],
          layers: ['skills'],
          extensions: [],
        });
        await writeJson(path.join(pkg, CLAUDE_PLUGIN_MANIFEST_PATH), {
          name: 'locked-skills-pkg',
          version: '1.0.0',
          description: 'plugin manifest',
        });

        const skillsDir = path.join(pkg, 'skills');
        await fs.mkdir(path.join(skillsDir, 'inner'), { recursive: true });
        await fs.chmod(skillsDir, 0o000);

        try {
          // A validator returns findings. Throwing here would propagate through
          // scanInstalledPackages and turn the whole installed list into a 500
          // over one unreadable subdirectory — the realistic trigger being a
          // transient, system-wide EMFILE.
          const result = await validatePackage(pkg);

          expect(result.ok).toBe(false);
          expect(
            result.issues.some(
              (i) => i.code === 'SKILL_INVALID' && i.message.includes('Could not read')
            )
          ).toBe(true);
        } finally {
          await fs.chmod(skillsDir, 0o755);
        }
      }
    );
  });

  describe('NAME_DIRECTORY_MISMATCH', () => {
    it('emits a warning (not error) when directory name and manifest name differ', async () => {
      const dir = await tempDir();
      // Directory is "renamed-dir" but manifest.name is "actual-name"
      const pkg = path.join(dir, 'renamed-dir');

      await writeJson(path.join(pkg, PACKAGE_MANIFEST_PATH), {
        schemaVersion: 1,
        name: 'actual-name',
        version: '1.0.0',
        type: 'agent',
        description: 'Mismatched directory name',
        license: 'MIT',
        tags: [],
        layers: [],
      });

      const result = await validatePackage(pkg);

      expect(result.ok).toBe(true);
      const mismatch = result.issues.find((i) => i.code === 'NAME_DIRECTORY_MISMATCH');
      expect(mismatch).toBeDefined();
      expect(mismatch?.level).toBe('warning');
      expect(mismatch?.message).toContain('renamed-dir');
      expect(mismatch?.message).toContain('actual-name');
    });
  });

  describe('CATEGORY_MISSING', () => {
    it('warns (not errors) when a package declares no category at all', async () => {
      const dir = await tempDir();
      const pkg = path.join(dir, 'uncategorized');
      await writeJson(path.join(pkg, PACKAGE_MANIFEST_PATH), {
        schemaVersion: 1,
        name: 'uncategorized',
        version: '1.0.0',
        type: 'agent',
        description: 'A package with no category',
        license: 'MIT',
        tags: [],
        layers: [],
      });

      const result = await validatePackage(pkg);

      expect(result.ok).toBe(true);
      const warning = result.issues.find((i) => i.code === 'CATEGORY_MISSING');
      expect(warning).toBeDefined();
      expect(warning?.level).toBe('warning');
    });

    it('does not warn when the package declares categories', async () => {
      const dir = await tempDir();
      const pkg = path.join(dir, 'categorized');
      await writeJson(path.join(pkg, PACKAGE_MANIFEST_PATH), {
        schemaVersion: 1,
        name: 'categorized',
        version: '1.0.0',
        type: 'agent',
        description: 'A package with categories',
        license: 'MIT',
        tags: [],
        categories: ['security'],
        layers: [],
      });

      const result = await validatePackage(pkg);

      expect(result.ok).toBe(true);
      expect(result.issues.some((i) => i.code === 'CATEGORY_MISSING')).toBe(false);
    });

    it('rejects an off-list entry inside categories[] as MANIFEST_SCHEMA_INVALID', async () => {
      const dir = await tempDir();
      const pkg = path.join(dir, 'bad-category');
      await writeJson(path.join(pkg, PACKAGE_MANIFEST_PATH), {
        schemaVersion: 1,
        name: 'bad-category',
        version: '1.0.0',
        type: 'agent',
        description: 'A package with an off-list category',
        license: 'MIT',
        tags: [],
        categories: ['not-a-cat'],
        layers: [],
      });

      const result = await validatePackage(pkg);

      expect(result.ok).toBe(false);
      expect(result.issues.some((i) => i.code === 'MANIFEST_SCHEMA_INVALID')).toBe(true);
    });

    it('still accepts a legacy free-string singular-only category (harness regression guard)', async () => {
      const dir = await tempDir();
      const pkg = path.join(dir, 'legacy-category');
      await writeJson(path.join(pkg, PACKAGE_MANIFEST_PATH), {
        schemaVersion: 1,
        name: 'legacy-category',
        version: '1.0.0',
        type: 'agent',
        description: 'A package with a legacy free-string category',
        license: 'MIT',
        tags: [],
        category: 'workflow',
        layers: [],
      });

      const result = await validatePackage(pkg);

      expect(result.ok).toBe(true);
      // A declared (even legacy) category suppresses the CATEGORY_MISSING nudge.
      expect(result.issues.some((i) => i.code === 'CATEGORY_MISSING')).toBe(false);
    });
  });

  describe('valid fixtures', () => {
    const validFixtures = [
      'valid-plugin',
      'valid-agent',
      'valid-skill-pack',
      'valid-adapter',
    ] as const;

    it.each(validFixtures)('passes validation: %s', async (name) => {
      const result = await validatePackage(path.join(FIXTURES_DIR, name));

      expect(result.ok).toBe(true);
      expect(result.issues.filter((i) => i.level === 'error')).toEqual([]);
      expect(result.manifest).toBeDefined();
      expect(result.manifest?.name).toBe(name);
    });
  });
});

describe('declared schedules (DOR-1487)', () => {
  const tempDirs: string[] = [];

  afterEach(async () => {
    while (tempDirs.length > 0) {
      const dir = tempDirs.pop();
      if (dir) await fs.rm(dir, { recursive: true, force: true });
    }
  });

  /** A plugin package on disk with the given schedules and shipped skills. */
  async function makeScheduledPackage(
    schedules: Record<string, unknown>[],
    skills: string[] = []
  ): Promise<string> {
    const dir = await makeTempDir();
    tempDirs.push(dir);
    const pkgRoot = path.join(dir, 'sched-pkg');
    await writeJson(path.join(pkgRoot, PACKAGE_MANIFEST_PATH), {
      schemaVersion: 1,
      name: 'sched-pkg',
      version: '1.0.0',
      type: 'plugin',
      description: 'Ships schedules.',
      category: 'productivity',
      schedules,
    });
    await writeJson(path.join(pkgRoot, CLAUDE_PLUGIN_MANIFEST_PATH), {
      name: 'sched-pkg',
      version: '1.0.0',
    });
    for (const skill of skills) {
      await writeText(
        path.join(pkgRoot, skill, 'SKILL.md'),
        `---\nname: ${path.basename(skill)}\ndescription: A shipped skill.\n---\n\nBody.\n`
      );
    }
    return pkgRoot;
  }

  it('rejects a skillRef naming a skill the package does not ship', async () => {
    const pkgRoot = await makeScheduledPackage([{ skillRef: 'never-shipped' }]);

    const result = await validatePackage(pkgRoot);

    expect(result.ok).toBe(false);
    const issue = result.issues.find((i) => i.code === 'SCHEDULE_SKILL_MISSING');
    expect(issue?.level).toBe('error');
    expect(issue?.message).toContain('never-shipped');
  });

  it('accepts a skillRef the package ships', async () => {
    const pkgRoot = await makeScheduledPackage(
      [{ skillRef: 'daily-report' }],
      ['skills/daily-report']
    );

    const result = await validatePackage(pkgRoot);

    expect(result.issues.some((i) => i.code === 'SCHEDULE_SKILL_MISSING')).toBe(false);
  });

  it('accepts a skillRef nested below the skills root, as the installer does', async () => {
    // A publish-time check stricter than the install-time one would reject a
    // package that installs perfectly well.
    const pkgRoot = await makeScheduledPackage([{ skillRef: 'nested' }], ['skills/group/nested']);

    const result = await validatePackage(pkgRoot);

    expect(result.issues.some((i) => i.code === 'SCHEDULE_SKILL_MISSING')).toBe(false);
  });

  it('rejects a directory of the right name with no SKILL.md', async () => {
    const dir = await makeTempDir();
    tempDirs.push(dir);
    const pkgRoot = path.join(dir, 'sched-pkg');
    await writeJson(path.join(pkgRoot, PACKAGE_MANIFEST_PATH), {
      schemaVersion: 1,
      name: 'sched-pkg',
      version: '1.0.0',
      type: 'plugin',
      description: 'Ships schedules.',
      category: 'productivity',
      schedules: [{ skillRef: 'hollow' }],
    });
    await writeJson(path.join(pkgRoot, CLAUDE_PLUGIN_MANIFEST_PATH), {
      name: 'sched-pkg',
      version: '1.0.0',
    });
    await fs.mkdir(path.join(pkgRoot, 'skills', 'hollow'), { recursive: true });

    const result = await validatePackage(pkgRoot);

    expect(result.issues.some((i) => i.code === 'SCHEDULE_SKILL_MISSING')).toBe(true);
  });

  it('does not accept a skill that only exists in a task directory', async () => {
    // The installer's resolver does not look in task directories, so accepting
    // one here would pass a package whose schedule then fails to materialize
    // after install — a report the author never gets. Publish-time and
    // install-time must accept the same set.
    const pkgRoot = await makeScheduledPackage(
      [{ skillRef: 'legacy-task' }],
      ['tasks/legacy-task']
    );

    const result = await validatePackage(pkgRoot);

    expect(result.issues.some((i) => i.code === 'SCHEDULE_SKILL_MISSING')).toBe(true);
  });

  it('says nothing about an inline schedule, which references no skill', async () => {
    const pkgRoot = await makeScheduledPackage([
      { name: 'nightly', description: 'Runs nightly.', prompt: 'Go.', cron: '0 3 * * *' },
    ]);

    const result = await validatePackage(pkgRoot);

    expect(result.issues.some((i) => i.code === 'SCHEDULE_SKILL_MISSING')).toBe(false);
  });
});
