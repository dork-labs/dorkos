/** Fresh canonical resources for a single turn; no vendor projection or retained grants. */
import path from 'node:path';
import { readdir, stat } from 'node:fs/promises';
import {
  LocalResources,
  canonicalPath,
  type PathPolicy,
  type Resources,
  type SkillMetadata,
  type SkillRoot,
} from '@dorkos/doe';
import { scanInstalledPlugins, rewritePluginTokens } from '@dorkos/harness';
import { OPERATING_SKILLS_PACK } from '@dorkos/operating-skills';
import type { DirectoryGrant } from '@dorkos/shared/agent-runtime';
import { assertValidDirectoryGrants } from '@dorkos/shared/directory-grants';
import { resolveDorkHome } from '../../../lib/dork-home.js';
import { agentsUserSkillsDir } from '../../harness/agents-user-home.js';
import type { AgentHome } from '../../core/agent-identity/index.js';
/** Canonical home and turn grants are distinct from the current working folder. */
export interface DoeResourceOptions {
  cwd: string;
  agentPath?: AgentHome;
  additionalDirectories?: readonly DirectoryGrant[];
  context?: string;
  userSkillsDir?: string;
  dorkHome?: string;
}
/** Enumerate ancestry root-first without granting unrestricted ancestor file access. */
export function doeAncestors(cwd: string): string[] {
  const ancestors = [cwd];
  while (path.dirname(ancestors[0]!) !== ancestors[0])
    ancestors.unshift(path.dirname(ancestors[0]!));
  return ancestors;
}
/** Read canonical authored and installed sources, preserving namespaced plugin identity. */
export async function assembleDoeResources(
  options: DoeResourceOptions
): Promise<{ resources: Resources; pathPolicy: PathPolicy }> {
  const cwd = await canonicalPath(options.cwd, options.cwd);
  const grants = options.additionalDirectories ?? [];
  assertValidDirectoryGrants(grants, cwd);
  const ancestors = doeAncestors(cwd);
  const authoredRoots: SkillRoot[] = [
    { path: path.join(cwd, '.agents/skills') },
    { path: options.userSkillsDir ?? agentsUserSkillsDir() },
    ...(options.agentPath ? [{ path: path.join(options.agentPath, '.agents/skills') }] : []),
  ];
  const skillRoots: SkillRoot[] = [];
  for (const root of authoredRoots) {
    try {
      for (const entry of await readdir(root.path, { withFileTypes: true })) {
        // Harness vendor projections have pkg__skill names; direct install sources below own these.
        if (entry.name.startsWith('.') || entry.name.includes('__')) continue;
        skillRoots.push({ path: path.join(root.path, entry.name) });
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  }
  const pluginRoots = new Map<string, string>();
  for (const plugin of scanInstalledPlugins({
    projectRoot: cwd,
    dorkHome: options.dorkHome ?? resolveDorkHome(),
  })) {
    const root =
      plugin.location.scope === 'project'
        ? path.join(cwd, plugin.location.relDir)
        : plugin.location.absDir;
    for (const skill of plugin.skills) {
      const source =
        plugin.location.scope === 'project' ? path.join(cwd, skill.sourceDir) : skill.sourceDir;
      skillRoots.push({ path: source, namespace: plugin.name });
      pluginRoots.set(source, root);
    }
  }
  const declaredReadRoots = [
    cwd,
    ...grants.map((grant) => grant.path),
    ...authoredRoots.map((root) => root.path),
    ...skillRoots.map((root) => root.path),
    ...ancestors.map((ancestor) => path.join(ancestor, 'AGENTS.md')),
    ...(options.agentPath ? [path.join(options.agentPath, 'AGENTS.md')] : []),
  ];
  // Keep every explicit grant, including future folders; optional missing discovery roots add no authority.
  const readRoots: string[] = [];
  for (const root of declaredReadRoots) {
    if (root === cwd || grants.some((grant) => grant.path === root)) {
      readRoots.push(root);
      continue;
    }
    try {
      await stat(root);
      readRoots.push(root);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  }
  const pathPolicy: PathPolicy = {
    readRoots,
    writeRoots: [
      cwd,
      ...grants.filter((grant) => grant.access === 'write').map((grant) => grant.path),
    ],
  };
  // SOUL and MemoryProvider are already rendered once by buildAgentContextAppend.
  const local = new LocalResources(
    { ancestorDirectories: ancestors, skillRoots, context: options.context },
    pathPolicy,
    cwd
  );
  const own =
    options.agentPath && options.agentPath !== cwd
      ? new LocalResources(
          { ancestorDirectories: [options.agentPath], skillRoots: [] },
          pathPolicy,
          cwd
        )
      : undefined;
  const catalogue = async (): Promise<readonly SkillMetadata[]> => {
    const authored = await local.skills();
    const names = new Set(authored.map((skill) => skill.name));
    return [
      ...authored,
      ...OPERATING_SKILLS_PACK.filter((skill) => !names.has(skill.name)).map((skill) => ({
        name: skill.name,
        description: skill.description,
        location: `dorkos-operating:${skill.name}`,
        disableModelInvocation: false,
      })),
    ];
  };
  const resources: Resources = {
    skills: catalogue,
    load: async () => {
      const fallback = (await catalogue()).filter((skill) =>
        skill.location.startsWith('dorkos-operating:')
      );
      return [
        await local.load(),
        own ? await own.load() : '',
        fallback.length
          ? `<available_operating_skills>\n${fallback.map((skill) => `${skill.name}: ${skill.description}`).join('\n')}\nLoad full instructions with load_skill.\n</available_operating_skills>`
          : '',
      ]
        .filter(Boolean)
        .join('\n\n');
    },
    beforeFile: (file, signal) => local.beforeFile(file, signal),
    loadSkill: async (name, signal) => {
      signal.throwIfAborted();
      const metadata = (await catalogue()).find((skill) => skill.name === name);
      if (!metadata) throw new Error('Unknown skill');
      if (metadata.location.startsWith('dorkos-operating:'))
        return OPERATING_SKILLS_PACK.find((skill) => skill.name === name)!.body;
      const body = await local.loadSkill(name, signal);
      const pluginRoot = pluginRoots.get(path.dirname(metadata.location));
      // Portable direct reads resolve the install root, never a vendor activation folder.
      return pluginRoot ? rewritePluginTokens(body, pluginRoot) : body;
    },
  };
  return { resources, pathPolicy };
}
