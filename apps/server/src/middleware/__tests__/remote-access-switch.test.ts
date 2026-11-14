/**
 * Which requests the Remote Access switch refuses while it is off (DOR-3650):
 * the relay and every other device, never this computer, and never a browser
 * reaching a Docker install through its own published port, which is how its
 * owner reaches it at all.
 *
 * @vitest-environment node
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { IngressKind } from '../../services/core/remote/ingress-mark.js';

const state = vi.hoisted(() => ({ remoteOn: false, insecureBind: false }));

vi.mock('../../services/core/config-manager.js', () => ({
  configManager: {
    get: (key: string) => (key === 'remoteAccess' ? { enabled: state.remoteOn } : undefined),
  },
}));
vi.mock('../../env.js', () => ({
  env: {
    get DORKOS_ALLOW_INSECURE_BIND() {
      return state.insecureBind;
    },
  },
}));
vi.mock('../../services/core/auth/index.js', () => ({
  hasAnyUser: () => true,
  readOwnerAccount: () => ({ id: 'user_owner' }),
}));

import { refusedByRemoteAccessSwitch } from '../remote-access-switch.js';

/** A request's facts: who connected, its headers, and the listener that marked it. */
const facts = (
  peerAddress: string,
  headers: Record<string, string>,
  ingress: IngressKind | 'direct' = 'direct'
) => ({ peerAddress, headers, ingress });

const THIS_COMPUTER = facts('127.0.0.1', { host: 'localhost:4242' });
const RELAYED = facts('127.0.0.1', { host: 'localhost:4242' }, 'relay');
/** A browser reaching a Docker install through its published port: the bridge gateway, an IP Host. */
const CONTAINER_PORT = facts('172.17.0.1', { host: '192.168.1.20:4242' });

beforeEach(() => {
  state.remoteOn = false;
  state.insecureBind = false;
});

describe('refusedByRemoteAccessSwitch', () => {
  it('refuses the relay while off, and lets it through while on', () => {
    expect(refusedByRemoteAccessSwitch(RELAYED)).toBe(true);
    state.remoteOn = true;
    expect(refusedByRemoteAccessSwitch(RELAYED)).toBe(false);
  });

  it('never refuses this computer', () => {
    expect(refusedByRemoteAccessSwitch(THIS_COMPUTER)).toBe(false);
  });

  it('never refuses a Docker install’s own published port, so its owner is not locked out', () => {
    state.insecureBind = true;
    expect(refusedByRemoteAccessSwitch(CONTAINER_PORT)).toBe(false);
  });

  it('refuses the same request without the container flag: then it is another device', () => {
    expect(refusedByRemoteAccessSwitch(CONTAINER_PORT)).toBe(true);
  });

  it('still refuses a proxy in front of a Docker install: only the bare port is the owner’s', () => {
    state.insecureBind = true;
    const proxied = facts('172.17.0.1', {
      host: '192.168.1.20:4242',
      'x-forwarded-for': '203.0.113.9',
    });
    expect(refusedByRemoteAccessSwitch(proxied)).toBe(true);
  });
});
