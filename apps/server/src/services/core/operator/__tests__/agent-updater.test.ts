/**
 * A manifest PATCH changes what it names, and nothing else.
 *
 * The rule sounds too obvious to test, which is exactly why it broke:
 * `UpdateAgentRequestSchema` is `AgentManifestSchema.pick(...).partial()`, and
 * several picked fields carry a Zod `.default()`. Parsing `{"model":"sonnet"}`
 * therefore hands back a `description: ''` and a `capabilities: []` the caller
 * never sent, and spreading the parse result over the manifest wrote them.
 * Changing an agent's model erased its description (DOR-1253).
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readManifest, writeManifest } from '@dorkos/shared/manifest';
import type { AgentManifest } from '@dorkos/shared/mesh-schemas';
import { updateAgentManifest } from '../agent-updater.js';

let agentPath: string;

/** An agent with something in every field a partial PATCH could trample. */
const SEED = {
  id: '01M054RMQAMZPXHWHRKPGY9Z87',
  name: 'warden',
  displayName: 'Warden',
  description: 'Watches the build and complains loudly.',
  runtime: 'claude-code',
  capabilities: ['review', 'triage'],
  behavior: { responseMode: 'always' },
  traits: { verbosity: 4, autonomy: 3, chaos: 2, creativity: 3, humor: 3, spice: 1 },
  conventions: { soul: true, nope: true, dorkosKnowledge: true },
  registeredAt: '2026-08-16T00:00:00.000Z',
  registeredBy: 'test',
  personaEnabled: true,
  isSystem: false,
  enabledToolGroups: {},
  mcpServers: [],
} as unknown as AgentManifest;

beforeEach(async () => {
  agentPath = await mkdtemp(join(tmpdir(), 'agent-updater-'));
  await mkdir(join(agentPath, '.dork'), { recursive: true });
  await writeManifest(agentPath, SEED);
});

afterEach(async () => {
  await rm(agentPath, { recursive: true, force: true });
});

describe('a manifest PATCH touches only what it names', () => {
  it('keeps the description and capabilities when only the model changes', async () => {
    const updated = await updateAgentManifest({ agentPath, body: { model: 'sonnet' } });

    expect(updated.model).toBe('sonnet');
    expect(updated.description).toBe('Watches the build and complains loudly.');
    expect(updated.capabilities).toEqual(['review', 'triage']);
    // And on disk, not just in the answer.
    const onDisk = await readManifest(agentPath);
    expect(onDisk?.description).toBe('Watches the build and complains loudly.');
  });

  it('keeps the traits when only a convention file is written', async () => {
    // The profile's Instructions page sends exactly this: convention content and
    // no manifest field at all.
    const updated = await updateAgentManifest({
      agentPath,
      body: { soulContent: '<!-- TRAITS:START -->\n<!-- TRAITS:END -->\nBe careful.' },
    });

    expect(updated.traits?.verbosity).toBe(4);
    expect(updated.description).toBe('Watches the build and complains loudly.');
    expect(updated.displayName).toBe('Warden');
  });

  it('still writes a field the caller DID send, defaults included', async () => {
    // The guard is "did the caller mention this key", not "is the value
    // interesting" — clearing a description on purpose has to keep working.
    const updated = await updateAgentManifest({
      agentPath,
      body: { description: '', capabilities: [] },
    });

    expect(updated.description).toBe('');
    expect(updated.capabilities).toEqual([]);
  });

  it('still clears a field sent as null', async () => {
    await updateAgentManifest({ agentPath, body: { model: 'sonnet' } });

    const updated = await updateAgentManifest({ agentPath, body: { model: null } });

    expect(updated.model).toBeUndefined();
  });
});
