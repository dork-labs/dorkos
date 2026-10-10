/**
 * The command dispatcher (DOR-2086): journal before acting, mint once, act
 * with a re-checked authority, and never act twice on one command id.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import openFixture from '@dork-labs/cloud-api/fixtures/v1/remote/command-open.json' with { type: 'json' };
import address from '@dork-labs/cloud-api/fixtures/v1/remote/address.json' with { type: 'json' };
import withEdgeProof from '@dork-labs/cloud-api/fixtures/v1/remote/credential-with-edge-proof.json' with { type: 'json' };
import withoutEdgeProof from '@dork-labs/cloud-api/fixtures/v1/remote/credential.json' with { type: 'json' };
import alreadyDelivered from '@dork-labs/cloud-api/fixtures/v1/problem/remote-credential-already-delivered.json' with { type: 'json' };

import { TunnelManager } from '../../tunnel-manager.js';
import {
  CommandDispatcher,
  hostnameOf,
  MAX_DRAIN_DEADLINE_MS,
  type LeasedCommand,
} from '../command-dispatcher.js';
import type { ManagedIngress } from '../managed-ingress.js';
import { readRemoteState, updateRemoteState } from '../remote-state.js';
import { commandWorld, CURRENT, INSTANCE_ID, type CommandWorld } from './command-harness.js';

const ISSUE = '/v1/remote/credentials/issue';
const CONFIRM = '/v1/remote/credentials/confirm';
const ADDRESS = '/v1/remote/address';

const open = openFixture as LeasedCommand;
const close: LeasedCommand = { kind: 'close', id: 'cmd_close', leaseToken: 'lt_c', reason: 'idle' };
const rotate: LeasedCommand = {
  kind: 'rotate',
  id: 'cmd_rotate',
  leaseToken: 'lt_r',
  credentialId: 'issue_key_0001',
};
const revoke = (credentialId: string): LeasedCommand => ({
  kind: 'revoke',
  id: `cmd_revoke_${credentialId}`,
  leaseToken: 'lt_v',
  credentialId,
});

let w: CommandWorld;

beforeEach(async () => {
  w = await commandWorld();
});

afterEach(() => {
  w.cleanup();
});

function confirmed(credentialId = withEdgeProof.credentialId) {
  return { status: 200, body: { credentialId, confirmedAt: '2026-09-15T12:04:00.000Z' } };
}

describe('every command', () => {
  it('is journaled before anything acts on it', async () => {
    let seenDuringEffect: unknown;
    w.tunnel.startManaged.mockImplementationOnce(async (input) => {
      seenDuringEffect = w.journal.read([open.id])[0];
      return { ok: true, url: 'https://x', hosts: [...input.hosts], generation: 1 };
    });
    expect(await w.dispatcher.dispatch(open, w.link)).toBe('applied');
    expect(seenDuringEffect).toMatchObject({ commandId: open.id, outcome: null });
    expect(w.journal.read([open.id])[0]).toMatchObject({ outcome: 'applied', ackState: 'pending' });
    expect(w.settled).toHaveBeenCalledTimes(1);
  });

  it('acts once per command id, answering a redelivery with the recorded outcome', async () => {
    expect(await w.dispatcher.dispatch(open, w.link)).toBe('applied');
    const again = { ...open, leaseToken: 'lt_redelivered' } as LeasedCommand;
    expect(await w.dispatcher.dispatch(again, w.link)).toBe('applied');
    expect(w.tunnel.startManaged).toHaveBeenCalledTimes(1);
    // The acknowledgement goes out again, under the new lease.
    expect(w.settled).toHaveBeenCalledTimes(2);
    expect(w.journal.read([open.id])[0]?.leaseToken).toBe('lt_redelivered');
  });

  it('never repeats a destructive effect on redelivery', async () => {
    w.tunnel.phase = 'open';
    expect(await w.dispatcher.dispatch(revoke(CURRENT.credentialId), w.link)).toBe('applied');
    expect(await w.dispatcher.dispatch(revoke(CURRENT.credentialId), w.link)).toBe('applied');
    expect(w.tunnel.closeManaged).toHaveBeenCalledTimes(1);
  });

  it('refuses a command from a link that has since ended, acting on nothing', async () => {
    w.cloud.unlink();
    expect(await w.dispatcher.dispatch(open, w.link)).toBe('refused:stale-link');
    w.cloud.relink();
    expect(await w.dispatcher.dispatch(rotate, w.link)).toBe('refused:stale-link');
    expect(w.tunnel.startManaged).not.toHaveBeenCalled();
    expect(w.cloud.callsTo('POST', ISSUE)).toEqual([]);
  });

  it('refuses when no person is enrolled here', async () => {
    const bare = await commandWorld({ enrolled: false });
    try {
      expect(await bare.dispatcher.dispatch(open, bare.link)).toBe('refused:not-enrolled');
      expect(bare.tunnel.startManaged).not.toHaveBeenCalled();
    } finally {
      bare.cleanup();
    }
  });

  it('refuses an open after a local withdrawal, with the network down', async () => {
    w.cloud.on('POST', ISSUE, { networkError: true }).on('GET', ADDRESS, { networkError: true });
    updateRemoteState('test withdrawal', {
      mode: 'off',
      enrolmentId: null,
      consentVersion: null,
      instanceId: null,
    });
    expect(await w.dispatcher.dispatch(open, w.link)).toBe('refused:not-enrolled');
    expect(w.tunnel.startManaged).not.toHaveBeenCalled();
  });

  it('acknowledges inbox_pending as a signal only, minting nothing', async () => {
    const inbox: LeasedCommand = {
      kind: 'inbox_pending',
      id: 'cmd_inbox',
      leaseToken: 'lt_i',
      seatId: 'seat_0001',
    };
    expect(await w.dispatcher.dispatch(inbox, w.link)).toBe('ignored');
    expect(w.tunnel.startManaged).not.toHaveBeenCalled();
  });

  it('records failed and still acknowledges when the effect throws', async () => {
    w.tunnel.startManaged.mockRejectedValueOnce(new Error('boom'));
    expect(await w.dispatcher.dispatch(open, w.link)).toBe('failed');
    expect(w.settled).toHaveBeenCalledTimes(1);
  });
});

describe('open', () => {
  it('opens every host the credential allows, with the stored secrets', async () => {
    expect(await w.dispatcher.dispatch(open, w.link)).toBe('applied');
    expect(w.tunnel.startManaged).toHaveBeenCalledWith({
      value: CURRENT.value,
      hosts: CURRENT.hosts,
      edgeProof: { header: CURRENT.header, secret: CURRENT.edgeProofSecret },
      generation: 1,
    });
  });

  it('is not applied unless every host is served', async () => {
    w.tunnel.refuseHosts = [CURRENT.hosts[1]!];
    expect(await w.dispatcher.dispatch(open, w.link)).toBe('failed');
  });

  it('passes on what the local rules say: the authority cannot satisfy canExpose()', async () => {
    const tunnel = new TunnelManager({ canExpose: () => false });
    tunnel.attachManagedIngress({} as ManagedIngress);
    const dispatcher = new CommandDispatcher({
      journal: w.journal,
      tunnelManager: tunnel,
      remoteCredentials: w.credentials,
      readRemoteState,
      updateRemoteState,
      onSettled: () => undefined,
    });
    expect(await dispatcher.dispatch(open, w.link)).toBe('refused:exposure-not-allowed');
    expect(tunnel.getMode()).toBe('off');
  });

  it('uses the command address, else the published address, when the credential named no host', async () => {
    updateRemoteState('test', { hosts: [] });
    expect(await w.dispatcher.dispatch(open, w.link)).toBe('applied');
    expect(w.tunnel.startManaged.mock.calls[0]![0].hosts).toEqual([openFixture.address]);

    w.cloud.on('GET', ADDRESS, { status: 200, body: address });
    const bare = { ...open, id: 'cmd_bare', address: undefined } as LeasedCommand;
    expect(await w.dispatcher.dispatch(bare, w.link)).toBe('applied');
    expect(w.tunnel.startManaged.mock.calls[1]![0].hosts).toEqual([address.address]);
  });

  it('refuses when no target is known', async () => {
    updateRemoteState('test', { hosts: [] });
    const bare = { ...open, address: undefined } as LeasedCommand;
    expect(await w.dispatcher.dispatch(bare, w.link)).toBe('refused:no-target');
    expect(w.tunnel.startManaged).not.toHaveBeenCalled();
  });

  it('refuses when the stored secret is gone, naming why', async () => {
    await w.credentials.delete(CURRENT.credentialId);
    expect(await w.dispatcher.dispatch(open, w.link)).toBe('refused:missing-secret');
  });

  it('refuses while the person has chosen their own tunnel instead', async () => {
    updateRemoteState('test', { mode: 'byo' });
    expect(await w.dispatcher.dispatch(open, w.link)).toBe('refused:stale-link');
  });
});

describe('close', () => {
  it('drains to the deadline the open carried', async () => {
    const quick = { ...open, drainDeadlineSeconds: 5 } as LeasedCommand;
    await w.dispatcher.dispatch(quick, w.link);
    expect(await w.dispatcher.dispatch(close, w.link)).toBe('applied');
    expect(w.tunnel.closeManaged).toHaveBeenCalledWith({
      immediate: false,
      drainDeadlineMs: 5_000,
    });
  });

  it('leaves the bounded local deadline to the ingress when Cloud named none', async () => {
    const plain = { ...open, drainDeadlineSeconds: undefined } as LeasedCommand;
    await w.dispatcher.dispatch(plain, w.link);
    await w.dispatcher.dispatch(close, w.link);
    expect(w.tunnel.closeManaged).toHaveBeenCalledWith({
      immediate: false,
      drainDeadlineMs: undefined,
    });
  });

  it('caps a longer deadline from Cloud', async () => {
    const slow = { ...open, drainDeadlineSeconds: 3_600 } as LeasedCommand;
    await w.dispatcher.dispatch(slow, w.link);
    await w.dispatcher.dispatch(close, w.link);
    expect(w.tunnel.closeManaged).toHaveBeenCalledWith({
      immediate: false,
      drainDeadlineMs: MAX_DRAIN_DEADLINE_MS,
    });
  });

  it('is applied with nothing to do when nothing is open, and failed when the close fails', async () => {
    expect(await w.dispatcher.dispatch(close, w.link)).toBe('applied');
    expect(w.tunnel.closeManaged).not.toHaveBeenCalled();
    w.tunnel.phase = 'open';
    w.tunnel.closeManaged.mockRejectedValueOnce(new Error('ngrok'));
    expect(await w.dispatcher.dispatch({ ...close, id: 'cmd_close_2' }, w.link)).toBe('failed');
  });
});

describe('rotate', () => {
  it('issues with the command id as key, stores, confirms, then switches', async () => {
    w.tunnel.phase = 'open';
    w.cloud
      .on('POST', ISSUE, { status: 200, body: withEdgeProof })
      .on('POST', CONFIRM, confirmed());
    expect(await w.dispatcher.dispatch(rotate, w.link)).toBe('applied');

    expect(w.cloud.callsTo('POST', ISSUE)[0]?.body).toEqual({
      instanceId: INSTANCE_ID,
      idempotencyKey: 'issue_key_0001',
    });
    expect(readRemoteState()).toMatchObject({
      credentialId: withEdgeProof.credentialId,
      hosts: withEdgeProof.hosts,
      edgeProofHeader: withEdgeProof.edgeProof.header,
    });
    // The listener moved to the new value and host set; the old secrets are gone.
    expect(w.tunnel.startManaged).toHaveBeenCalledWith(
      expect.objectContaining({ value: withEdgeProof.value, hosts: withEdgeProof.hosts })
    );
    expect((await w.credentials.resolve(readRemoteState())).ok).toBe(true);
    expect(await w.store.get(`remote-tunnel-${CURRENT.credentialId}`)).toBeNull();
  });

  it('keeps the current credential when the issue is refused', async () => {
    w.cloud.on('POST', ISSUE, { status: 409, body: alreadyDelivered });
    expect(await w.dispatcher.dispatch(rotate, w.link)).toBe('refused:issue-refused');
    expect(readRemoteState().credentialId).toBe(CURRENT.credentialId);
    expect(w.cloud.callsTo('POST', CONFIRM)).toEqual([]);
  });

  it('refuses a replacement without an edge proof, storing nothing', async () => {
    const unproven = { ...withoutEdgeProof, credentialId: 'cred_unproven' };
    w.cloud.on('POST', ISSUE, { status: 200, body: unproven });
    expect(await w.dispatcher.dispatch(rotate, w.link)).toBe('refused:no-edge-proof');
    expect(await w.store.get('remote-tunnel-cred_unproven')).toBeNull();
    expect(w.cloud.callsTo('POST', CONFIRM)).toEqual([]);
    expect(readRemoteState().credentialId).toBe(CURRENT.credentialId);
  });

  it('forgets the replacement and keeps the current one when the confirm fails', async () => {
    w.cloud
      .on('POST', ISSUE, { status: 200, body: withEdgeProof })
      .on('POST', CONFIRM, { networkError: true });
    expect(await w.dispatcher.dispatch(rotate, w.link)).toBe('failed');
    expect(readRemoteState().credentialId).toBe(CURRENT.credentialId);
    expect(await w.store.get(`remote-tunnel-${withEdgeProof.credentialId}`)).toBeNull();
    expect(await w.store.get(`remote-tunnel-${CURRENT.credentialId}`)).toBe(CURRENT.value);
  });

  it('does not switch when the link ended before the confirm came back', async () => {
    w.cloud
      .on('POST', ISSUE, { status: 200, body: withEdgeProof })
      .on('POST', CONFIRM, confirmed());
    // The link ends the moment Cloud has been asked to confirm.
    const captured = w.cloud.capture()!;
    const link = {
      context: {
        client: captured.client,
        isCurrent: () => captured.isCurrent() && w.cloud.callsTo('POST', CONFIRM).length === 0,
      },
      instanceId: INSTANCE_ID,
    };
    expect(await w.dispatcher.dispatch(rotate, link)).toBe('refused:stale-link');
    expect(readRemoteState().credentialId).toBe(CURRENT.credentialId);
    expect(await w.store.get(`remote-tunnel-${withEdgeProof.credentialId}`)).toBeNull();
  });

  it('reports a failed switch and keeps the confirmed replacement stored', async () => {
    w.tunnel.phase = 'open';
    w.tunnel.failWith = { ok: false, reason: 'forward_failed', message: 'no' };
    w.cloud
      .on('POST', ISSUE, { status: 200, body: withEdgeProof })
      .on('POST', CONFIRM, confirmed());
    expect(await w.dispatcher.dispatch(rotate, w.link)).toBe('failed');
    expect(readRemoteState().credentialId).toBe(withEdgeProof.credentialId);
    expect((await w.credentials.resolve(readRemoteState())).ok).toBe(true);
  });
});

describe('revoke', () => {
  it('forgets the credential in use and closes at once; a later open cannot recover it', async () => {
    w.tunnel.phase = 'open';
    expect(await w.dispatcher.dispatch(revoke(CURRENT.credentialId), w.link)).toBe('applied');
    expect(w.tunnel.closeManaged).toHaveBeenCalledWith({ immediate: true });
    expect(readRemoteState()).toMatchObject({
      credentialId: null,
      credentialRef: null,
      edgeProofRef: null,
      enrolmentId: 'enr_0001',
    });
    expect(await w.store.get(`remote-tunnel-${CURRENT.credentialId}`)).toBeNull();
    expect(
      await w.dispatcher.dispatch({ ...open, id: 'cmd_open_2' } as LeasedCommand, w.link)
    ).toBe('refused:no-credential');
  });

  it('only forgets a credential that is not the one in use', async () => {
    w.tunnel.phase = 'open';
    expect(await w.dispatcher.dispatch(revoke('cred_old'), w.link)).toBe('ignored');
    expect(w.tunnel.closeManaged).not.toHaveBeenCalled();
    expect(readRemoteState().credentialId).toBe(CURRENT.credentialId);
  });
});

describe('hostnameOf', () => {
  it('takes a bare host, a host with a port, or a URL, and refuses anything else', () => {
    expect(hostnameOf('Example-Instance.remote.invalid')).toBe('example-instance.remote.invalid');
    expect(hostnameOf('a.invalid:443')).toBe('a.invalid');
    expect(hostnameOf('https://a.invalid/path')).toBe('a.invalid');
    expect(hostnameOf('bad host')).toBeNull();
    expect(hostnameOf(undefined)).toBeNull();
  });
});
