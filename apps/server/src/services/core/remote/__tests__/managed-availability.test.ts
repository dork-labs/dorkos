/**
 * The availability matrix for DorkOS managed remote access (DOR-2086), against
 * an offline Cloud answering from the published fixtures.
 */
import { describe, expect, it } from 'vitest';
import statusOpen from '@dork-labs/cloud-api/fixtures/v1/remote/status-open.json' with { type: 'json' };

import { resolveCloudIdentity } from '../../cloud/v1-client.js';
import {
  ABSENT_TTL_MS,
  AVAILABILITY_TTL_MS,
  ManagedAvailability,
} from '../managed-availability.js';
import { FakeCloud, entitlements, problem } from './fake-cloud.js';

function setup(options: { flag?: boolean } = {}) {
  const cloud = new FakeCloud();
  let now = 1_000_000;
  const availability = new ManagedAvailability({
    flagOn: () => options.flag ?? true,
    captureContext: cloud.capture,
    resolveIdentity: resolveCloudIdentity,
    now: () => now,
  });
  return { cloud, availability, advance: (ms: number) => (now += ms) };
}

describe('ManagedAvailability', () => {
  it('is hidden with the switch off, and asks Cloud nothing', async () => {
    const { cloud, availability } = setup({ flag: false });
    expect((await availability.read({ fresh: true })).availability).toBe('hidden');
    expect(availability.peek().availability).toBe('hidden');
    expect(cloud.calls).toEqual([]);
  });

  it('is hidden on an unlinked computer', async () => {
    const { cloud, availability } = setup();
    cloud.unlink();
    expect((await availability.read()).availability).toBe('hidden');
    expect(cloud.calls).toEqual([]);
  });

  it('is available when linked, entitled and Cloud answers status, carrying that status', async () => {
    const { cloud, availability } = setup();
    const snapshot = await availability.read();
    expect(snapshot).toMatchObject({
      availability: 'available',
      instanceId: 'inst_0001',
      cloudStale: false,
    });
    expect(snapshot.cloudStatus?.state).toBe('closed');
    // The status read names this instance.
    expect(cloud.callsTo('GET', '/v1/remote/status')[0]?.query.get('instanceId')).toBe('inst_0001');
  });

  it.each(['on_demand', 'always_available'] as const)('offers it for %s', async (capability) => {
    const { cloud, availability } = setup();
    cloud.on('GET', '/v1/entitlements', entitlements(capability));
    expect((await availability.read()).availability).toBe('available');
  });

  it('is hidden when the entitlement says the person uses their own tunnel', async () => {
    const { cloud, availability } = setup();
    cloud.on('GET', '/v1/entitlements', entitlements('byo'));
    expect((await availability.read()).availability).toBe('hidden');
  });

  it('is hidden when Cloud has no remote status route, and stays so for a while', async () => {
    const { cloud, availability, advance } = setup();
    cloud.on('GET', '/v1/remote/status', problem(404, 'not_found'));
    expect((await availability.read()).availability).toBe('hidden');
    cloud.on('GET', '/v1/remote/status', { status: 200, body: statusOpen });
    advance(AVAILABILITY_TTL_MS + 1);
    expect((await availability.read({ fresh: true })).availability).toBe('hidden');
    advance(ABSENT_TTL_MS);
    expect((await availability.read({ fresh: true })).availability).toBe('available');
  });

  it('is unavailable when Cloud cannot be reached, keeping the last status as stale', async () => {
    const { cloud, availability } = setup();
    await availability.read();
    cloud.on('GET', '/v1/remote/status', { networkError: true });
    const snapshot = await availability.read({ fresh: true });
    expect(snapshot.availability).toBe('unavailable');
    expect(snapshot.cloudStale).toBe(true);
    expect(snapshot.cloudStatus?.state).toBe('closed');
  });

  it('is unavailable when the session names no instance', async () => {
    const { cloud, availability } = setup();
    cloud.on('GET', '/v1/session', { status: 200, body: { authenticated: false } });
    const snapshot = await availability.read();
    expect(snapshot.availability).toBe('unavailable');
    expect(cloud.callsTo('GET', '/v1/entitlements')).toEqual([]);
  });

  it('ignores a status that names another instance', async () => {
    const { cloud, availability } = setup();
    cloud.on('GET', '/v1/remote/status', {
      status: 200,
      body: { ...statusOpen, instanceId: 'inst_other' },
    });
    expect((await availability.read()).availability).toBe('unavailable');
  });

  it('reuses an answer under the same link, and drops it the moment the link changes', async () => {
    const { cloud, availability } = setup();
    await availability.read();
    await availability.read();
    expect(cloud.callsTo('GET', '/v1/session')).toHaveLength(1);
    cloud.unlink();
    cloud.relink();
    expect(availability.peek().availability).toBe('hidden');
    await availability.read();
    expect(cloud.callsTo('GET', '/v1/session')).toHaveLength(2);
  });

  it('keeps nothing from a read whose link ended while it was in flight', async () => {
    const { cloud, availability } = setup();
    const read = availability.read();
    cloud.unlink();
    cloud.relink();
    expect((await read).availability).toBe('hidden');
    expect(availability.peek().availability).toBe('hidden');
  });

  it('reads hidden after the enrolment route was found missing', async () => {
    const { availability } = setup();
    await availability.read();
    availability.markAbsent();
    expect(availability.peek().availability).toBe('hidden');
    expect((await availability.read({ fresh: true })).availability).toBe('hidden');
  });
});
