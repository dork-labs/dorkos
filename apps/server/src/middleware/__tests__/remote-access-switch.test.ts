/**
 * Which requests the Remote Access switch refuses while it is off (DOR-3650):
 * the relay and every other device, never this computer, and never a browser
 * reaching a Docker install through its own published port, which is how its
 * owner reaches it at all.
 *
 * Nothing is faked: the config is real, on a throwaway data directory, and the
 * container flag is the real environment variable, read when the modules load.
 *
 * @vitest-environment node
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { IngressKind } from '../../services/core/remote/ingress-mark.js';

const AMBIENT_INSECURE_BIND = process.env.DORKOS_ALLOW_INSECURE_BIND;
let dorkHome: string | undefined;

afterEach(() => {
  if (dorkHome) fs.rmSync(dorkHome, { recursive: true, force: true });
  dorkHome = undefined;
  if (AMBIENT_INSECURE_BIND === undefined) delete process.env.DORKOS_ALLOW_INSECURE_BIND;
  else process.env.DORKOS_ALLOW_INSECURE_BIND = AMBIENT_INSECURE_BIND;
  vi.resetModules();
});

/**
 * The switch's check, loaded fresh over a real config with Remote Access set
 * as asked, and the container flag on or off.
 */
async function loadSwitch(opts: { remoteOn: boolean; insecureBind: boolean }) {
  if (opts.insecureBind) process.env.DORKOS_ALLOW_INSECURE_BIND = 'true';
  else delete process.env.DORKOS_ALLOW_INSECURE_BIND;
  dorkHome = fs.mkdtempSync(path.join(os.tmpdir(), 'dorkos-remote-switch-'));
  const { initConfigManager } = await import('../../services/core/config-manager.js');
  initConfigManager(dorkHome).set('remoteAccess', { enabled: opts.remoteOn });
  return (await import('../remote-access-switch.js')).refusedByRemoteAccessSwitch;
}

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

describe('refusedByRemoteAccessSwitch', () => {
  it('refuses the relay while off', async () => {
    const refused = await loadSwitch({ remoteOn: false, insecureBind: false });
    expect(refused(RELAYED)).toBe(true);
  });

  it('lets the relay through while on', async () => {
    const refused = await loadSwitch({ remoteOn: true, insecureBind: false });
    expect(refused(RELAYED)).toBe(false);
  });

  it('never refuses this computer', async () => {
    const refused = await loadSwitch({ remoteOn: false, insecureBind: false });
    expect(refused(THIS_COMPUTER)).toBe(false);
  });

  it('never refuses a Docker install’s own published port, so its owner is not locked out', async () => {
    const refused = await loadSwitch({ remoteOn: false, insecureBind: true });
    expect(refused(CONTAINER_PORT)).toBe(false);
  });

  it('refuses the same request without the container flag: then it is another device', async () => {
    const refused = await loadSwitch({ remoteOn: false, insecureBind: false });
    expect(refused(CONTAINER_PORT)).toBe(true);
  });

  it('still refuses a proxy in front of a Docker install: only the bare port is the owner’s', async () => {
    const refused = await loadSwitch({ remoteOn: false, insecureBind: true });
    const proxied = facts('172.17.0.1', {
      host: '192.168.1.20:4242',
      'x-forwarded-for': '203.0.113.9',
    });
    expect(refused(proxied)).toBe(true);
  });
});
