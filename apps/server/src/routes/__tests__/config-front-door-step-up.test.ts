import { afterEach, describe, expect, it, vi } from 'vitest';
import * as localMcp from '../../services/core/auth/mcp-local-token.js';
import { PERSON_PROOF_HEADER } from '@dorkos/shared/person-session';
import configRouter from '../config.js';
import { configManager } from '../../services/core/config-manager.js';
import { frontDoorStepUpHarness } from './front-door-step-up-harness.js';

describe('front-door settings confirmation', () => {
  const owner = frontDoorStepUpHarness(() => [{ path: '/api/config', routes: configRouter }]);

  it.each(['direct', 'own-tunnel', 'managed'] as const)(
    'holds a front-door patch from %s',
    async (via) => {
      configManager.set('server', { ...configManager.get('server'), lanAccess: false });
      const held = await owner
        .call('patch', '/api/config', via)
        .send({ server: { lanAccess: true } });
      expect(held.status).toBe(428);
      expect(configManager.get('server').lanAccess).toBe(false);
      expect((await owner.confirm(held.body.heldActionId, via, true)).body.code).toBe(
        'not-your-action'
      );
      expect(configManager.get('server').lanAccess).toBe(false);
      expect((await owner.confirm(held.body.heldActionId, via)).body).toMatchObject({
        ok: true,
        status: 200,
      });
      expect(configManager.get('server').lanAccess).toBe(true);
    }
  );

  it('keeps front-door patches from Wi-Fi refused', async () => {
    const res = await owner
      .call('patch', '/api/config', 'wifi')
      .send({ server: { lanAccess: true } });
    expect(res.status).toBe(403);
  });

  it('does not hold turning access off or changing a label', async () => {
    expect(
      (
        await owner
          .call('patch', '/api/config', 'own-tunnel')
          .send({ server: { lanAccess: false } })
      ).status
    ).toBe(200);
    expect(
      (
        await owner
          .call('patch', '/api/config', 'own-tunnel')
          .send({ cloud: { instanceName: 'Northwind desk' } })
      ).status
    ).toBe(200);
  });
  it('keeps dedicated consent paths refused before holding', async () => {
    for (const patch of [{ permissions: {} }, { cloud: { remote: { mode: 'managed' } } }]) {
      const refused = await owner.call('patch', '/api/config').send(patch);
      expect(refused.status).toBe(400);
      expect(refused.body.heldActionId).toBeUndefined();
      expect(refused.body.status).toBeUndefined();
    }
  });

  it('holds tunnel credentials and credits settings before any write', async () => {
    for (const patch of [
      { tunnel: { authtoken: 'made-up-replacement' } },
      { heartbeats: { triageOnCredits: true } },
      {
        cloud: {
          credits: { defaults: { 'claude-code': { runsOn: 'credits', chosenBy: 'user' } } },
        },
      },
    ]) {
      const before = JSON.stringify(configManager.getAll());
      const held = await owner.call('patch', '/api/config', 'own-tunnel').send(patch);
      expect(held.status).toBe(428);
      expect(JSON.stringify(configManager.getAll())).toBe(before);
      expect((await owner.confirm(held.body.heldActionId, 'own-tunnel')).body.status).toBe(200);
    }
  });

  it('does not hold removing a trusted source from an existing list', async () => {
    const source = { source: 'northwind/tools', trustedAt: '2026-11-16T10:00:00.000Z' };
    configManager.set('extensions', {
      ...configManager.get('extensions'),
      trustedSources: [source],
    });
    expect(
      (await owner.call('patch', '/api/config').send({ extensions: { trustedSources: [] } })).status
    ).toBe(200);
  });

  it('holds removing an extension from the disabled list', async () => {
    configManager.set('extensions', {
      ...configManager.get('extensions'),
      disabled: ['northwind-tool'],
    });
    const held = await owner
      .call('patch', '/api/config', 'own-tunnel')
      .send({ extensions: { disabled: [] } });
    expect(held.status).toBe(428);
    expect(configManager.get('extensions').disabled).toEqual(['northwind-tool']);
    expect((await owner.confirm(held.body.heldActionId, 'own-tunnel')).body.status).toBe(200);
    expect(configManager.get('extensions').disabled).toEqual([]);
  });

  it('does not hold disabling another extension', async () => {
    configManager.set('extensions', {
      ...configManager.get('extensions'),
      disabled: ['northwind-tool'],
    });
    const response = await owner
      .call('patch', '/api/config', 'own-tunnel')
      .send({ extensions: { disabled: ['northwind-tool', 'northwind-other'] } });
    expect(response.status).toBe(200);
    expect(response.body.heldActionId).toBeUndefined();
  });

  it.each(['refusedFolderConfig', 'refusedRepoConfig'] as const)(
    'confirms removing %s refusals, while adding refusals stays free',
    async (field) => {
      const entry = 'northwind@config-digest';
      configManager.set('harness', { ...configManager.get('harness'), [field]: [entry] });
      const held = await owner
        .call('patch', '/api/config', 'own-tunnel')
        .send({ harness: { [field]: [] } });
      expect(held.status).toBe(428);
      expect(configManager.get('harness')[field]).toEqual([entry]);
      expect((await owner.confirm(held.body.heldActionId, 'own-tunnel')).body.status).toBe(200);
      expect(configManager.get('harness')[field]).toEqual([]);
      const narrowed = await owner
        .call('patch', '/api/config', 'own-tunnel')
        .send({ harness: { [field]: [entry] } });
      expect(narrowed.status).toBe(200);
      expect(narrowed.body.heldActionId).toBeUndefined();
    }
  );

  it('still holds with login off once an owner and browser session exist', async () => {
    const proof = await owner
      .call('post', '/api/person-session')
      .send({ password: 'made-up-correct-horse-battery' });
    expect(proof.status).toBe(200);
    const cookie = (proof.headers['set-cookie'] as unknown as string[])
      .map((value) => value.split(';')[0])
      .join('; ');
    configManager.set('auth', { enabled: false });
    const held = await owner
      .call('patch', '/api/config')
      .set('Cookie', cookie)
      .set(PERSON_PROOF_HEADER, proof.body.proof)
      .send({ tunnel: { domain: 'northwind.example.test' } });
    expect(held.status).toBe(428);
    configManager.set('auth', { enabled: true });
  });

  afterEach(() => vi.restoreAllMocks());
  it.each(['reveal', 'rotate'] as const)(
    'confirms local MCP token %s before returning any token',
    async (action) => {
      vi.spyOn(localMcp, 'getMcpLocalToken').mockReturnValue('made-up-local-token');
      const rotate = vi
        .spyOn(localMcp, 'rotateMcpLocalToken')
        .mockReturnValue('made-up-rotated-token');
      const proof = await owner
        .call('post', '/api/person-session')
        .send({ password: 'made-up-correct-horse-battery' });
      expect(proof.status).toBe(200);
      const cookie = (proof.headers['set-cookie'] as unknown as string[])
        .map((value) => value.split(';')[0])
        .join('; ');
      configManager.set('auth', { enabled: false });
      try {
        const held = await owner
          .call('post', `/api/config/mcp/${action}-token`)
          .set('Cookie', cookie)
          .set(PERSON_PROOF_HEADER, proof.body.proof)
          .send({});
        expect(held.status).toBe(428);
        expect(held.body.localToken).toBeUndefined();
        expect(rotate).not.toHaveBeenCalled();
        const confirmed = await owner
          .call('post', `/api/step-up/${held.body.heldActionId}/password`)
          .set('Cookie', cookie)
          .set(PERSON_PROOF_HEADER, proof.body.proof)
          .send({ password: 'made-up-correct-horse-battery' });
        expect(confirmed.body).toMatchObject({
          ok: true,
          status: 200,
          result: {
            localToken: action === 'rotate' ? 'made-up-rotated-token' : 'made-up-local-token',
          },
        });
        expect(rotate).toHaveBeenCalledTimes(action === 'rotate' ? 1 : 0);
      } finally {
        configManager.set('auth', { enabled: true });
      }
    }
  );

  it('keeps credits narrowing and notice dismissals free', async () => {
    const off = await owner.call('patch', '/api/config').send({
      cloud: {
        credits: {
          defaults: { 'claude-code': { runsOn: 'own-sign-in', chosenBy: 'user' } },
          offer: 'dismissed',
        },
      },
    });
    expect(off.status).toBe(200);
  });
  it('does not hold withdrawing credits consent through settings aliases', async () => {
    const response = await owner.call('patch', '/api/config', 'own-tunnel').send({
      heartbeats: { triageOnCredits: false },
      cloud: { credits: { agents: [] } },
    });
    expect(response.status).toBe(200);
    expect(response.body.heldActionId).toBeUndefined();
    expect(configManager.get('heartbeats').triageOnCredits).toBe(false);
  });
});
