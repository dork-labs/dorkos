import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import request from '@dorkos/test-utils/supertest';

// The real session gate, so a test can stand in for a browser session.
vi.mock('../../../services/core/auth/session-gate.js', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('../../../services/core/auth/session-gate.js')>();
  return { ...actual, decideSessionGate: vi.fn(actual.decideSessionGate) };
});

vi.mock('../../../services/core/cloud/credits-defaults.js', () => ({
  setCreditsAllowedForAgent: vi.fn(),
  creditsAllowedForAgent: vi.fn(() => false),
  creditsIsDefaultFor: vi.fn(() => false),
}));

// What DorkOS credits serve, for an agent on credits (DOR-2636).
vi.mock('../../../services/core/cloud/credits-models.js', () => ({
  judgeCreditsModel: vi.fn(async (_capabilities: unknown, model: string) => ({
    judged: true,
    refusal: model === 'md_served' ? null : "DorkOS credits don't cover that model.",
  })),
}));

import { ManifestUnreadableError } from '@dorkos/mesh';
import { decideSessionGate } from '../../../services/core/auth/session-gate.js';
import {
  creditsAllowedForAgent,
  creditsIsDefaultFor,
  setCreditsAllowedForAgent,
} from '../../../services/core/cloud/credits-defaults.js';
import { configManager } from '../../../services/core/config-manager.js';
import { runtimeRegistry } from '../../../services/core/runtime-registry.js';
import {
  DeclaredReaders,
  declaredReaders,
  setDeclaredReaders,
} from '../../../services/core/turn-power/declared-readers.js';
import { setTestOwner } from '../test-owner.js';
import {
  createMockMeshCore,
  fixtureServer,
  MOCK_MANIFEST,
  mountMesh,
  useLoginOffConfig,
  type MockMeshCore,
} from './mesh.fixtures.js';

useLoginOffConfig();

let meshCore: MockMeshCore;

beforeEach(() => {
  vi.clearAllMocks();
  // A real owner account, for the credits-consent owner bar (DOR-2652). Every
  // reader agrees there is one, so a change here needs the person's session.
  setTestOwner('user_owner');
  meshCore = createMockMeshCore();
  mountMesh(meshCore);
});

/** PATCH agent-1 with `body`, as a program here (or as an agent with `agent`). */
const patch = (body: Record<string, unknown>, agent?: string) => {
  const req = request(fixtureServer).patch('/api/mesh/agents/agent-1');
  return (agent ? req.set('x-dorkos-agent', agent) : req).send(body);
};

/**
 * The next request comes from the owner in a browser session the gate
 * proved: with an owner, a change at this computer needs one (DOR-3330).
 */
const asThePerson = () =>
  vi.mocked(decideSessionGate).mockResolvedValueOnce({
    allowed: true,
    user: { userId: 'user_owner', credential: 'cookie', sessionId: 'fixture-owner-browser' },
  });

describe('PATCH /api/mesh/agents/:id', () => {
  it('updates agent and returns updated manifest', async () => {
    meshCore.update.mockReturnValue({ ...MOCK_MANIFEST, name: 'Updated Agent' });

    const res = await patch({ name: 'Updated Agent' });

    expect(res.status).toBe(200);
    expect(res.body.name).toBe('Updated Agent');
    expect(meshCore.update).toHaveBeenCalledWith('agent-1', { name: 'Updated Agent' });
  });

  it.each([
    ['runtime', 'codex'],
    ['model', 'opus'],
    ['effort', 'max'],
  ])(
    'refuses an AGENT changing any agent’s %s, pointing at the tool that asks (DOR-2328)',
    async (field, value) => {
      // Purpose: this route has no caller guard of its own, and an agent can
      // reach it for ANY agent, not only itself.
      const res = await patch({ [field]: value }, 'agent-token-abc');

      expect(res.status).toBe(403);
      expect(res.body.code).toBe('needs_approval');
      expect(res.body.detail).toContain('update_agent_execution');
      expect(meshCore.update).not.toHaveBeenCalled();
    }
  );

  // DOR-3969: anyone may say an agent reads outside text; only a person takes it back.
  describe('reading outside text', () => {
    let recordDir: string;
    let home: string;
    /** DorkOS's record as a restarted server reads it from disk. */
    const onDisk = () =>
      new DeclaredReaders({
        file: path.join(recordDir, 'record.json'),
        logger: { warn: vi.fn() },
      });
    /** The agent's own `.dork/agent.json`. */
    const agentFile = () => path.join(home, '.dork', 'agent.json');
    /** What the agent's own file says now. */
    const fileSays = async () =>
      (JSON.parse(await fs.readFile(agentFile(), 'utf-8')) as { readsOutsideText?: boolean })
        .readsOutsideText;
    beforeEach(async () => {
      recordDir = await fs.mkdtemp(path.join(os.tmpdir(), 'declared-'));
      home = path.join(recordDir, 'agent-1');
      await fs.mkdir(path.join(home, '.dork'), { recursive: true });
      await fs.writeFile(agentFile(), JSON.stringify(MOCK_MANIFEST));
      setDeclaredReaders(onDisk());
      // Stands in for MeshCore's own write: the patch lands in the agent's real file.
      meshCore.update.mockImplementation(async (_id: string, fields: Record<string, unknown>) => {
        const next = { ...JSON.parse(await fs.readFile(agentFile(), 'utf-8')), ...fields };
        await fs.writeFile(agentFile(), JSON.stringify(next));
        return next;
      });
      meshCore.getProjectPath.mockReturnValue(home);
    });
    afterEach(async () => {
      setDeclaredReaders(null);
      await fs.rm(recordDir, { recursive: true, force: true });
    });

    it('an agent may turn it on, and is refused turning it off', async () => {
      const on = await patch({ readsOutsideText: true }, 'agent-token-abc');
      expect(on.status).toBe(200);
      expect(meshCore.update).toHaveBeenCalledWith('agent-1', { readsOutsideText: true });
      expect(onDisk().has('agent', 'agent-1')).toBe(true);
      expect(onDisk().has('agentHome', home)).toBe(true);
      expect(await fileSays()).toBe(true);
      meshCore.update.mockClear();

      const off = await patch({ readsOutsideText: false }, 'agent-token-abc');
      expect(off.status).toBe(403);
      expect(off.body.code).toBe('person_only');
      expect(meshCore.update).not.toHaveBeenCalled();
      expect(onDisk().has('agent', 'agent-1')).toBe(true);
      expect(onDisk().has('agentHome', home)).toBe(true);
      expect(await fileSays()).toBe(true);
    });

    it('a person turns it off, in the record and the file', async () => {
      declaredReaders()!.declare('agent', 'agent-1');
      declaredReaders()!.declare('agentHome', home);
      await fs.writeFile(agentFile(), JSON.stringify({ ...MOCK_MANIFEST, readsOutsideText: true }));
      // With an owner, a program here with no browser session is not the person.
      const noSession = await patch({ readsOutsideText: false });
      expect(noSession.status).toBe(403);
      expect(noSession.body.code).toBe('person_only');
      expect(meshCore.update).not.toHaveBeenCalled();
      expect(onDisk().has('agent', 'agent-1')).toBe(true);

      asThePerson();
      const off = await patch({ readsOutsideText: false });
      expect(off.status).toBe(200);
      // The write to the agent's own file carries the person's `false`.
      expect(meshCore.update).toHaveBeenCalledWith('agent-1', { readsOutsideText: false });
      expect(onDisk().has('agent', 'agent-1')).toBe(false);
      expect(onDisk().has('agentHome', home)).toBe(false);
      expect(await fileSays()).toBe(false);
    });
  });

  it('refuses a reports-to change that would make a loop (DOR-2788)', async () => {
    // agent-2 already reports to agent-1, so agent-1 may not report to agent-2.
    meshCore.get.mockImplementation((id: string) =>
      id === 'agent-1'
        ? { ...MOCK_MANIFEST }
        : id === 'agent-2'
          ? { ...MOCK_MANIFEST, id: 'agent-2', reportsTo: 'agent-1' }
          : undefined
    );

    const res = await patch({ reportsTo: 'agent-2' });

    expect(res.status).toBe(400);
    expect(res.body.code).toBe('reports_to_cycle');
    expect(meshCore.update).not.toHaveBeenCalled();
  });

  it('refuses a manager nobody can find, and stores a valid one', async () => {
    meshCore.get.mockImplementation((id: string) =>
      id === 'agent-1' || id === 'agent-3' ? { ...MOCK_MANIFEST, id } : undefined
    );
    const unknown = await patch({ reportsTo: 'nobody' });
    expect(unknown.status).toBe(400);
    expect(unknown.body.code).toBe('invalid_request');

    meshCore.update.mockReturnValue({ ...MOCK_MANIFEST, reportsTo: 'agent-3' });
    const ok = await patch({ reportsTo: 'agent-3' });
    expect(ok.status).toBe(200);
    expect(meshCore.update).toHaveBeenCalledWith('agent-1', { reportsTo: 'agent-3' });
  });

  it('never writes createdBy, whatever the body says', async () => {
    meshCore.update.mockReturnValue({ ...MOCK_MANIFEST });
    await patch({ displayName: 'Ana', createdBy: 'forged' });
    expect(meshCore.update).toHaveBeenCalledWith('agent-1', { displayName: 'Ana' });
  });

  it('refuses a model change at this computer with no browser session once an owner exists (DOR-3330)', async () => {
    // A program here that names no agent is not the person: with an owner,
    // only the owner's proved session may change what an agent runs.
    const res = await patch({ model: 'opus' });

    expect(res.status).toBe(403);
    expect(res.body.code).toBe('needs_approval');
    expect(meshCore.update).not.toHaveBeenCalled();
  });

  // Both halves of the narrowed catch (DOR-486 re-review). It used to catch
  // EVERYTHING `update` could throw and answer `409 MANIFEST_UNREADABLE` with
  // the raw message, so a schema-invalid merge — a different bug entirely —
  // was reported as a corrupt file, with internals on the wire.
  it('answers 409 when the manifest is present but cannot be read', async () => {
    meshCore.update.mockRejectedValue(
      new ManifestUnreadableError('/agents/ana', 'Unexpected token }')
    );

    const res = await patch({ displayName: 'Ana' });

    expect(res.status).toBe(409);
    expect(res.type).toBe('application/problem+json');
    expect(res.body.code).toBe('conflict');
    // The sentence is for a person who has to go fix the file; it names no path.
    expect(res.body.detail).toContain('Fix or remove it');
    expect(res.body.detail).not.toContain('/agents/ana');
  });

  it('does NOT dress any other failure up as an unreadable manifest', async () => {
    // What `writeManifest` throws when the merge does not satisfy the schema.
    meshCore.update.mockRejectedValue(new Error('Refusing to write invalid agent manifest'));

    const res = await patch({ displayName: 'Ana' });

    // The claim is only that the route did not invent a 409 with a story
    // about a corrupt file; what the error handler says is its own decision.
    expect(res.status).not.toBe(409);
    expect(res.body.code).not.toBe('conflict');
    expect(JSON.stringify(res.body)).not.toContain('Fix or remove');
  });

  it.each([
    // Spec `agent-permissions` D10: any local program can reach this route, so
    // it must never write what an agent may do.
    [{ permissions: { areas: { rooms: 'allowed' } } }, 'invalid_request', undefined],
    // Retired fields are refused, not silently dropped (spec `agent-permissions` D13).
    [{ enabledToolGroups: { tasks: false, roomsManage: true } }, undefined, ['enabledToolGroups']],
    [{ tierCeiling: 'act' }, undefined, ['tierCeiling']],
  ])('refuses a permission field in %j and writes nothing', async (body, code, fields) => {
    const res = await patch(body);

    expect(res.status).toBe(400);
    if (code) expect(res.body.code).toBe(code);
    if (fields) expect(res.body.fields).toEqual(fields);
    expect(meshCore.update).not.toHaveBeenCalled();
  });

  it.each([
    // A person's model and effort reach the manifest write.
    [{ model: 'sonnet', effort: 'low' }],
    // A model the runtime may not offer is accepted at write and reported as a
    // warning afterwards (design §3.4): catalogs are remote and can be offline.
    [{ model: 'gpt-5.3-codex' }],
  ])('lets a person write %j', async (body) => {
    meshCore.update.mockReturnValue({ ...MOCK_MANIFEST, ...body });

    asThePerson();
    const res = await patch(body);

    expect(res.status).toBe(200);
    expect(meshCore.update).toHaveBeenCalledWith('agent-1', body);
  });

  it("carries an agent's billing account through to the manifest write", async () => {
    // The operator half of invariant 4 (spec `billing-account-ladder`): this
    // route is the app's, and it MUST accept `account`. The agent-reachable
    // self-edit path refuses the same key — see
    // `services/core/operator/__tests__/agent-updater.test.ts`.
    meshCore.update.mockReturnValue({ ...MOCK_MANIFEST, account: 'acme-corp' });

    const res = await patch({ account: 'acme-corp' });

    expect(res.status).toBe(200);
    expect(meshCore.update).toHaveBeenCalledWith('agent-1', { account: 'acme-corp' });
  });

  // Only a person can put an agent on DorkOS credits (ADR 261001-000811): the
  // consent is recorded in DorkOS config, never trusted from the file.
  it.each([
    ['an unconfirmed request', undefined],
    ['an agent naming credits for itself', 'agent-token-abc'],
  ])('records no credits consent from %s', async (_who, agent) => {
    meshCore.get.mockReturnValue(MOCK_MANIFEST);
    meshCore.update.mockReturnValue({ ...MOCK_MANIFEST, account: 'dorkos-credits' });

    const res = await patch({ account: 'dorkos-credits' }, agent);

    expect(res.body.heldActionId).toBeUndefined();
    expect(setCreditsAllowedForAgent).not.toHaveBeenCalled();
  });

  it('withdraws the consent when a person moves the agent off credits', async () => {
    meshCore.update.mockReturnValue(MOCK_MANIFEST);

    asThePerson();
    await patch({ account: null });

    expect(setCreditsAllowedForAgent).toHaveBeenCalledExactlyOnceWith('agent-1', false);
  });

  describe('the model of an agent on DorkOS credits', () => {
    beforeEach(() => {
      const claude = {
        type: 'claude-code',
        getCapabilities: () => ({ credits: { protocol: 'anthropic-messages' } }),
      };
      vi.spyOn(runtimeRegistry, 'has').mockReturnValue(true);
      vi.spyOn(runtimeRegistry, 'get').mockReturnValue(claude as never);
      vi.spyOn(runtimeRegistry, 'getDefaultType').mockReturnValue('claude-code');
      vi.mocked(creditsAllowedForAgent).mockReturnValue(false);
      vi.mocked(creditsIsDefaultFor).mockReturnValue(false);
    });
    afterEach(() => {
      vi.restoreAllMocks();
    });

    it('refuses a model credits do not serve and writes nothing, and stores one they serve', async () => {
      meshCore.get.mockReturnValue({ ...MOCK_MANIFEST, account: 'dorkos-credits' });
      vi.mocked(creditsAllowedForAgent).mockReturnValue(true);

      asThePerson();
      const refused = await patch({ model: 'sonnet' });
      expect(refused.status).toBe(400);
      expect(refused.body).toMatchObject({ code: 'invalid_request' });
      expect(meshCore.update).not.toHaveBeenCalled();

      meshCore.update.mockReturnValue({ ...MOCK_MANIFEST, model: 'md_served' });
      asThePerson();
      expect((await patch({ model: 'md_served' })).status).toBe(200);
    });

    it('judges by credits when the same request puts the agent on them, or credits are the default', async () => {
      meshCore.get.mockReturnValue(MOCK_MANIFEST);
      asThePerson();
      expect((await patch({ account: 'dorkos-credits', model: 'sonnet' })).status).toBe(400);

      vi.mocked(creditsIsDefaultFor).mockReturnValue(true);
      asThePerson();
      expect((await patch({ model: 'sonnet' })).status).toBe(400);
    });

    it('keeps the runtime’s own menu for an agent on its own sign-in, or one nobody allowed', async () => {
      meshCore.update.mockReturnValue({ ...MOCK_MANIFEST, model: 'sonnet' });
      meshCore.get.mockReturnValue({ ...MOCK_MANIFEST, account: 'acme-corp' });
      asThePerson();
      expect((await patch({ model: 'sonnet' })).status).toBe(200);

      // A file naming credits nobody allowed runs on the default instead.
      meshCore.get.mockReturnValue({ ...MOCK_MANIFEST, account: 'dorkos-credits' });
      asThePerson();
      expect((await patch({ model: 'sonnet' })).status).toBe(200);
    });
  });

  describe('with login on', () => {
    beforeEach(() => {
      const realGet = configManager.get.bind(configManager);
      vi.spyOn(configManager, 'get').mockImplementation(((key: string) =>
        key === 'auth' ? { enabled: true } : realGet(key as never)) as typeof configManager.get);
    });
    afterEach(() => {
      vi.restoreAllMocks();
    });

    /** Ask the mesh routes as `user`, signed in with a browser session. */
    async function patchAs(userId: string) {
      const signedIn = () =>
        vi.mocked(decideSessionGate).mockResolvedValueOnce({
          allowed: true,
          user: { userId, credential: 'cookie', sessionId: 'fixture-owner-browser' },
        });
      signedIn();
      meshCore.get.mockReturnValue(MOCK_MANIFEST);
      meshCore.update.mockReturnValue({ ...MOCK_MANIFEST, account: 'dorkos-credits' });
      const response = await request(fixtureServer)
        .patch('/api/mesh/agents/agent-1')
        .set('Origin', 'http://localhost:4242')
        .send({ account: 'dorkos-credits' });
      if (userId === 'user_owner') {
        expect(response.status).toBe(428);
        expect(setCreditsAllowedForAgent).not.toHaveBeenCalled();
      }
      if (response.status !== 428) return response;
      signedIn();
      const confirmed = await request(fixtureServer)
        .post(`/api/step-up/${response.body.heldActionId}/password`)
        .set('Origin', 'http://localhost:4242')
        .send({ password: 'made-up-password' });
      expect(confirmed.status).toBe(200);
      return { ...response, status: confirmed.body.status, body: confirmed.body.result };
    }

    it('records no consent for a signed-in person who does not own this DorkOS', async () => {
      await patchAs('user_member');
      expect(setCreditsAllowedForAgent).not.toHaveBeenCalled();
    });

    it('records the owner’s consent', async () => {
      expect((await patchAs('user_owner')).status).toBe(200);
      expect(setCreditsAllowedForAgent).toHaveBeenCalledExactlyOnceWith('agent-1', true);
    });
  });

  it('reads a null account as "bill the server default again"', async () => {
    meshCore.update.mockReturnValue(MOCK_MANIFEST);

    const res = await patch({ account: null });

    expect(res.status).toBe(200);
    const written = meshCore.update.mock.calls[0][1] as Record<string, unknown>;
    expect(Object.keys(written)).toEqual(['account']);
    expect(written.account).toBeUndefined();
  });

  it('reads null as "go back to inheriting the server default"', async () => {
    meshCore.update.mockReturnValue(MOCK_MANIFEST);

    asThePerson();
    const res = await patch({ model: null, effort: null });

    expect(res.status).toBe(200);
    // The KEY must reach the merge carrying `undefined` — that is what makes
    // the merge drop it, and a manifest without the key is what "inherits"
    // looks like on disk. Asserted on key PRESENCE, because a patch that
    // silently omitted both would satisfy any value comparison against
    // `undefined` while leaving the old model in place forever. See
    // `mesh-core.test.ts` for the same claim end to end, against real files.
    const written = meshCore.update.mock.calls[0][1] as Record<string, unknown>;
    expect(Object.keys(written).sort()).toEqual(['effort', 'model']);
    expect(written.model).toBeUndefined();
    expect(written.effort).toBeUndefined();
  });

  describe('a system agent', () => {
    beforeEach(() => {
      meshCore.get.mockReturnValue({ ...MOCK_MANIFEST, isSystem: true });
    });

    it.each([
      [{ name: 'Hacked Name', description: 'Hacked Desc' }, ['name', 'description']],
      [{ namespace: 'evil-ns' }, ['namespace']],
      [{ isSystem: false }, ['isSystem']],
    ])('refuses %j with 403, naming the protected fields', async (body, named) => {
      const res = await patch(body);

      expect(res.status).toBe(403);
      expect(res.body.code).toBe('forbidden');
      for (const field of named) expect(res.body.detail).toContain(field);
      expect(res.body.detail).toContain('system agent');
      expect(meshCore.update).not.toHaveBeenCalled();
    });

    it('allows non-protected fields', async () => {
      meshCore.update.mockReturnValue({ ...MOCK_MANIFEST, capabilities: ['code', 'review'] });

      const res = await patch({ capabilities: ['code', 'review'] });

      expect(res.status).toBe(200);
      expect(meshCore.update).toHaveBeenCalledWith('agent-1', { capabilities: ['code', 'review'] });
    });
  });
});
