/**
 * Journey J-15 — parity between a DorkOS-managed Codex session and a bare
 * `codex` run in the same repo.
 *
 * ADR 260706-192819 promises one thing above every projection rule: the
 * external CLI and the DorkOS-managed session see the same thing. Codex reads
 * `.agents/skills` off disk, following symlinks, so whatever is in that
 * directory is what a bare `codex` offers. DorkOS has two readers that exist
 * only to mirror it — the Codex slash palette (`scan-skill-commands.ts`) and
 * the `dorkos://skills` MCP resource — and until DOR-1844 both were blind to
 * every installed plugin skill and every symlinked authored skill, because the
 * shared scanner kept only real directories and dropped every `__` name.
 *
 * So this test stages a real repo, runs the REAL `project()` + `applyPlan()`
 * from `@dorkos/harness` to put the plugin projections on disk, and then holds
 * both readers against what a bare `codex` read would enumerate — each minus
 * only the invocation filter it documents, so the assertion proves parity
 * rather than being satisfiable by echoing the directory listing back.
 *
 * @vitest-environment node
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  rmSync,
  readdirSync,
  readFileSync,
  existsSync,
  statSync,
  symlinkSync,
  type Stats,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { ReadResourceResult } from '@modelcontextprotocol/sdk/types.js';
import { project, applyPlan } from '@dorkos/harness';
import { scanSkillCommands } from '../scan-skill-commands.js';
import { registerSkillResources } from '../../../core/mcp-resources/skill-resources.js';

/** One entry of `.agents/skills` as Codex would see it. */
interface CodexSkill {
  /** The directory entry name — what is physically in `.agents/skills`. */
  dir: string;
  /** The `SKILL.md` frontmatter `name`, which is Codex's identity for the skill. */
  name: string;
}

/**
 * What a bare `codex` run finds in `.agents/skills`: every entry that resolves
 * to a directory holding a `SKILL.md`, symlinks followed, keyed by frontmatter
 * `name`.
 *
 * Deliberately hand-rolled and local to this file rather than reusing the
 * engine's scanner: this is the independent yardstick the DorkOS readers are
 * measured against, and a yardstick built from the code under test measures
 * nothing. It also does NOT de-duplicate by `name` — Codex keys a skill by its
 * frontmatter name, and two entries sharing one both reach it.
 *
 * DOR-1846 owns the shared reader; this stays a test-local helper.
 */
function readAgentsSkillsAsCodexWould(root: string): CodexSkill[] {
  const skillsRoot = join(root, '.agents', 'skills');
  if (!existsSync(skillsRoot)) return [];
  const found: CodexSkill[] = [];
  for (const entry of readdirSync(skillsRoot)) {
    const abs = join(skillsRoot, entry);
    let stats: Stats;
    try {
      stats = statSync(abs); // statSync follows symlinks, as Codex does
    } catch {
      continue; // dangling link — nothing to read
    }
    if (!stats.isDirectory()) continue;
    const skillMd = join(abs, 'SKILL.md');
    if (!existsSync(skillMd)) continue;
    const frontmatter = /^---\r?\n([\s\S]*?)\r?\n---/.exec(readFileSync(skillMd, 'utf8'))?.[1];
    const declared = frontmatter ? /^name:[ \t]*(.+)$/m.exec(frontmatter)?.[1].trim() : undefined;
    found.push({ dir: entry, name: declared ?? entry });
  }
  return found.sort((a, b) => a.dir.localeCompare(b.dir));
}

/**
 * Write a `SKILL.md` under `dir`, creating the directory. Extra frontmatter
 * lines (e.g. `user-invocable: false`) are appended verbatim.
 */
function writeSkillMd(dir: string, name: string, description: string, extraFrontmatter = ''): void {
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, 'SKILL.md'),
    `---\nname: ${name}\ndescription: ${description}\n${extraFrontmatter}---\n\n# ${name}\n\nBody of ${name}.\n`,
    'utf-8'
  );
}

/**
 * Stage a repo the way a real one looks after `dorkos harness sync`: two plain
 * authored skill directories, a third authored skill whose source is a symlink
 * into a folder outside `.agents/`, one project-scoped marketplace plugin
 * carrying two skills of its own, and one skill for each reader's own
 * documented filter — so an assertion cannot pass by echoing the raw directory
 * listing back.
 */
function stageRepo(): string {
  const root = mkdtempSync(join(tmpdir(), 'codex-parity-'));

  mkdirSync(join(root, '.agents'), { recursive: true });
  writeFileSync(
    join(root, '.agents', 'harness.manifest.json'),
    JSON.stringify({ version: 1, harnesses: ['claude-code', 'codex'] })
  );
  writeFileSync(join(root, 'AGENTS.md'), '# Project\n');

  writeSkillMd(join(root, '.agents', 'skills', 'deploy'), 'deploy', 'Ship the app');
  writeSkillMd(join(root, '.agents', 'skills', 'analyze'), 'analyze', 'Analyze the codebase');

  // One skill per reader's filter. `user-invocable: false` means "the model may
  // load this, a person should never see it in a `/` menu", so the palette hides
  // it and the model-facing resource keeps it. `disable-model-invocation: true`
  // is the mirror image: person-only, which is exactly what a slash palette is
  // for, so the palette keeps it and the model-facing list omits it.
  writeSkillMd(
    join(root, '.agents', 'skills', 'house-style'),
    'house-style',
    'Background knowledge',
    'user-invocable: false\n'
  );
  writeSkillMd(
    join(root, '.agents', 'skills', 'release-notes'),
    'release-notes',
    'Cut release notes',
    'disable-model-invocation: true\n'
  );

  // The linked authored skill: real directory outside `.agents/`, linked in.
  writeSkillMd(join(root, 'vault', 'notes'), 'notes', 'Take notes in the vault');
  symlinkSync(join('..', '..', 'vault', 'notes'), join(root, '.agents', 'skills', 'notes'));

  const plugin = join(root, '.dork', 'plugins', 'acme');
  mkdirSync(join(plugin, '.dork'), { recursive: true });
  writeFileSync(
    join(plugin, '.dork', 'manifest.json'),
    JSON.stringify({
      schemaVersion: 1,
      name: 'acme',
      version: '1.0.0',
      type: 'plugin',
      description: 'A plugin that ships two skills',
      layers: ['skills'],
    })
  );
  writeSkillMd(join(plugin, 'skills', 'publish'), 'publish', 'Publish a package');
  writeSkillMd(join(plugin, 'skills', 'rollback'), 'rollback', 'Roll a release back');

  return root;
}

/** Decode the single `application/json` text block a resource read returns. */
function jsonBody<T>(result: ReadResourceResult): T {
  const block = result.contents[0];
  if (!block || !('text' in block)) throw new Error('expected one text content block');
  return JSON.parse(block.text) as T;
}

/** A connected client talking to a server that only serves skill resources. */
async function connect(projectDir: string): Promise<Client> {
  const server = new McpServer({ name: 'skill-parity-test', version: '0.0.0' });
  registerSkillResources(server, projectDir);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'skill-parity-test-client', version: '0.0.0' });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return client;
}

/** Read `dorkos://skills` and return the listed skill names. */
async function listedSkillNames(client: Client): Promise<string[]> {
  const payload = jsonBody<{ skills: { name: string }[]; count: number }>(
    await client.readResource({ uri: 'dorkos://skills' })
  );
  expect(payload.count).toBe(payload.skills.length);
  return payload.skills.map((s) => s.name).sort((a, b) => a.localeCompare(b));
}

describe('Codex skill parity (J-15)', () => {
  let root: string;
  let client: Client | undefined;

  beforeEach(() => {
    root = stageRepo();
    const plan = project(root);
    expect(applyPlan(root, plan).conflicts).toEqual([]);
  });

  afterEach(async () => {
    await client?.close();
    client = undefined;
    rmSync(root, { recursive: true, force: true });
  });

  it('J-15, AP-14, SK-14: gives each reader the whole .agents/skills directory, minus only its own documented filter', async () => {
    const asCodexSees = readAgentsSkillsAsCodexWould(root);

    // First: the fixture really is the interesting shape. Two plain authored
    // dirs, one symlinked authored source, two projected plugin skills, and one
    // skill per reader filter — a count, not a lower bound, so a projection that
    // stopped happening reddens here rather than quietly shrinking the subject
    // of every assertion below.
    expect(asCodexSees.map((s) => s.dir)).toEqual([
      'acme__publish',
      'acme__rollback',
      'analyze',
      'deploy',
      'house-style',
      'notes',
      'release-notes',
    ]);

    // The projected plugin skills keep the plugin's own frontmatter `name`,
    // which the `<pkg>__` directory namespacing cannot change. That is why both
    // readers parse with `requireNameMatch: false`, and why neither can key a
    // command off the frontmatter name.
    expect(asCodexSees.find((s) => s.dir === 'acme__publish')?.name).toBe('publish');
    expect(asCodexSees.find((s) => s.dir === 'notes')?.name).toBe('notes');

    const onDisk = asCodexSees.map((s) => s.dir);

    // The palette: everything Codex reads, minus the one skill its author hid
    // from a `/` menu. Nothing else is subtracted — in particular the two
    // `acme__*` projections and the symlinked `notes` are all present, which is
    // the parity claim (DOR-1844 made three of these seven visible).
    expect(scanSkillCommands(root).map((c) => c.command)).toEqual(
      onDisk.filter((d) => d !== 'house-style')
    );

    // The MCP resource: everything Codex reads, minus the one skill its author
    // told the model not to reach for on its own. Different filter, same
    // directory — and `release-notes`, which the palette keeps, is the proof
    // that neither list is just the raw directory echoed back.
    client = await connect(root);
    expect(await listedSkillNames(client)).toEqual(onDisk.filter((d) => d !== 'release-notes'));
  });
});
