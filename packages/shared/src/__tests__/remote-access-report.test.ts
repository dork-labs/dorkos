import { describe, expect, it } from 'vitest';

import {
  RemoteAccessReportSchema,
  RemoteAccessStateSchema,
  TunnelStatusSchema,
} from '../schemas.js';
import { RemoteAccessSettingsSchema, UserConfigSchema } from '../config-schema.js';

const base = {
  mode: 'managed',
  state: 'open',
  url: 'https://box.example.com',
  alwaysAvailable: false,
  cloudStale: false,
  availability: 'available',
  enrolment: { status: 'enrolled' },
} as const;

describe('RemoteAccessReportSchema', () => {
  it('parses every state the surfaces render', () => {
    for (const state of [
      'off',
      'opening',
      'open',
      'draining',
      'blocked',
      'reconnecting',
      'asleep',
    ]) {
      expect(RemoteAccessReportSchema.safeParse({ ...base, state }).success).toBe(true);
    }
    expect(RemoteAccessStateSchema.options).toHaveLength(7);
  });

  it('refuses a state it does not know, including one that claims the computer is asleep', () => {
    expect(RemoteAccessReportSchema.safeParse({ ...base, state: 'sleeping' }).success).toBe(false);
    expect(RemoteAccessReportSchema.safeParse({ ...base, state: 'awake' }).success).toBe(false);
  });

  it('parses the three enrolment shapes and requires the pending details', () => {
    expect(
      RemoteAccessReportSchema.safeParse({ ...base, enrolment: { status: 'none' } }).success
    ).toBe(true);
    const pending = {
      status: 'pending',
      userCode: 'ABCD-1234',
      approveUrl: 'https://dorkos.ai/remote/approve',
      expiresAt: '2026-10-06T12:00:00.000Z',
    };
    expect(RemoteAccessReportSchema.safeParse({ ...base, enrolment: pending }).success).toBe(true);
    const { userCode: _omit, ...missingCode } = pending;
    expect(RemoteAccessReportSchema.safeParse({ ...base, enrolment: missingCode }).success).toBe(
      false
    );
    expect(
      RemoteAccessReportSchema.safeParse({ ...base, enrolment: { status: 'approved' } }).success
    ).toBe(false);
    expect(
      RemoteAccessReportSchema.safeParse({
        ...base,
        enrolment: { ...pending, expiresAt: 'in ten minutes' },
      }).success
    ).toBe(false);
  });

  it('allows no url and no reason, and refuses an unknown availability or mode', () => {
    const { url: _url, ...noUrl } = base;
    expect(
      RemoteAccessReportSchema.safeParse({ ...noUrl, state: 'blocked', reason: 'Sign in first.' })
        .success
    ).toBe(true);
    expect(RemoteAccessReportSchema.safeParse({ ...base, availability: 'soon' }).success).toBe(
      false
    );
    expect(RemoteAccessReportSchema.safeParse({ ...base, mode: 'both' }).success).toBe(false);
  });

  it('requires the Cloud-reported flags rather than defaulting them', () => {
    const { alwaysAvailable: _a, ...noFlag } = base;
    expect(RemoteAccessReportSchema.safeParse(noFlag).success).toBe(false);
    const { cloudStale: _c, ...noStale } = base;
    expect(RemoteAccessReportSchema.safeParse(noStale).success).toBe(false);
  });
});

describe('TunnelStatusSchema.mode', () => {
  const status = {
    enabled: true,
    connected: true,
    isRunning: true,
    url: 'https://x.ngrok.app',
    port: 4242,
    startedAt: null,
    authEnabled: false,
    tokenConfigured: true,
    domain: null,
  };

  it('is optional, so an older server still parses', () => {
    expect(TunnelStatusSchema.safeParse(status).success).toBe(true);
    expect(TunnelStatusSchema.safeParse({ ...status, mode: 'managed' }).success).toBe(true);
    expect(TunnelStatusSchema.safeParse({ ...status, mode: 'cloud' }).success).toBe(false);
  });
});

describe('cloud.remote config', () => {
  it('defaults off and empty on a fresh config', () => {
    const config = UserConfigSchema.parse({ version: 1 });
    expect(config.cloud.remote).toEqual({
      mode: 'off',
      enrolmentId: null,
      consentVersion: null,
      instanceId: null,
      credentialRef: null,
      credentialId: null,
      fingerprint: null,
      hosts: [],
      edgeProofRef: null,
      edgeProofHeader: null,
    });
  });

  it('refuses a raw secret where a reference belongs', () => {
    expect(
      RemoteAccessSettingsSchema.safeParse({ credentialRef: '2abcRawNgrokToken' }).success
    ).toBe(false);
    expect(RemoteAccessSettingsSchema.safeParse({ edgeProofRef: 'a'.repeat(40) }).success).toBe(
      false
    );
    expect(
      RemoteAccessSettingsSchema.safeParse({
        credentialRef: 'file:remote-tunnel-cred_1',
        edgeProofRef: 'file:remote-edge-cred_1',
      }).success
    ).toBe(true);
  });

  it('accepts only a lower-case header name for the edge proof', () => {
    expect(RemoteAccessSettingsSchema.safeParse({ edgeProofHeader: 'x-dorkos-edge' }).success).toBe(
      true
    );
    expect(RemoteAccessSettingsSchema.safeParse({ edgeProofHeader: 'X-Edge' }).success).toBe(false);
    expect(RemoteAccessSettingsSchema.safeParse({ edgeProofHeader: 'x edge' }).success).toBe(false);
  });
});
