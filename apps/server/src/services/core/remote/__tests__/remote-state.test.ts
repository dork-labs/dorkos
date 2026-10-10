/**
 * `remote-state.ts`, the single writer of `cloud.remote` (DOR-2086), against a
 * real `ConfigManager` over a temp data directory.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { configManager, initConfigManager } from '../../config-manager.js';
import { logger } from '../../../../lib/logger.js';
import {
  RemoteStateWriteError,
  isRemoteEnrolmentActive,
  readRemoteState,
  updateRemoteState,
  withdrawnRemoteState,
} from '../remote-state.js';

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dorkos-remote-state-'));
  initConfigManager(tmpDir);
});

afterEach(() => {
  vi.restoreAllMocks();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function onDisk(): { cloud: { remote: Record<string, unknown> }; tunnel: unknown } {
  return JSON.parse(fs.readFileSync(path.join(tmpDir, 'config.json'), 'utf-8'));
}

describe('readRemoteState', () => {
  it('reads off and empty on a fresh config, and returns a copy', () => {
    const state = readRemoteState();
    expect(state.mode).toBe('off');
    expect(isRemoteEnrolmentActive(state)).toBe(false);
    state.hosts.push('mutated.example.com');
    expect(readRemoteState().hosts).toEqual([]);
  });
});

describe('updateRemoteState', () => {
  it('writes the record, lower-cases and de-duplicates hosts, and keeps the link fields', () => {
    configManager.set('cloud', { ...configManager.get('cloud'), instanceToken: 'dk_inst' });
    updateRemoteState('test', {
      enrolmentId: 'enr_1',
      consentVersion: '2026-10',
      instanceId: 'inst_1',
      mode: 'managed',
      hosts: ['A.Example.com', 'a.example.com', ' b.example.com '],
    });
    const stored = onDisk();
    expect(stored.cloud.remote).toMatchObject({
      mode: 'managed',
      enrolmentId: 'enr_1',
      hosts: ['a.example.com', 'b.example.com'],
    });
    expect((stored.cloud as unknown as { instanceToken: string }).instanceToken).toBe('dk_inst');
  });

  it('never touches tunnel.*', () => {
    configManager.set('tunnel', {
      enabled: true,
      domain: 'mine.ngrok.app',
      authtoken: 'BYO-token-stays-put',
      auth: null,
    });
    const before = JSON.stringify(onDisk().tunnel);
    updateRemoteState('test', {
      enrolmentId: 'enr_1',
      consentVersion: '2026-10',
      instanceId: 'inst_1',
      mode: 'managed',
    });
    updateRemoteState('test', { mode: 'byo' });
    expect(JSON.stringify(onDisk().tunnel)).toBe(before);
    expect(JSON.stringify(onDisk().cloud.remote)).not.toContain('BYO-token-stays-put');
  });

  it('refuses managed mode without an active enrolment, and writes nothing', () => {
    expect(() => updateRemoteState('test', { mode: 'managed' })).toThrow(RemoteStateWriteError);
    // An enrolment with no link binding is not active either.
    expect(() =>
      updateRemoteState('test', { mode: 'managed', enrolmentId: 'e', consentVersion: 'c' })
    ).toThrow(RemoteStateWriteError);
    expect(onDisk().cloud.remote.mode).toBe('off');
  });

  it('refuses a raw secret where a reference belongs, naming the field and not the value', () => {
    const secret = '2abcRawTunnelValue_NEVER_STORE';
    let message = '';
    try {
      updateRemoteState('test', { credentialId: 'cred_1', credentialRef: secret });
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toContain('credentialRef');
    expect(message).not.toContain(secret);
    expect(fs.readFileSync(path.join(tmpDir, 'config.json'), 'utf-8')).not.toContain(secret);
  });

  it('refuses an edge proof header the published contract reserves', () => {
    for (const header of ['cookie', 'authorization', 'host', 'x-forwarded-for', 'X-Edge']) {
      expect(() => updateRemoteState('test', { edgeProofHeader: header })).toThrow(
        RemoteStateWriteError
      );
    }
    expect(updateRemoteState('test', { edgeProofHeader: 'x-dorkos-edge' }).edgeProofHeader).toBe(
      'x-dorkos-edge'
    );
  });

  it('refuses a credential reference with no credential id', () => {
    expect(() => updateRemoteState('test', { credentialRef: 'file:remote-tunnel-cred_1' })).toThrow(
      RemoteStateWriteError
    );
  });

  it('logs paths, never values', () => {
    const lines: string[] = [];
    vi.spyOn(logger, 'info').mockImplementation((...args: unknown[]) => {
      lines.push(args.map(String).join(' '));
    });
    updateRemoteState('managed remote setup', {
      enrolmentId: 'enr_1',
      consentVersion: '2026-10',
      credentialId: 'cred_SENTINEL',
      credentialRef: 'file:remote-tunnel-cred_SENTINEL',
      edgeProofRef: 'file:remote-edge-cred_SENTINEL',
    });
    const joined = lines.join('\n');
    expect(joined).toContain('cloud.remote');
    expect(joined).not.toContain('SENTINEL');
  });
});

describe('withdrawnRemoteState', () => {
  it('turns managed off, clears the enrolment and binding, keeps the credential for revoke', () => {
    const before = {
      ...readRemoteState(),
      mode: 'managed' as const,
      enrolmentId: 'enr_1',
      consentVersion: 'c',
      instanceId: 'inst_1',
      credentialId: 'cred_1',
      credentialRef: 'file:remote-tunnel-cred_1',
      edgeProofRef: 'file:remote-edge-cred_1',
    };
    expect(withdrawnRemoteState(before)).toMatchObject({
      mode: 'off',
      enrolmentId: null,
      consentVersion: null,
      instanceId: null,
      credentialId: 'cred_1',
      credentialRef: 'file:remote-tunnel-cred_1',
    });
  });

  it('keeps a BYO choice, which needs no link', () => {
    expect(withdrawnRemoteState({ ...readRemoteState(), mode: 'byo' }).mode).toBe('byo');
    expect(withdrawnRemoteState(undefined).mode).toBe('off');
  });
});
