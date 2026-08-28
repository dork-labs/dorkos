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
import { readConventionFile, writeConventionFile } from '@dorkos/shared/convention-files-io';
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

describe('a convention file the server will not store is a refusal, not a 200', () => {
  // The route answered 200 while `UpdateAgentConventionsSchema` had already
  // failed and been swallowed (`conventionUpdates = {}`), so the profile said
  // "Saved" over a SOUL.md that never reached the disk (DOR-1253). The budget is
  // the WHOLE file — trait block included — which is exactly why a file that
  // looks legal in a prose editor is not.
  it('refuses an over-budget SOUL.md, and writes neither the file nor the fields beside it', async () => {
    const overBudget = `<!-- TRAITS:START -->\n<!-- TRAITS:END -->\n${'x'.repeat(4001)}`;

    await expect(
      updateAgentManifest({
        agentPath,
        body: { soulContent: overBudget, displayName: 'Renamed' },
      })
    ).rejects.toMatchObject({ code: 'VALIDATION' });

    expect(await readConventionFile(agentPath, 'SOUL.md')).toBeNull();
    expect((await readManifest(agentPath))?.displayName).toBe('Warden');
  });

  it('says which file was too long, in words the editor can show', async () => {
    await expect(
      updateAgentManifest({ agentPath, body: { nopeContent: 'x'.repeat(2001) } })
    ).rejects.toThrow(/NOPE\.md/);
  });

  it('leaves an existing file exactly as it was', async () => {
    await writeConventionFile(agentPath, 'SOUL.md', 'Be careful.');

    await expect(
      updateAgentManifest({ agentPath, body: { soulContent: 'x'.repeat(4001) } })
    ).rejects.toMatchObject({ code: 'VALIDATION' });

    expect(await readConventionFile(agentPath, 'SOUL.md')).toBe('Be careful.');
  });

  it('still writes a file that fits', async () => {
    await updateAgentManifest({ agentPath, body: { soulContent: 'Be careful.' } });

    expect(await readConventionFile(agentPath, 'SOUL.md')).toBe('Be careful.');
  });
});

describe('billing stays operator-only (spec billing-account-ladder invariant 4)', () => {
  it('refuses an `account` on the agent-reachable self-edit path', async () => {
    // This service backs the `update_agent` MCP tool. An agent that could set
    // `account` on a manifest could repoint whose subscription its work bills
    // to — the credential axis `config-write-policy.ts` already holds
    // `defaultAccount` on. Refused, not stripped: an agent told nothing would
    // report the change as done.
    await expect(
      updateAgentManifest({ agentPath, body: { account: 'acme-corp' } })
    ).rejects.toMatchObject({ code: 'OPERATOR_ONLY' });
  });

  it('writes nothing at all when it refuses', async () => {
    await expect(
      updateAgentManifest({ agentPath, body: { displayName: 'Sneaky', account: 'acme-corp' } })
    ).rejects.toMatchObject({ code: 'OPERATOR_ONLY' });

    const onDisk = await readManifest(agentPath);
    expect(onDisk?.account).toBeUndefined();
    // The refusal is whole: the legitimate half of the patch did not land either.
    expect(onDisk?.displayName).toBe('Warden');
  });

  it('refuses `account: null` too — clearing is a write to the field', async () => {
    await expect(updateAgentManifest({ agentPath, body: { account: null } })).rejects.toMatchObject(
      { code: 'OPERATOR_ONLY' }
    );
  });

  it('still accepts the fields an agent may edit', async () => {
    // The guard is narrow: it must not turn into a blanket refusal of self-edit.
    const updated = await updateAgentManifest({ agentPath, body: { displayName: 'The Warden' } });
    expect(updated.displayName).toBe('The Warden');
  });
});

/**
 * The self-grant seam, written as the reproduction it is (spec
 * `rooms-management-tools` §D6, DOR-1611 — the narrow half of DOR-1506).
 *
 * `UpdateAgentRequestSchema` picks `enabledToolGroups`, so the field is on the
 * agent-reachable wire, and this service is where `PATCH /api/agents/current` and
 * the `update_agent` MCP tool both land. Before the guard, an agent could turn its
 * own hard filter on and the filter was theatre. Four of the object's five keys
 * decide what an agent is TOLD about and stay writable here; only the enforced one
 * is refused.
 */
describe('an agent cannot grant itself the rooms-management group', () => {
  it('refuses `roomsManage: true` on the agent-reachable self-edit path', async () => {
    await expect(
      updateAgentManifest({ agentPath, body: { enabledToolGroups: { roomsManage: true } } })
    ).rejects.toMatchObject({ code: 'OPERATOR_ONLY' });

    const onDisk = await readManifest(agentPath);
    expect(onDisk?.enabledToolGroups?.roomsManage).toBeUndefined();
  });

  it('refuses the key whatever its value — naming the field is a write to it', async () => {
    for (const value of [false, null, undefined]) {
      await expect(
        updateAgentManifest({ agentPath, body: { enabledToolGroups: { roomsManage: value } } })
      ).rejects.toMatchObject({ code: 'OPERATOR_ONLY' });
    }
  });

  it('refuses the WHOLE patch, so a legitimate half does not land beside it', async () => {
    await expect(
      updateAgentManifest({
        agentPath,
        body: {
          displayName: 'Sneaky',
          enabledToolGroups: { tasks: false, roomsManage: true },
        },
      })
    ).rejects.toMatchObject({ code: 'OPERATOR_ONLY' });

    const onDisk = await readManifest(agentPath);
    expect(onDisk?.displayName).toBe('Warden');
    expect(onDisk?.enabledToolGroups).toEqual({});
  });

  it('tells the agent who can change it, rather than failing blankly', async () => {
    await expect(
      updateAgentManifest({ agentPath, body: { enabledToolGroups: { roomsManage: true } } })
    ).rejects.toThrow(/set by a person/i);
  });

  it('still lets an agent write the four documentation keys beside it', async () => {
    // The guard is narrow on purpose. Those four steer an agent rather than
    // restricting it (DOR-519), and turning this into a blanket refusal of
    // `enabledToolGroups` would take a working feature away to fix another one.
    const updated = await updateAgentManifest({
      agentPath,
      body: { enabledToolGroups: { tasks: false, relay: true } },
    });

    expect(updated.enabledToolGroups).toEqual({ tasks: false, relay: true });
    const onDisk = await readManifest(agentPath);
    expect(onDisk?.enabledToolGroups).toEqual({ tasks: false, relay: true });
  });
});
