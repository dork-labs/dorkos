import type { IncomingMessage } from 'node:http';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../services/core/tunnel-manager.js', () => ({
  tunnelManager: { status: { url: null }, managedHosts: [] as string[] },
}));

import { tunnelManager } from '../../services/core/tunnel-manager.js';
import { markManagedIngress } from '../../services/core/remote/ingress-mark.js';
import { bypassesManagedIngress, managedHostGuard } from '../managed-host-guard.js';

function request(host: string): IncomingMessage {
  return { headers: { host } } as unknown as IncomingMessage;
}

function setManagedHosts(hosts: string[]): void {
  (tunnelManager as unknown as { managedHosts: string[] }).managedHosts = hosts;
}

afterEach(() => setManagedHosts([]));

describe('bypassesManagedIngress', () => {
  it('flags a managed hostname reaching the main listener directly', () => {
    setManagedHosts(['abc.remote.example']);
    expect(bypassesManagedIngress(request('ABC.remote.example:443'))).toBe(true);
  });

  it('lets the same hostname through once the managed ingress admitted it', () => {
    setManagedHosts(['abc.remote.example']);
    const req = request('abc.remote.example');
    markManagedIngress(req);
    expect(bypassesManagedIngress(req)).toBe(false);
  });

  it('leaves local names and the own-account tunnel alone', () => {
    setManagedHosts(['abc.remote.example']);
    expect(bypassesManagedIngress(request('localhost:4242'))).toBe(false);
    expect(bypassesManagedIngress(request('byo.ngrok.app'))).toBe(false);
  });

  it('flags nothing while managed access is closed', () => {
    expect(bypassesManagedIngress(request('abc.remote.example'))).toBe(false);
  });
});

describe('managedHostGuard', () => {
  it('answers 403 and never calls next for a bypass', () => {
    setManagedHosts(['abc.remote.example']);
    const json = vi.fn();
    const res = { status: vi.fn(() => ({ json })) };
    const next = vi.fn();
    managedHostGuard(request('abc.remote.example') as never, res as never, next);
    expect(res.status).toHaveBeenCalledWith(403);
    expect(next).not.toHaveBeenCalled();
  });
});
