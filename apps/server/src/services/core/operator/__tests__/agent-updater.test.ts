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
 * `rooms-management-tools` §D6, DOR-1611; widened to the whole object by
 * DOR-1506).
 *
 * `UpdateAgentRequestSchema` picks `enabledToolGroups`, so the field is on the
 * agent-reachable wire, and this service is where `PATCH /api/agents/current` and
 * the `update_agent` MCP tool both land. `roomsManage` is the enforced grant — an
 * agent that could write it could turn its own hard filter off and the filter
 * would be theatre. The other four decide what the agent is TOLD about, and they
 * are refused too: their global twins (`agentContext.*`) are operator-only at the
 * config seam, a per-agent value beats the global one, so leaving these writable
 * meant an agent could undo a narrowing the person had made to its own tool
 * context.
 */
describe('an agent cannot write its own tool groups', () => {
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

  it('refuses the four documentation keys beside it (DOR-1506)', async () => {
    // The reproduction from the issue: a person turns an agent's tool-context
    // blocks off, and the agent turns its own back on. `resolveToolConfig` reads
    // `agent.<group> ?? globalConfig.<group>Tools`, so this per-agent write BEAT
    // the operator's global switch — which DOR-1497 had already made
    // operator-only at the config seam.
    await expect(
      updateAgentManifest({
        agentPath,
        body: { enabledToolGroups: { tasks: true, relay: true } },
      })
    ).rejects.toMatchObject({ code: 'OPERATOR_ONLY' });

    const onDisk = await readManifest(agentPath);
    expect(onDisk?.enabledToolGroups).toEqual({});
  });

  it('refuses an empty object too — replacing all five is a write to all five', async () => {
    await expect(
      updateAgentManifest({ agentPath, body: { enabledToolGroups: {} } })
    ).rejects.toMatchObject({ code: 'OPERATOR_ONLY' });
  });
});

/**
 * The rest of the classification, exercised through the seam rather than through
 * the table (DOR-1506). Each of these was agent-writable until the table landed,
 * and none of them is reachable from the cockpit through this route — the
 * person's own surface is `PATCH /api/mesh/agents/:id`.
 */
describe('the manifest fields only a person may set', () => {
  it('refuses a self-rename of the slug, and points at displayName', async () => {
    await expect(
      updateAgentManifest({ agentPath, body: { name: 'warden-prime' } })
    ).rejects.toMatchObject({ code: 'OPERATOR_ONLY' });

    await expect(
      updateAgentManifest({ agentPath, body: { name: 'warden-prime' } })
    ).rejects.toThrow(/displayName/);

    const onDisk = await readManifest(agentPath);
    expect(onDisk?.name).toBe('warden');
  });

  it('refuses a namespace move, which would choose its own side of the access rules', async () => {
    await expect(
      updateAgentManifest({ agentPath, body: { namespace: 'infra' } })
    ).rejects.toMatchObject({ code: 'OPERATOR_ONLY' });

    const onDisk = await readManifest(agentPath);
    expect(onDisk?.namespace).toBeUndefined();
  });

  it('refuses an agent voting itself the floor in every room', async () => {
    await expect(
      updateAgentManifest({ agentPath, body: { behavior: { responseMode: 'always' } } })
    ).rejects.toMatchObject({ code: 'OPERATOR_ONLY' });
  });

  it('still lets an agent write what it is called and how it sounds', async () => {
    // The mirror: the refusals above must not turn into a blanket refusal of
    // self-edit. An agent editing its own display name, model and personality is
    // the feature working.
    const updated = await updateAgentManifest({
      agentPath,
      body: {
        displayName: 'The Warden',
        model: 'sonnet',
        runtime: 'codex',
        traits: { ...SEED.traits, humor: 5 },
      },
    });

    expect(updated.displayName).toBe('The Warden');
    expect(updated.model).toBe('sonnet');
    expect(updated.runtime).toBe('codex');
    expect(updated.traits?.humor).toBe(5);
  });
});
