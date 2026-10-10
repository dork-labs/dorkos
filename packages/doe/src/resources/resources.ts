import { open, readdir, stat } from 'node:fs/promises';
import path from 'node:path';
import { constants } from 'node:fs';
import { load as parseYaml } from 'js-yaml';
import type { PathPolicy, ResourceConfig, Resources, SkillMetadata } from '../contracts.js';
import { canonicalPath, CanonicalPaths, contained } from './paths.js';
const MAX_RESOURCE_BYTES = 256 * 1024;
function escapeXml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
async function textFile(file: string, signal?: AbortSignal): Promise<string> {
  signal?.throwIfAborted();
  if (!(await stat(file)).isFile()) throw new Error('Resource must be a regular file');
  const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    if (!(await handle.stat()).isFile()) throw new Error('Resource must be a regular file');
    const buffer = Buffer.alloc(MAX_RESOURCE_BYTES + 1);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    signal?.throwIfAborted();
    if (bytesRead > MAX_RESOURCE_BYTES) throw new Error('Resource exceeds byte limit');
    return buffer.subarray(0, bytesRead).toString('utf8');
  } finally {
    await handle.close();
  }
}
/** Explicit resources with lazy nested instructions and first-root-wins skill discovery. */
export class LocalResources implements Resources {
  private readonly paths: CanonicalPaths;
  private readonly instructions = new Map<string, string>();
  private readonly pending = new Map<string, string>();
  private catalogue?: Promise<readonly SkillMetadata[]>;
  private initial?: Promise<void>;
  /** Bind explicit resource roots and grants; construction performs no IO or network discovery. */
  constructor(
    private readonly config: ResourceConfig,
    policy: PathPolicy,
    private readonly workingDirectory: string
  ) {
    this.paths = new CanonicalPaths(policy, workingDirectory);
  }
  private async instruction(file: string, signal?: AbortSignal): Promise<string> {
    signal?.throwIfAborted();
    try {
      await stat(file);
      const target = await this.paths.resolve(file, 'read');
      if (this.instructions.has(target)) return '';
      const body = await textFile(target, signal);
      const result = `<instructions location="${escapeXml(target)}">\n${body}\n</instructions>`;
      this.instructions.set(target, result);
      this.pending.set(target, result);
      return result;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return '';
      throw error;
    }
  }
  private initialize(): Promise<void> {
    this.initial ??= (async () => {
      const ancestors = await Promise.all(
        this.config.ancestorDirectories.map((directory) =>
          canonicalPath(directory, this.workingDirectory)
        )
      );
      ancestors.sort(
        (a, b) =>
          a.split(path.sep).length - b.split(path.sep).length || (a < b ? -1 : a > b ? 1 : 0)
      );
      for (const directory of ancestors) await this.instruction(path.join(directory, 'AGENTS.md'));
      if (this.config.agentDirectory)
        for (const name of ['AGENTS.md', 'SOUL.md'])
          await this.instruction(path.join(this.config.agentDirectory, name));
      this.pending.clear();
    })();
    return this.initial;
  }
  /** Assemble complete loaded context and acknowledge pending instructions for the next model request. */
  async load(): Promise<string> {
    await this.initialize();
    const skills = (await this.skills()).filter((skill) => !skill.disableModelInvocation);
    const catalogue = skills.length
      ? `<available_skills>\n${skills.map((skill) => `<skill><name>${escapeXml(skill.name)}</name><description>${escapeXml(skill.description)}</description><location>${escapeXml(skill.location)}</location></skill>`).join('\n')}\n</available_skills>\nLoad skill bodies with load_skill. Resolve relative resources beside the skill file. Send script execution to builder.`
      : '';
    this.pending.clear();
    return [
      ...this.instructions.values(),
      this.config.memory ?? '',
      this.config.context ?? '',
      catalogue,
    ]
      .filter(Boolean)
      .join('\n\n');
  }
  /** Load only applicable ancestry; return instructions pending the next load() prompt refresh. */
  async beforeFile(file: string, signal: AbortSignal): Promise<string> {
    signal.throwIfAborted();
    await this.initialize();
    let target: string;
    try {
      target = await this.paths.resolve(file, 'read');
    } catch {
      target = await this.paths.resolve(file, 'write');
    }
    const directories: string[] = [];
    let current = path.dirname(target);
    const bases = await Promise.all(
      this.config.ancestorDirectories.map((directory) =>
        canonicalPath(directory, this.workingDirectory)
      )
    );
    const applicable = bases
      .filter((base) => contained(current, base))
      .sort((a, b) => b.length - a.length);
    const base = applicable[0];
    if (!base) return '';
    while (contained(current, base)) {
      directories.unshift(current);
      if (current === base) break;
      current = path.dirname(current);
    }
    const applicablePaths = new Set<string>();
    for (const directory of directories) {
      const file = path.join(directory, 'AGENTS.md');
      await this.instruction(file, signal);
      applicablePaths.add(await canonicalPath(file, this.workingDirectory));
    }
    return [...this.pending]
      .filter(([file]) => applicablePaths.has(file))
      .map(([, text]) => text)
      .join('\n\n');
  }
  /** Return metadata only; root array priority, sorted traversal and qualified names determine winners. */
  skills(): Promise<readonly SkillMetadata[]> {
    this.catalogue ??= this.discover();
    return this.catalogue;
  }
  private async discover(): Promise<readonly SkillMetadata[]> {
    const result: SkillMetadata[] = [];
    const files = new Set<string>();
    const names = new Set<string>();
    for (const root of this.config.skillRoots) {
      if (root.namespace && !/^[a-zA-Z0-9_-]+$/.test(root.namespace))
        throw new Error('Invalid skill namespace');
      const visited = new Set<string>();
      const visit = async (directory: string): Promise<void> => {
        const canonical = await this.paths.resolve(directory, 'read');
        if (visited.has(canonical)) return;
        visited.add(canonical);
        const entries = (await readdir(canonical, { withFileTypes: true })).sort((a, b) =>
          a.name.localeCompare(b.name, 'en')
        );
        if (entries.some((entry) => entry.name === 'SKILL.md')) {
          const location = await this.paths.resolve(path.join(canonical, 'SKILL.md'), 'read');
          if (files.has(location)) return;
          const raw = await textFile(location);
          const match = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(raw);
          if (!match) throw new Error(`Skill frontmatter missing: ${location}`);
          const metadata = parseYaml(match[1]) as Record<string, unknown> | null;
          if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata))
            throw new Error('Invalid skill metadata');
          const localName =
            typeof metadata.name === 'string' ? metadata.name : path.basename(canonical);
          if (
            !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(localName) ||
            localName.length > 64 ||
            typeof metadata.description !== 'string' ||
            !metadata.description.trim() ||
            metadata.description.length > 1024
          )
            throw new Error(`Invalid skill metadata: ${location}`);
          const name = root.namespace ? `${root.namespace}:${localName}` : localName;
          // A canonical file is consumed at its highest-priority appearance, including name collisions.
          files.add(location);
          if (names.has(name)) return;
          names.add(name);
          result.push({
            name,
            description: metadata.description,
            location,
            disableModelInvocation: metadata['disable-model-invocation'] === true,
          });
          return;
        }
        for (const entry of entries) {
          if (entry.name.startsWith('.') || entry.name === 'node_modules') continue;
          const child = await this.paths.resolve(path.join(canonical, entry.name), 'read');
          if ((await stat(child)).isDirectory()) await visit(child);
        }
      };
      try {
        await visit(root.path);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }
    }
    return result;
  }
  /** Read an invocable skill on demand; disabled skills cannot be activated by a model call. */
  async loadSkill(name: string, signal: AbortSignal): Promise<string> {
    signal.throwIfAborted();
    const skill = (await this.skills()).find((item) => item.name === name);
    if (!skill) throw new Error('Unknown skill');
    if (skill.disableModelInvocation) throw new Error('Skill requires explicit host invocation');
    const location = await this.paths.resolve(skill.location, 'read');
    return `Skill directory: ${path.dirname(location)}\nResolve relative resources here. Send script execution to builder.\n\n${await textFile(location, signal)}`;
  }
  /** Resolve a skill-relative resource within that canonical skill directory and host read grants. */
  async resolveSkillPath(name: string, relativePath: string): Promise<string> {
    const skill = (await this.skills()).find((item) => item.name === name);
    if (!skill) throw new Error('Unknown skill');
    if (path.isAbsolute(relativePath)) throw new Error('Skill resource must be relative');
    const directory = path.dirname(skill.location);
    const target = await this.paths.resolve(`${directory}${path.sep}${relativePath}`, 'read');
    if (!contained(target, directory))
      throw new Error('Access denied: resource outside skill directory');
    return target;
  }
}
