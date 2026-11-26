import { beforeEach, describe, expect, it, vi } from 'vitest';
import { sessionRelayGroups, type SessionRelayRouteDeps } from './session-relay-groups.js';
import { PasskeyEnrolment } from '../../services/core/session-relay/passkeys/passkey-enrolment.js';
import type { RelayPin } from '../../services/core/session-relay/pin-store.js';
import { frontDoorStepUpHarness } from './front-door-step-up-harness.js';

describe('chat from the web confirmation', () => {
  const linked: RelayPin = {
    v: 2,
    computerId: 'northwind-computer',
    computerName: 'Northwind desk',
    hubOrigin: 'https://northwind.example.test',
    hubKey: 'made-up-key',
    relaySecret: 'made-up-secret',
    pinnedAt: '2026-11-16T00:00:00.000Z',
    level: 'chat',
    paused: true,
    issuer: 'https://account.example.test',
    accountId: 'northwind-account',
  };
  let pin: RelayPin | null = linked;
  const link = vi.fn(async () => {
    pin = { ...linked };
    return { ok: true as const, pin };
  });
  const updatePin = vi.fn(async (patch: Partial<Pick<RelayPin, 'level' | 'paused'>>) => {
    if (pin) pin = { ...pin, ...patch };
    return pin;
  });
  const checkPassword = vi.fn(async () => 'wrong' as const);
  let on = true;
  const enrolment = new PasskeyEnrolment();
  const deps: SessionRelayRouteDeps = {
    isHub: () => false,
    enabled: () => on,
    ownerExists: () => true,
    readPin: () => pin,
    updatePin,
    clearPin: () => {
      pin = null;
    },
    closeRelay: () => undefined,
    connected: () => false,
    link,
    suggestedName: () => 'Northwind desk',
    checkPassword,
    presence: () => ({ active: false, devices: [] }),
    devices: () => [],
    passkeys: {
      readKeys: () => null,
      keysUnreadable: () => false,
      enrolment,
      addKey: async () => undefined,
      removeKey: async () => true,
      removeDamaged: async () => 'not-damaged',
      audit: {
        owner: () => ({ accountId: 'northwind', kind: 'person', name: 'Northwind owner' }),
        recordAudit: () => undefined,
      },
    },
  };
  const owner = frontDoorStepUpHarness(() => [...sessionRelayGroups(deps)]);
  beforeEach(() => {
    on = true;
    pin = { ...linked };
    vi.clearAllMocks();
  });

  describe.each([
    ['post', '/link', { linkCode: 'ABCD-EFGH-JKMN-PQRS@northwind.example.test' }, link],
    ['patch', '/level', { level: 'full' }, updatePin],
    ['post', '/resume', {}, updatePin],
  ] as const)('%s %s', (method, path, body, effect) => {
    it.each(['direct', 'own-tunnel', 'managed'] as const)(
      'holds the write from %s',
      async (via) => {
        const held = await owner.call(method, `/api/session-relay${path}`, via).send(body);
        expect(held.status).toBe(428);
        expect(effect).not.toHaveBeenCalled();
        expect(checkPassword).not.toHaveBeenCalled();
        expect((await owner.confirm(held.body.heldActionId, via, true)).body.code).toBe(
          'held_by_another_browser'
        );
        expect(effect).not.toHaveBeenCalled();
        expect((await owner.confirm(held.body.heldActionId, via)).body).toMatchObject({
          ok: true,
          status: 200,
        });
        expect(effect).toHaveBeenCalledOnce();
      }
    );
    it('keeps the Wi-Fi refusal', async () => {
      expect(
        (await owner.call(method, `/api/session-relay${path}`, 'wifi').send(body)).status
      ).toBe(403);
      expect(effect).not.toHaveBeenCalled();
    });
  });

  it('holds starting approvals passkey enrolment at this computer', async () => {
    const held = await owner
      .call('post', '/api/session-relay/passkeys/start')
      .send({ label: 'Northwind passkey' });
    expect(held.status).toBe(428);
    expect(checkPassword).not.toHaveBeenCalled();
    expect((await owner.confirm(held.body.heldActionId, 'direct', true)).body.code).toBe(
      'held_by_another_browser'
    );
    const confirmed = await owner.confirm(held.body.heldActionId);
    expect(confirmed.body).toMatchObject({ ok: true, status: 200 });
    expect(confirmed.body.result).toHaveProperty('approveUrl');
  });

  it('does not hold pausing or lowering', async () => {
    expect((await owner.call('post', '/api/session-relay/pause', 'own-tunnel')).status).toBe(200);
    expect(
      (await owner.call('patch', '/api/session-relay/level', 'own-tunnel').send({ level: 'chat' }))
        .status
    ).toBe(200);
  });
  it.each([
    ['patch', '/level', { level: 'full' }],
    ['post', '/resume', {}],
  ] as const)('does not apply %s %s to a replacement link', async (method, path, body) => {
    const held = await owner.call(method, `/api/session-relay${path}`).send(body);
    expect(held.status).toBe(428);
    pin = {
      ...linked,
      hubOrigin: 'https://other-northwind.example.test',
      relaySecret: 'another-made-up-secret',
    };
    const confirmed = await owner.confirm(held.body.heldActionId);
    expect(confirmed.body).toMatchObject({
      ok: true,
      status: 409,
      result: { code: 'conflict', detail: 'The link changed. Try again.' },
    });
    expect(updatePin).not.toHaveBeenCalled();
  });

  // The capability mount's doors (DOR-4978), behind the real chain and a real sign-in.
  const AGENT = { 'X-DorkOS-Agent': 'not-a-real-token' };

  it('gives an agent the status without addresses or names, and never caches it', async () => {
    const person = await owner.call('get', '/api/session-relay/status');
    expect(person.body).toMatchObject({
      hubOrigin: linked.hubOrigin,
      suggestedName: 'Northwind desk',
    });
    const asAgent = await owner.call('get', '/api/session-relay/status').set(AGENT);
    expect(asAgent.status).toBe(200);
    expect(asAgent.headers['cache-control']).toBe('no-store');
    expect(asAgent.body).toMatchObject({ linked: true, hubOrigin: null, computerName: null });
    expect(asAgent.body).toMatchObject({ pinnedAt: null, suggestedName: '' });
  });

  it.each(['/presence', '/devices', '/passkeys'])(
    'refuses an agent %s, person-only',
    async (door) => {
      const res = await owner.call('get', `/api/session-relay${door}`).set(AGENT);
      expect(res.status).toBe(403);
      expect(res.body.code).toBe('person_only');
      expect(res.headers['cache-control']).toBe('no-store');
    }
  );

  // The registry has no check a door runs before its own refusals, so these come first.
  it('is the /api 404 while off, after the mount’s own refusals', async () => {
    on = false;
    const off = await owner.call('get', '/api/session-relay/devices');
    expect(off.status).toBe(404);
    expect(off.body.detail).toBe('This server has no API route at that path.');
    const asAgent = await owner.call('get', '/api/session-relay/devices').set(AGENT);
    expect(asAgent.body.code).toBe('person_only');
    const fromWifi = await owner.call('post', '/api/session-relay/pause', 'wifi');
    expect(fromWifi.body.code).toBe('not_from_wifi');
  });
});
