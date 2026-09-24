import { describe, it, expect, afterEach } from 'vitest';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';

import { PACKAGE_TEXT_MAX_BYTES } from '@dorkos/shared/bounded-read';
import { PACKAGE_SIZE_LIMITS } from '../package-size.js';
import { readDeclaredVersion, validatePackage } from '../package-validator.js';
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

  describe('VERSION_MISMATCH', () => {
    /** A plugin package whose manifest says `manifestVersion`; plugin.json as given (raw). */
    async function makeVersionedPackage(manifestVersion: string, pluginJson: string | null) {
      const dir = await tempDir();
      const pkg = path.join(dir, 'versioned');
      await writeJson(path.join(pkg, PACKAGE_MANIFEST_PATH), {
        schemaVersion: 1,
        name: 'versioned',
        version: manifestVersion,
        type: 'plugin',
        description: 'A plugin with two version files',
        category: 'productivity',
      });
      if (pluginJson !== null) {
        await writeText(path.join(pkg, CLAUDE_PLUGIN_MANIFEST_PATH), pluginJson);
      }
      return pkg;
    }

    it('fails when plugin.json states a different version than the manifest', async () => {
      // Purpose: flow shipped manifest 0.6.0 beside plugin.json 0.7.2, so DorkOS
      // and Claude Code reported different versions of one install. That must
      // not publish or install.
      const pkg = await makeVersionedPackage(
        '0.6.0',
        JSON.stringify({ name: 'versioned', version: '0.7.2' })
      );

      const result = await validatePackage(pkg);

      expect(result.ok).toBe(false);
      const mismatches = result.issues.filter((i) => i.code === 'VERSION_MISMATCH');
      expect(mismatches).toEqual([
        {
          level: 'error',
          code: 'VERSION_MISMATCH',
          message:
            '.dork/manifest.json says version 0.6.0 but .claude-plugin/plugin.json says 0.7.2. ' +
            'Set both to the same version: Claude Code loads 0.7.2, DorkOS would report 0.6.0.',
          path: CLAUDE_PLUGIN_MANIFEST_PATH,
        },
      ]);
    });

    it('fails when plugin.json declares no version beside a versioned manifest', async () => {
      // Purpose: Claude Code would fall back to the entry or the commit while
      // DorkOS reports the manifest's version — the same disagreement.
      const pkg = await makeVersionedPackage('1.0.0', JSON.stringify({ name: 'versioned' }));

      const result = await validatePackage(pkg);

      expect(result.ok).toBe(false);
      expect(result.issues.filter((i) => i.code === 'VERSION_MISMATCH')).toEqual([
        {
          level: 'error',
          code: 'VERSION_MISMATCH',
          message:
            '.dork/manifest.json says version 1.0.0 but .claude-plugin/plugin.json has no version. ' +
            'Add "version": "1.0.0" to plugin.json so Claude Code and DorkOS agree.',
          path: CLAUDE_PLUGIN_MANIFEST_PATH,
        },
      ]);
    });

    it('says nothing when the two files agree', async () => {
      // Purpose: the check must not fire on the ordinary, correct package.
      const pkg = await makeVersionedPackage(
        '1.0.0',
        JSON.stringify({ name: 'versioned', version: '1.0.0' })
      );

      const result = await validatePackage(pkg);

      expect(result.issues.some((i) => i.code === 'VERSION_MISMATCH')).toBe(false);
      expect(result.ok).toBe(true);
    });

    it('says nothing for a manifest-only agent package', async () => {
      // Purpose: an agent needs no plugin.json, so there is nothing to disagree with.
      const result = await validatePackage(path.join(FIXTURES_DIR, 'valid-agent'));

      expect(result.issues.some((i) => i.code === 'VERSION_MISMATCH')).toBe(false);
    });

    it('leaves an unparseable plugin.json to its existing handling', async () => {
      // Purpose: a broken plugin.json is not a version disagreement; reporting
      // one would bury the real problem under a misleading message.
      const pkg = await makeVersionedPackage('1.0.0', '{ not json');

      const result = await validatePackage(pkg);

      expect(result.issues.some((i) => i.code === 'VERSION_MISMATCH')).toBe(false);
    });

    it('reports declaredVersion on a failed result', async () => {
      // Purpose: the update check reads the version of a tree that does not
      // validate; the result must still carry it.
      const pkg = await makeVersionedPackage(
        '0.6.0',
        JSON.stringify({ name: 'versioned', version: '0.7.2' })
      );
      expect((await validatePackage(pkg)).declaredVersion).toBe('0.7.2');

      const dir = await tempDir();
      const invalid = path.join(dir, 'schema-invalid');
      await writeJson(path.join(invalid, PACKAGE_MANIFEST_PATH), {
        schemaVersion: 1,
        name: 'schema-invalid',
        version: '2.0.0',
      });
      const invalidResult = await validatePackage(invalid);
      expect(invalidResult.ok).toBe(false);
      expect(invalidResult.issues.some((i) => i.code === 'MANIFEST_SCHEMA_INVALID')).toBe(true);
      expect(invalidResult.declaredVersion).toBe('2.0.0');
    });

    it('keeps "declares no version" apart from a real 0.0.0 for Claude-Code-only packages', async () => {
      // Purpose: the synthesized manifest must say 0.0.0 (the schema requires a
      // version), but that placeholder must never be reported as the package's.
      const dir = await tempDir();
      const none = path.join(dir, 'cc-none');
      await writeJson(path.join(none, CLAUDE_PLUGIN_MANIFEST_PATH), { name: 'cc-none' });
      const noneResult = await validatePackage(none);
      expect(noneResult.ok).toBe(true);
      expect(noneResult.manifest?.version).toBe('0.0.0');
      expect(noneResult.declaredVersion).toBeUndefined();

      const zero = path.join(dir, 'cc-zero');
      await writeJson(path.join(zero, CLAUDE_PLUGIN_MANIFEST_PATH), {
        name: 'cc-zero',
        version: '0.0.0',
      });
      expect((await validatePackage(zero)).declaredVersion).toBe('0.0.0');
    });
  });

  describe('USER_EDITABLE_EFFECT_PATH (DOR-2245 delta review 2)', () => {
    async function writePlugin(pkg: string, userEditable: string[], pluginJson: object) {
      await writeJson(path.join(pkg, PACKAGE_MANIFEST_PATH), {
        schemaVersion: 1,
        name: path.basename(pkg),
        version: '1.0.0',
        type: 'plugin',
        description: 'A plugin used to test userEditable against declared paths',
        license: 'MIT',
        userEditable,
      });
      await writeJson(path.join(pkg, '.claude-plugin', 'plugin.json'), {
        name: path.basename(pkg),
        version: '1.0.0',
        ...pluginJson,
      });
    }

    // Purpose: plugin.json can move hooks, servers and commands anywhere; a
    // userEditable entry reaching a path it declares is refused like a default.
    it.each([
      [{ hooks: './custom/hooks.json' }, 'custom/**'],
      [{ mcpServers: './servers.json' }, 'servers.json'],
      [{ commands: ['./cmds'] }, 'cmds/**'],
      [{ skills: './my-skills' }, 'my-skills/a/SKILL.md'],
      [{ experimental: { monitors: './watch/m.json' } }, 'watch/**'],
      [{ agents: ['./subagents'] }, 'subagents/**'],
      [{ outputStyles: './styles' }, 'styles/terse.md'],
    ])(
      'refuses userEditable reaching a path plugin.json declares (%j)',
      async (pluginJson, pattern) => {
        const pkg = path.join(await tempDir(), 'declared');
        await writePlugin(pkg, [pattern], pluginJson);

        const result = await validatePackage(pkg);

        expect(result.issues.filter((i) => i.code === 'USER_EDITABLE_EFFECT_PATH')).toHaveLength(1);
        expect(result.ok).toBe(false);
      }
    );

    // Purpose: an editable path beside the declared ones stays allowed.
    it('allows userEditable that reaches none of the declared paths', async () => {
      const pkg = path.join(await tempDir(), 'fine');
      await writePlugin(pkg, ['config/**'], { hooks: './custom/hooks.json' });

      const result = await validatePackage(pkg);

      expect(result.issues.filter((i) => i.code === 'USER_EDITABLE_EFFECT_PATH')).toEqual([]);
    });
  });

  describe('RESERVED_PATH_SHIPPED (DOR-2245)', () => {
    async function writeAgent(pkg: string): Promise<void> {
      await writeJson(path.join(pkg, PACKAGE_MANIFEST_PATH), {
        schemaVersion: 1,
        name: path.basename(pkg),
        version: '1.0.0',
        type: 'agent',
        description: 'An agent package used to test reserved paths',
        license: 'MIT',
      });
    }

    // Purpose: every kind of reserved path is refused once, naming the file, so a
    // package can never ship over a person's data or the installer's records.
    it.each([
      '.dork/data/seed.json',
      '.dork/secrets.json',
      '.dork/install-metadata.json',
      '.dork/installed-files.json',
      '.dork/uninstalled-agent.json',
      'notes/readme.md.dork-old',
      'config/defaults.json.dork-new.2',
    ])('refuses a package shipping %s', async (reserved) => {
      const pkg = path.join(await tempDir(), 'reserver');
      await writeAgent(pkg);
      await writeText(path.join(pkg, ...reserved.split('/')), 'x');

      const result = await validatePackage(pkg);

      expect(result.ok).toBe(false);
      const found = result.issues.filter((i) => i.code === 'RESERVED_PATH_SHIPPED');
      expect(found).toHaveLength(1);
      expect(found[0]).toMatchObject({ level: 'error', path: reserved });
    });

    // Purpose (code review 2): on a case-insensitive volume these ARE the
    // reserved paths, so a case variant is refused like the real name.
    it.each(['.dork/Secrets.json', '.dork/Data/seed.json'])(
      'refuses a package shipping the case variant %s',
      async (reserved) => {
        const pkg = path.join(await tempDir(), 'case-reserver');
        await writeAgent(pkg);
        await writeText(path.join(pkg, ...reserved.split('/')), 'x');

        const result = await validatePackage(pkg);

        expect(result.issues.filter((i) => i.code === 'RESERVED_PATH_SHIPPED')).toHaveLength(1);
      }
    );

    // Purpose: near-miss names and anything under node_modules stay allowed.
    it('allows near-miss names and ignores node_modules', async () => {
      const pkg = path.join(await tempDir(), 'nearmiss');
      await writeAgent(pkg);
      await writeText(path.join(pkg, '.dork', 'database.json'), 'x');
      await writeText(path.join(pkg, 'x.dork-older'), 'x');
      await writeText(path.join(pkg, 'node_modules', 'dep', 'notes.md.dork-old'), 'x');

      const result = await validatePackage(pkg);

      expect(result.issues.filter((i) => i.code === 'RESERVED_PATH_SHIPPED')).toEqual([]);
    });

    // Purpose: an INSTALLED root legitimately holds the installer's own records,
    // and the installed scanner validates installed roots; it must not flag them.
    it("does not report the installer's own files when validating an installed tree", async () => {
      const pkg = path.join(await tempDir(), 'installed');
      await writeAgent(pkg);
      await writeText(path.join(pkg, '.dork', 'install-metadata.json'), '{}');
      await writeText(path.join(pkg, '.dork', 'installed-files.json'), '{}');
      await writeText(path.join(pkg, '.dork', 'data', 'state.json'), '{}');

      const result = await validatePackage(pkg, { tree: 'installed' });

      expect(result.issues.filter((i) => i.code === 'RESERVED_PATH_SHIPPED')).toEqual([]);
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

describe('readDeclaredVersion', () => {
  const tempDirs: string[] = [];

  afterEach(async () => {
    while (tempDirs.length > 0) {
      const dir = tempDirs.pop();
      if (dir) await fs.rm(dir, { recursive: true, force: true });
    }
  });

  /** A package root with the given raw file contents (`undefined` = file absent). */
  async function makePackage(files: { manifest?: string; plugin?: string }): Promise<string> {
    const dir = await makeTempDir();
    tempDirs.push(dir);
    if (files.manifest !== undefined) {
      await writeText(path.join(dir, PACKAGE_MANIFEST_PATH), files.manifest);
    }
    if (files.plugin !== undefined) {
      await writeText(path.join(dir, CLAUDE_PLUGIN_MANIFEST_PATH), files.plugin);
    }
    return dir;
  }

  it("reads plugin.json's version when both files agree", async () => {
    // Purpose: the ordinary case reads the one version the package states.
    const dir = await makePackage({
      manifest: JSON.stringify({ version: '1.0.0' }),
      plugin: JSON.stringify({ version: '1.0.0' }),
    });
    expect(await readDeclaredVersion(dir)).toBe('1.0.0');
  });

  it('prefers plugin.json when the two files disagree', async () => {
    // Purpose: flow shipped manifest 0.6.0 beside plugin.json 0.7.2. Claude Code
    // runs 0.7.2, so that is what DorkOS must report for an existing install.
    const dir = await makePackage({
      manifest: JSON.stringify({ version: '0.6.0' }),
      plugin: JSON.stringify({ version: '0.7.2' }),
    });
    expect(await readDeclaredVersion(dir)).toBe('0.7.2');
  });

  it('falls through to the manifest when plugin.json declares no version', async () => {
    // Purpose: a plugin.json without `version` states nothing, so the
    // manifest's version is the package's own statement.
    const dir = await makePackage({
      manifest: JSON.stringify({ version: '2.1.0' }),
      plugin: JSON.stringify({ name: 'x' }),
    });
    expect(await readDeclaredVersion(dir)).toBe('2.1.0');
  });

  it('reads the manifest when there is no plugin.json', async () => {
    // Purpose: agent packages ship only a manifest.
    const dir = await makePackage({ manifest: JSON.stringify({ version: '3.0.0' }) });
    expect(await readDeclaredVersion(dir)).toBe('3.0.0');
  });

  it('returns undefined when neither file exists', async () => {
    // Purpose: "declares none" must stay distinguishable from a real version.
    const dir = await makePackage({});
    expect(await readDeclaredVersion(dir)).toBeUndefined();
  });

  it('falls through an unparseable plugin.json to the manifest, without throwing', async () => {
    // Purpose: installed trees are read without any validity gate; one broken
    // file must not cost the package its version, or throw on the listing path.
    const dir = await makePackage({
      manifest: JSON.stringify({ version: '1.4.0' }),
      plugin: '{ not json',
    });
    expect(await readDeclaredVersion(dir)).toBe('1.4.0');
  });

  it('returns undefined when both files are unparseable or declare a non-string version', async () => {
    // Purpose: garbage is "declares none", never a thrown error or a bogus string.
    const broken = await makePackage({ manifest: '[', plugin: 'nope' });
    expect(await readDeclaredVersion(broken)).toBeUndefined();
    const nonString = await makePackage({
      manifest: JSON.stringify({ version: 1 }),
      plugin: JSON.stringify({ version: '' }),
    });
    expect(await readDeclaredVersion(nonString)).toBeUndefined();
  });

  it('never throws for a path that does not exist', async () => {
    // Purpose: the function is documented total; callers rely on that.
    await expect(readDeclaredVersion('/definitely/not/here')).resolves.toBeUndefined();
  });
});

describe('package files larger than DorkOS reads (DOR-2319)', () => {
  const dirs: string[] = [];
  afterEach(async () => {
    for (const d of dirs.splice(0)) await fs.rm(d, { recursive: true, force: true });
  });

  /** A skill-pack package, with one file replaced by `oversized`. */
  async function packageWith(oversized: string): Promise<string> {
    const dir = await makeTempDir();
    dirs.push(dir);
    await writeJson(path.join(dir, '.dork', 'manifest.json'), {
      schemaVersion: 1,
      name: path.basename(dir),
      version: '1.0.0',
      type: 'skill-pack',
      description: 'x',
      license: 'MIT',
      tags: [],
      layers: ['skills'],
    });
    await writeJson(path.join(dir, '.claude-plugin', 'plugin.json'), {
      name: path.basename(dir),
      version: '1.0.0',
    });
    await writeText(
      path.join(dir, 'skills', 'a', 'SKILL.md'),
      '---\nname: a\ndescription: x\n---\nbody\n'
    );
    await writeText(path.join(dir, oversized), ' '.repeat(PACKAGE_TEXT_MAX_BYTES + 1));
    return dir;
  }

  // Purpose: an oversized manifest is refused by name, never mistaken for a
  // missing one (which would fall back to plugin.json and pass).
  it.each(['.dork/manifest.json', '.claude-plugin/plugin.json', 'skills/a/SKILL.md'])(
    'refuses a %s larger than the limit, by name',
    async (file) => {
      const result = await validatePackage(await packageWith(file));
      expect(result.ok).toBe(false);
      expect(result.issues.map((i) => i.message).join('\n')).toMatch(/larger than 1 MB/);
      expect(result.issues.some((i) => i.path === file)).toBe(true);
    }
  );
});

describe('symbolic links in a package (DOR-2319)', () => {
  const SECRET = 'host-secret-9c21';
  const dirs: string[] = [];
  afterEach(async () => {
    for (const d of dirs.splice(0)) await fs.rm(d, { recursive: true, force: true });
  });

  /** A valid skill-pack package plus a host file that must never be read. */
  async function packageAndHostFile(): Promise<{ pkg: string; host: string }> {
    const root = await makeTempDir();
    dirs.push(root);
    const pkg = path.join(root, 'pkg');
    const host = path.join(root, 'host-secret');
    await writeText(host, `---\nname: ${SECRET}\nversion: ${SECRET}\n---\n`);
    await writeJson(path.join(pkg, '.dork', 'manifest.json'), {
      schemaVersion: 1,
      name: 'pkg',
      version: '1.0.0',
      type: 'skill-pack',
      description: 'x',
      license: 'MIT',
      tags: [],
      layers: ['skills'],
    });
    await writeJson(path.join(pkg, '.claude-plugin', 'plugin.json'), {
      name: 'pkg',
      version: '1.0.0',
    });
    await writeText(
      path.join(pkg, 'skills', 'a', 'SKILL.md'),
      '---\nname: a\ndescription: x\n---\nbody\n'
    );
    return { pkg, host };
  }

  // Purpose: a package cannot point the validator at a host file. Each link is
  // refused by name, the host file's text appears nowhere in the result, and a
  // linked manifest is never mistaken for a missing one.
  it.each([
    ['a SKILL.md', 'skills/a/SKILL.md'],
    ['the manifest', '.dork/manifest.json'],
    ['plugin.json', '.claude-plugin/plugin.json'],
  ])('refuses %s that is a symbolic link to a host file', async (_label, rel) => {
    const { pkg, host } = await packageAndHostFile();
    await fs.rm(path.join(pkg, rel));
    await fs.symlink(host, path.join(pkg, rel));
    const result = await validatePackage(pkg);
    expect(result.ok).toBe(false);
    expect(result.issues.some((i) => i.path === rel && /symbolic link/.test(i.message))).toBe(true);
    expect(JSON.stringify(result)).not.toContain(SECRET);
  });

  // Purpose: a skill directory that is itself a link out of the package is
  // never read, and the person is told it will not be installed.
  it('skips a skills directory that is a symbolic link, with a warning', async () => {
    const { pkg, host } = await packageAndHostFile();
    const elsewhere = path.join(path.dirname(host), 'elsewhere');
    await writeText(path.join(elsewhere, 'a', 'SKILL.md'), `---\nname: ${SECRET}\n---\n`);
    await fs.rm(path.join(pkg, 'skills'), { recursive: true });
    await fs.symlink(elsewhere, path.join(pkg, 'skills'));
    const result = await validatePackage(pkg);
    expect(result.issues).toContainEqual({
      level: 'warning',
      code: 'LINK_SKIPPED',
      message: "skills is a shortcut to a folder outside the package, so it won't be installed.",
      path: 'skills',
    });
    expect(JSON.stringify(result)).not.toContain(SECRET);
  });

  // Purpose: a linked skill folder inside a real skills directory (as some
  // official plugins ship) is named in a warning, not dropped silently.
  it('warns about a linked skill folder', async () => {
    const { pkg, host } = await packageAndHostFile();
    const shared = path.join(path.dirname(host), 'shared', 'neon-postgres');
    await writeText(
      path.join(shared, 'SKILL.md'),
      '---\nname: neon-postgres\ndescription: x\n---\n'
    );
    await fs.symlink(shared, path.join(pkg, 'skills', 'neon-postgres'));
    const result = await validatePackage(pkg);
    expect(result.ok).toBe(true);
    expect(result.issues).toContainEqual({
      level: 'warning',
      code: 'LINK_SKIPPED',
      message:
        "skills/neon-postgres is a shortcut to a folder outside the package, so it won't be installed.",
      path: 'skills/neon-postgres',
    });
  });
});

describe('package size (DOR-2321)', () => {
  // Purpose: a package larger than DorkOS installs is refused by the validator,
  // so the install preview says so before anything is copied.
  it('refuses a package with a file over the per-file limit', async () => {
    const dir = await makeTempDir();
    try {
      await writeJson(path.join(dir, '.dork', 'manifest.json'), {
        schemaVersion: 1,
        name: path.basename(dir),
        version: '1.0.0',
        type: 'skill-pack',
        description: 'x',
        license: 'MIT',
        tags: [],
        layers: ['skills'],
      });
      await writeText(path.join(dir, 'assets', 'big.bin'), '');
      await fs.truncate(path.join(dir, 'assets', 'big.bin'), PACKAGE_SIZE_LIMITS.maxFileBytes + 1);
      const result = await validatePackage(dir);
      expect(result.ok).toBe(false);
      expect(result.issues).toContainEqual({
        level: 'error',
        code: 'PACKAGE_TOO_LARGE',
        message:
          'assets/big.bin is larger than 50 MB, which is more than DorkOS installs from one file.',
        path: 'assets/big.bin',
      });
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });
});
