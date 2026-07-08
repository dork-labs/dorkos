/**
 * Registers the `dorkos://skills` and `dorkos://skills/{name}` MCP resources
 * against a live `McpServer` instance. Split out of `mcp-server.ts` — see
 * `core-tools.ts` in this directory for why.
 *
 * Both resources are scoped to `deps.defaultCwd` (the server's default
 * project, same scoping convention as the session resources) and read
 * `<cwd>/.agents/skills` — the canonical authored-skill directory both
 * Claude Code (via its `.claude/skills` projection) and Codex/OpenCode read.
 * This mirrors the scan the Codex runtime already performs to build its
 * slash-command palette (`services/runtimes/codex/scan-skill-commands.ts`):
 * `scanSkillDirs` enumerates directories, `parseSkillFile` validates each
 * `SKILL.md` against `SkillFrontmatterSchema`. Unparseable or unreadable
 * skills are skipped rather than failing the whole read.
 *
 * @module services/core/external-mcp/skill-resources
 */
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { ResourceTemplate } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { scanSkillDirs, AGENTS_SKILLS_DIR } from '@dorkos/harness/scan';
import { SkillFrontmatterSchema, SKILL_FILENAME, type SkillFrontmatter } from '@dorkos/skills';
import { parseSkillFile, type ParsedSkill } from '@dorkos/skills/parser';
import type { McpToolDeps } from '../../runtimes/claude-code/mcp-tools/types.js';
import { logger } from '../../../lib/logger.js';
import { jsonResourceContents, resourceNotFound } from './resource-helpers.js';

/**
 * `dorkos://skills` list-entry shape — frontmatter summary only, no body text.
 *
 * `@dorkos/skills` is pinned to zod 3.x while this server is on zod 4.x
 * (two majors coexist in the workspace); `SkillFrontmatterSchema` itself
 * cannot be composed into a v4 `z.object()` field. This wrapper schema only
 * covers plain primitives derived from an already-validated
 * {@link SkillFrontmatter}, so it stays v4-native and reuse-safe.
 */
const SkillSummarySchema = z.object({
  name: z.string(),
  description: z.string(),
  kind: z.string().optional(),
});

/** `dorkos://skills` list payload. */
const SkillListResourceSchema = z.object({
  skills: z.array(SkillSummarySchema),
  count: z.number(),
});

/**
 * `dorkos://skills/{name}` payload — full frontmatter plus the markdown
 * body. `meta` is intentionally typed as `SkillFrontmatter` rather than
 * re-validated with a zod schema (see {@link SkillSummarySchema} on why): it
 * was already validated once, against `SkillFrontmatterSchema`, inside
 * {@link listWorkspaceSkills}.
 */
interface SkillDetailResource {
  name: string;
  meta: SkillFrontmatter;
  body: string;
}

/**
 * Enumerate and parse every authored skill under `<cwd>/.agents/skills`.
 * Mirrors `scanSkillCommands` (`services/runtimes/codex/scan-skill-commands.ts`):
 * a missing directory yields an empty list; an unreadable or invalid
 * `SKILL.md` is logged and skipped rather than failing the whole scan.
 *
 * @param cwd - Absolute project directory whose `.agents/skills` is scanned.
 */
async function listWorkspaceSkills(cwd: string): Promise<ParsedSkill<SkillFrontmatter>[]> {
  const skillsRoot = join(cwd, AGENTS_SKILLS_DIR);
  const skills: ParsedSkill<SkillFrontmatter>[] = [];

  for (const entry of scanSkillDirs(skillsRoot, AGENTS_SKILLS_DIR)) {
    const filePath = join(skillsRoot, entry.name, SKILL_FILENAME);
    try {
      const content = await readFile(filePath, 'utf-8');
      const parsed = parseSkillFile(filePath, content, SkillFrontmatterSchema);
      if (!parsed.ok) {
        logger.debug('[skill-resources] skipping unparseable skill', {
          skill: entry.name,
          error: parsed.error,
        });
        continue;
      }
      skills.push(parsed.definition);
    } catch (err) {
      logger.debug('[skill-resources] skipping unreadable skill', { skill: entry.name, err });
    }
  }

  skills.sort((a, b) => a.name.localeCompare(b.name));
  return skills;
}

/**
 * Register `dorkos://skills` and `dorkos://skills/{name}` against `server`.
 *
 * @param server - The external `McpServer` instance to register resources against.
 * @param deps - Shared MCP tool dependencies.
 */
export function registerSkillResources(server: McpServer, deps: McpToolDeps): void {
  server.registerResource(
    'skills',
    'dorkos://skills',
    {
      title: 'Skills',
      description:
        "Authored skills discovered under .agents/skills in the server's default working " +
        'directory. Name and description only — read dorkos://skills/{name} for the full ' +
        'SKILL.md body.',
      mimeType: 'application/json',
    },
    async () => {
      const skills = await listWorkspaceSkills(deps.defaultCwd);
      return jsonResourceContents(
        'dorkos://skills',
        SkillListResourceSchema.parse({
          skills: skills.map((s) => ({
            name: s.name,
            description: s.meta.description,
            kind: s.meta.kind,
          })),
          count: skills.length,
        })
      );
    }
  );

  server.registerResource(
    'skill',
    // `list: undefined` — `dorkos://skills` above already enumerates every
    // valid name; see the identical rationale on the session template.
    new ResourceTemplate('dorkos://skills/{name}', { list: undefined }),
    {
      title: 'Skill',
      description: 'Full SKILL.md frontmatter and body content for a single skill, by name.',
      mimeType: 'application/json',
    },
    async (uri, { name }) => {
      const skillName = Array.isArray(name) ? name[0]! : name;
      const skills = await listWorkspaceSkills(deps.defaultCwd);
      const skill = skills.find((s) => s.name === skillName);
      if (!skill) resourceNotFound(`Skill not found: ${skillName}`);
      const detail: SkillDetailResource = { name: skill.name, meta: skill.meta, body: skill.body };
      return jsonResourceContents(uri.toString(), detail);
    }
  );
}
