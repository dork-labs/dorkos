/**
 * `dorkos://skills` is a model-facing listing: the agent reads it to learn what
 * skills this project has. A skill marked `disable-model-invocation: true` is
 * one the model must not reach for on its own, so advertising it there is the
 * bug — while a direct read of `dorkos://skills/{name}` must keep working,
 * because naming a skill is a person's explicit reference, not the model
 * inventing the invocation.
 *
 * These tests drive a real `McpServer` over the SDK's in-memory transport
 * against fixture SKILL.md files on disk, so they exercise the wire surface an
 * agent actually sees rather than the helper behind it.
 *
 * @vitest-environment node
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { ReadResourceResult } from '@modelcontextprotocol/sdk/types.js';
import { registerSkillResources } from '../skill-resources.js';

/** Decode the single `application/json` text block a resource read returns. */
function jsonBody<T>(result: ReadResourceResult): T {
  const block = result.contents[0];
  if (!block || !('text' in block)) throw new Error('expected one text content block');
  return JSON.parse(block.text) as T;
}

/**
 * Write a valid `<cwd>/.agents/skills/<name>/SKILL.md`. Extra frontmatter
 * lines (e.g. `disable-model-invocation: true`) are appended verbatim.
 */
async function writeSkill(
  root: string,
  name: string,
  description: string,
  extraFrontmatter = ''
): Promise<void> {
  const dir = path.join(root, '.agents', 'skills', name);
  await mkdir(dir, { recursive: true });
  await writeFile(
    path.join(dir, 'SKILL.md'),
    `---\nname: ${name}\ndescription: ${description}\n${extraFrontmatter}---\n\n# ${name}\n\nBody of ${name}.\n`,
    'utf-8'
  );
}

/** A connected client talking to a server that only serves skill resources. */
async function connect(projectDir: string): Promise<Client> {
  const server = new McpServer({ name: 'skill-resources-test', version: '0.0.0' });
  registerSkillResources(server, projectDir);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'skill-resources-test-client', version: '0.0.0' });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return client;
}

/** Read `dorkos://skills` and return the listed skill names. */
async function listedSkillNames(client: Client): Promise<string[]> {
  const payload = jsonBody<{ skills: { name: string }[]; count: number }>(
    await client.readResource({ uri: 'dorkos://skills' })
  );
  expect(payload.count).toBe(payload.skills.length);
  return payload.skills.map((s) => s.name);
}

describe('dorkos://skills', () => {
  let cwd: string;
  let client: Client;

  beforeEach(async () => {
    cwd = await mkdtemp(path.join(tmpdir(), 'skill-resources-'));
  });

  afterEach(async () => {
    await client.close();
    await rm(cwd, { recursive: true, force: true });
  });

  it('leaves a disable-model-invocation:true skill out of the list', async () => {
    await writeSkill(cwd, 'analyze', 'Analyze the codebase');
    await writeSkill(cwd, 'release', 'Cut a release', 'disable-model-invocation: true\n');
    client = await connect(cwd);

    expect(await listedSkillNames(client)).toEqual(['analyze']);
  });

  it('still resolves a withheld skill by name — naming it is not auto-invocation', async () => {
    await writeSkill(cwd, 'release', 'Cut a release', 'disable-model-invocation: true\n');
    client = await connect(cwd);

    const detail = jsonBody<{
      name: string;
      meta: { description: string; 'disable-model-invocation'?: boolean };
      body: string;
    }>(await client.readResource({ uri: 'dorkos://skills/release' }));
    expect(detail.name).toBe('release');
    expect(detail.meta['disable-model-invocation']).toBe(true);
    expect(detail.body).toContain('Body of release.');
  });

  it('lists a user-invocable:false skill — model-only is what a model listing is for', async () => {
    await writeSkill(cwd, 'house-style', 'Background knowledge', 'user-invocable: false\n');
    client = await connect(cwd);

    expect(await listedSkillNames(client)).toEqual(['house-style']);
  });

  it('lists and serves a skill that declares neither flag', async () => {
    await writeSkill(cwd, 'analyze', 'Analyze the codebase');
    client = await connect(cwd);

    expect(await listedSkillNames(client)).toEqual(['analyze']);
    const detail = jsonBody<{ name: string }>(
      await client.readResource({ uri: 'dorkos://skills/analyze' })
    );
    expect(detail.name).toBe('analyze');
  });
});
