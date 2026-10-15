/**
 * `CloudAuthority`: what a mint refuses, and that no copy of a real marker is
 * one (DOR-2086). Runs against a real `ConfigManager` over a temp data
 * directory, so "enrolled" is the record `remote-state.ts` actually writes.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { RemoteCommandSchema } from '@dork-labs/cloud-api';
import openFixture from '@dork-labs/cloud-api/fixtures/v1/remote/command-open.json' with { type: 'json' };
import keepaliveFixture from '@dork-labs/cloud-api/fixtures/v1/remote/command-keepalive.json' with { type: 'json' };

import util from 'node:util';

import { CloudLinkManager } from '../../auth/cloud-link.js';
import { configManager, initConfigManager } from '../../config-manager.js';
import { updateRemoteState } from '../../remote/remote-state.js';
import {
  CLOUD_AUTHORITY_VERBS,
  isCloudAuthority,
  mintCloudAuthority,
  type CloudAuthority,
} from '../cloud-authority.js';

const current = { isCurrent: () => true, instanceId: 'inst_A' };

const commands = {
  open: openFixture,
  close: { kind: 'close', id: 'cmd_c', leaseToken: 'lt_c', reason: 'idle' },
  rotate: { kind: 'rotate', id: 'cmd_r', leaseToken: 'lt_r', credentialId: 'iss_key_1' },
  revoke: { kind: 'revoke', id: 'cmd_v', leaseToken: 'lt_v', credentialId: 'cred_1' },
} as const;

let tmpDir: string;

function enrol(): void {
  updateRemoteState('test', {
    enrolmentId: 'enr_1',
    consentVersion: '2026-10',
    instanceId: 'inst_A',
    mode: 'managed',
  });
}

function mint(
  command: unknown,
  ctx: { isCurrent(): boolean; instanceId: string } | null = current
): CloudAuthority {
  const result = mintCloudAuthority(command, ctx);
  if (!result.ok) throw new Error(`expected a mint, got ${result.reason}`);
  return result.authority;
}

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dorkos-cloud-authority-'));
  initConfigManager(tmpDir);
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('mintCloudAuthority', () => {
  it('mints for each of the four verbs while enrolled on a current link', () => {
    enrol();
    for (const verb of CLOUD_AUTHORITY_VERBS) {
      const authority = mint(commands[verb]);
      expect(isCloudAuthority(authority)).toBe(true);
      expect(isCloudAuthority(authority, verb)).toBe(true);
      expect(authority.verb).toBe(verb);
      expect(authority.enrolmentId).toBe('enr_1');
    }
  });

  it('covers exactly the published kinds minus the two that carry no authority', () => {
    // A kind Cloud adds later turns this red, so carrying authority is a
    // decision somebody makes here rather than a default.
    const published = RemoteCommandSchema.options.map((option) => option.shape.kind.value).sort();
    expect(published).toEqual([...CLOUD_AUTHORITY_VERBS, 'inbox_pending', 'keepalive'].sort());
  });

  it('refuses inbox_pending, keepalive and an enrol verb', () => {
    enrol();
    const inbox = { kind: 'inbox_pending', id: 'cmd_i', leaseToken: 'lt_i', seatId: 'seat_1' };
    expect(mintCloudAuthority(inbox, current)).toEqual({ ok: false, reason: 'not-authorizing' });
    expect(mintCloudAuthority(keepaliveFixture, current)).toEqual({
      ok: false,
      reason: 'not-authorizing',
    });
    const enrolVerb = { kind: 'enrol', id: 'cmd_e', leaseToken: 'lt_e' };
    expect(mintCloudAuthority(enrolVerb, current)).toEqual({
      ok: false,
      reason: 'malformed-command',
    });
  });

  it('refuses a command without a lease token, or with an empty one', () => {
    enrol();
    const { leaseToken: _drop, ...noLease } = commands.close;
    expect(mintCloudAuthority(noLease, current).ok).toBe(false);
    expect(mintCloudAuthority({ ...commands.close, leaseToken: '' }, current).ok).toBe(false);
    expect(mintCloudAuthority({ ...commands.close, leaseToken: '   ' }, current)).toEqual({
      ok: false,
      reason: 'no-lease',
    });
  });

  it('refuses a stale or missing link context', () => {
    enrol();
    expect(
      mintCloudAuthority(commands.open, { isCurrent: () => false, instanceId: 'inst_A' })
    ).toEqual({
      ok: false,
      reason: 'stale-link',
    });
    expect(mintCloudAuthority(commands.open, null)).toEqual({ ok: false, reason: 'stale-link' });
  });

  it('refuses when no person enrolled this computer, or after withdrawal', () => {
    expect(mintCloudAuthority(commands.open, current)).toEqual({
      ok: false,
      reason: 'not-enrolled',
    });
    enrol();
    expect(mintCloudAuthority(commands.open, current).ok).toBe(true);
    updateRemoteState('test', { mode: 'off', enrolmentId: null, consentVersion: null });
    expect(mintCloudAuthority(commands.open, current)).toEqual({
      ok: false,
      reason: 'not-enrolled',
    });
  });

  it('refuses a current link that is not the one the enrolment was made under', () => {
    enrol();
    expect(
      mintCloudAuthority(commands.open, { isCurrent: () => true, instanceId: 'inst_B' })
    ).toEqual({
      ok: false,
      reason: 'other-link',
    });
  });

  describe('across an unlink, through the real unlink path', () => {
    async function unlinkA(): Promise<void> {
      configManager.set('cloud', { ...configManager.get('cloud'), instanceToken: 'dk_inst_A' });
      enrol();
      const manager = new CloudLinkManager({
        fetchImpl: async () => new Response('{}', { status: 200 }),
      });
      await manager.unlink();
      manager.stop();
    }

    it('unlink clears the enrolment and turns managed mode off, keeping BYO-free refs', async () => {
      updateRemoteState('test', {
        credentialId: 'cred_1',
        credentialRef: 'file:remote-tunnel-cred_1',
        edgeProofRef: 'file:remote-edge-cred_1',
      });
      await unlinkA();
      const remote = configManager.get('cloud').remote;
      expect(remote).toMatchObject({
        mode: 'off',
        enrolmentId: null,
        consentVersion: null,
        instanceId: null,
        credentialId: 'cred_1',
      });
    });

    it('unlink A then link B: a leftover consent cannot be used by B', async () => {
      await unlinkA();
      configManager.set('cloud', { ...configManager.get('cloud'), instanceToken: 'dk_inst_B' });
      expect(
        mintCloudAuthority(commands.open, { isCurrent: () => true, instanceId: 'inst_B' })
      ).toEqual({ ok: false, reason: 'not-enrolled' });
    });

    it('unlink A then link A again: the old consent does not come back', async () => {
      await unlinkA();
      configManager.set('cloud', { ...configManager.get('cloud'), instanceToken: 'dk_inst_A' });
      expect(mintCloudAuthority(commands.close, current)).toEqual({
        ok: false,
        reason: 'not-enrolled',
      });
    });
  });

  it('refuses garbage', () => {
    enrol();
    for (const value of [null, undefined, 'open', 42, [], {}, { kind: 'open' }]) {
      expect(mintCloudAuthority(value, current)).toEqual({
        ok: false,
        reason: 'malformed-command',
      });
    }
  });
});

describe('the marker', () => {
  it('does not survive a JSON round-trip, a structured clone or a look-alike', () => {
    enrol();
    const real = mint(commands.open);
    expect(isCloudAuthority(JSON.parse(JSON.stringify(real)))).toBe(false);
    expect(isCloudAuthority(structuredClone(real))).toBe(false);
    expect(isCloudAuthority({ command: commands.open, enrolmentId: 'enr_1', verb: 'open' })).toBe(
      false
    );
  });

  it('keeps its lease token out of JSON and out of util.inspect', () => {
    enrol();
    const authority = mint(commands.open);
    expect(util.inspect(authority, { depth: 10, showHidden: true })).not.toContain(
      openFixture.leaseToken
    );
    const json = JSON.stringify(authority);
    expect(json).not.toContain(openFixture.leaseToken);
    expect(JSON.parse(json)).toEqual({ verb: 'open', commandId: openFixture.id });
  });

  it('is frozen, and refuses to cover a verb it was not minted for', () => {
    enrol();
    const authority = mint(commands.close);
    expect(Object.isFrozen(authority)).toBe(true);
    expect(Object.isFrozen(authority.command)).toBe(true);
    expect(isCloudAuthority(authority, 'open')).toBe(false);
  });

  it('stops being valid when the link goes stale or the enrolment changes', () => {
    enrol();
    let live = true;
    const authority = mint(commands.open, { isCurrent: () => live, instanceId: 'inst_A' });
    expect(authority.isStillValid()).toBe(true);
    live = false;
    expect(authority.isStillValid()).toBe(false);

    live = true;
    updateRemoteState('test', { enrolmentId: 'enr_2' });
    expect(authority.isStillValid()).toBe(false);
    updateRemoteState('test', { mode: 'off', enrolmentId: null, consentVersion: null });
    expect(authority.isStillValid()).toBe(false);
  });

  it('stops being valid when the enrolment moves to another link', () => {
    enrol();
    const authority = mint(commands.close);
    expect(authority.isStillValid()).toBe(true);
    updateRemoteState('test', { instanceId: 'inst_B' });
    expect(authority.isStillValid()).toBe(false);
  });

  it('lets `open` act only while managed mode is still selected', () => {
    enrol();
    const open = mint(commands.open);
    const close = mint(commands.close);
    updateRemoteState('test', { mode: 'byo' });
    expect(open.isStillValid()).toBe(false);
    // Closing still narrows reach, so it stays valid.
    expect(close.isStillValid()).toBe(true);
  });
});
