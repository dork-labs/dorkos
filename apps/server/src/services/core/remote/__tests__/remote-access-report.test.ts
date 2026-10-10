/**
 * The remote access report's decision table (DOR-2086): every surface renders
 * this one answer, so each rule is pinned here once.
 */
import { describe, expect, it } from 'vitest';
import statusClosed from '@dork-labs/cloud-api/fixtures/v1/remote/status-closed.json' with { type: 'json' };
import statusOpen from '@dork-labs/cloud-api/fixtures/v1/remote/status-open.json' with { type: 'json' };
import type { RemoteStatus } from '@dork-labs/cloud-api';
import { defaultRemoteAccessSettings } from '@dorkos/shared/config-schema';
import { RemoteAccessReportSchema, type TunnelStatus } from '@dorkos/shared/schemas';

import {
  NOT_SERVING_REASON,
  SETUP_UNFINISHED_REASON,
  buildRemoteAccessReport,
  type RemoteAccessFacts,
} from '../remote-access-report.js';

const closed = statusClosed as RemoteStatus;
const open = statusOpen as RemoteStatus;

const idleTunnel: TunnelStatus = {
  enabled: false,
  connected: false,
  isRunning: false,
  url: null,
  port: null,
  startedAt: null,
  authEnabled: false,
  tokenConfigured: false,
  domain: null,
};

const enrolled = {
  ...defaultRemoteAccessSettings(),
  mode: 'managed' as const,
  enrolmentId: 'enr_0001',
  consentVersion: '2026-09-01',
  instanceId: 'inst_0001',
  credentialId: 'cred_0002',
  credentialRef: 'file:remote-tunnel-cred_0002',
  edgeProofRef: 'file:remote-edge-cred_0002',
  hosts: ['example-instance.remote.invalid'],
};

function facts(overrides: Partial<RemoteAccessFacts> = {}): RemoteAccessFacts {
  return {
    tunnel: idleTunnel,
    liveMode: 'off',
    managedPhase: null,
    remote: defaultRemoteAccessSettings(),
    ownTunnelEnabled: false,
    availability: {
      availability: 'available',
      instanceId: 'inst_0001',
      cloudStatus: null,
      cloudStale: false,
    },
    setup: null,
    note: undefined,
    ...overrides,
  };
}

function report(overrides: Partial<RemoteAccessFacts> = {}) {
  const built = buildRemoteAccessReport(facts(overrides));
  // Every report the builder makes is one the shared schema accepts.
  expect(RemoteAccessReportSchema.safeParse(built).success).toBe(true);
  return built;
}

describe('buildRemoteAccessReport', () => {
  it('is off, with no address, when nothing is chosen', () => {
    expect(report()).toEqual({
      mode: 'off',
      state: 'off',
      alwaysAvailable: false,
      cloudStale: false,
      availability: 'available',
      enrolment: { status: 'none' },
    });
  });

  it('reports the person’s own tunnel open, then reconnecting without an address', () => {
    const live = { ...idleTunnel, isRunning: true, connected: true, url: 'https://x.ngrok.app' };
    expect(report({ liveMode: 'byo', tunnel: live })).toMatchObject({
      mode: 'byo',
      state: 'open',
      url: 'https://x.ngrok.app',
    });
    const dropped = report({ liveMode: 'byo', tunnel: { ...live, connected: false } });
    expect(dropped.state).toBe('reconnecting');
    expect(dropped.url).toBeUndefined();
  });

  it('reports byo for a computer whose own tunnel is set to open, even while it is closed', () => {
    expect(report({ ownTunnelEnabled: true })).toMatchObject({ mode: 'byo', state: 'off' });
  });

  it('follows the managed session through opening, open and draining', () => {
    const tunnel = {
      ...idleTunnel,
      isRunning: true,
      connected: true,
      url: 'https://example-instance.remote.invalid',
    };
    const base = { liveMode: 'managed' as const, tunnel, remote: enrolled };
    expect(report({ ...base, managedPhase: 'opening' }).state).toBe('opening');
    expect(report({ ...base, managedPhase: 'draining' }).state).toBe('draining');
    expect(report({ ...base, managedPhase: 'open' })).toMatchObject({
      mode: 'managed',
      state: 'open',
      url: 'https://example-instance.remote.invalid',
    });
  });

  it('is asleep, with the address, when Cloud reports the managed tunnel closed', () => {
    const asleep = report({
      remote: enrolled,
      availability: {
        availability: 'available',
        instanceId: 'inst_0001',
        cloudStatus: closed,
        cloudStale: false,
      },
    });
    expect(asleep).toMatchObject({
      mode: 'managed',
      state: 'asleep',
      url: 'https://example-instance.remote.invalid',
      enrolment: { status: 'enrolled' },
    });
    expect(asleep.reason).toBeUndefined();
  });

  it('is not asleep when Cloud was not asked: it says off and stale, not a guess', () => {
    const unknown = report({
      remote: enrolled,
      availability: {
        availability: 'unavailable',
        instanceId: null,
        cloudStatus: null,
        cloudStale: false,
      },
    });
    expect(unknown.state).toBe('off');
    expect(unknown.url).toBeUndefined();
  });

  it('names the disagreement when Cloud says open and nothing here is serving', () => {
    expect(
      report({
        remote: enrolled,
        availability: {
          availability: 'available',
          instanceId: 'inst_0001',
          cloudStatus: open,
          cloudStale: false,
        },
      })
    ).toMatchObject({ state: 'reconnecting', reason: NOT_SERVING_REASON });
  });

  it('is blocked, with the way out, when setup stopped after the approval', () => {
    expect(
      report({
        remote: { ...enrolled, credentialId: null, credentialRef: null, edgeProofRef: null },
      })
    ).toMatchObject({ state: 'blocked', reason: SETUP_UNFINISHED_REASON });
  });

  it('carries alwaysAvailable only as Cloud reports it, and only in managed mode', () => {
    const always = { ...closed, alwaysAvailable: true };
    const availability = {
      availability: 'available' as const,
      instanceId: 'inst_0001',
      cloudStatus: always,
      cloudStale: false,
    };
    expect(report({ remote: enrolled, availability }).alwaysAvailable).toBe(true);
    expect(report({ ownTunnelEnabled: true, availability }).alwaysAvailable).toBe(false);
  });

  it('shows a pending, denied or expired setup over the saved record', () => {
    const pending = {
      status: 'pending' as const,
      userCode: 'BCDF-GHJK',
      approveUrl: 'https://cloud.example.invalid/remote/approve',
      expiresAt: '2026-09-15T12:15:00.000Z',
    };
    expect(report({ setup: pending }).enrolment).toEqual(pending);
    expect(report({ setup: { status: 'denied' } }).enrolment).toEqual({ status: 'denied' });
    expect(report({ setup: { status: 'expired' } }).enrolment).toEqual({ status: 'expired' });
  });

  it('carries a note and the stale flag through', () => {
    expect(
      report({
        note: 'Turned off here.',
        availability: {
          availability: 'unavailable',
          instanceId: null,
          cloudStatus: closed,
          cloudStale: true,
        },
      })
    ).toMatchObject({ reason: 'Turned off here.', cloudStale: true, availability: 'unavailable' });
  });
});
