import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'node:events';
import type { TunnelStatus } from '@dorkos/shared/types';
import { attachTunnelPrintout, type TunnelStatusSource } from '../tunnel-printout.js';

/**
 * The startup tunnel printout (DOR-1745).
 *
 * The bug this pins was not in the printing — it was in WHO was being listened
 * to. `attachTunnelPrintout` takes the tunnel manager as an argument for that
 * reason, so the caller has to hand it the running server's one and these tests
 * can hand it a stand-in. The seam itself is guarded by `server-shims.test.ts`,
 * which fails if the CLI goes back to importing the manager directly.
 */

const OFF: TunnelStatus = {
  enabled: false,
  connected: false,
  url: null,
  port: null,
  startedAt: null,
  authEnabled: false,
  tokenConfigured: false,
  domain: null,
  isRunning: false,
};

const connectedTo = (url: string): TunnelStatus => ({
  ...OFF,
  enabled: true,
  connected: true,
  url,
  port: 4242,
  isRunning: true,
});

/** A stand-in for the server's tunnel manager: a status plus `status_change`. */
class FakeTunnelManager extends EventEmitter implements TunnelStatusSource {
  status: TunnelStatus = OFF;

  /**
   * Move to a new status and announce it, the way `TunnelManager` does.
   *
   * @param next - The status to report.
   */
  change(next: TunnelStatus): void {
    this.status = next;
    this.emit('status_change', next);
  }
}

let lines: string[] = [];
let logSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  lines = [];
  logSpy = vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
    lines.push(args.map(String).join(' '));
  });
});

afterEach(() => {
  logSpy.mockRestore();
});

/** Everything printed so far, as one blob — the QR code included. */
const printed = () => lines.join('\n');

describe('attachTunnelPrintout', () => {
  it('prints an address the manager reports after it is attached', async () => {
    const manager = new FakeTunnelManager();
    attachTunnelPrintout(manager);

    expect(printed()).not.toContain('Tunnel:');

    manager.change(connectedTo('https://calm-otter.ngrok-free.app'));

    // The QR code arrives after the address — `qrcode-terminal` is loaded on
    // demand — so wait on the last thing printed, not the first.
    await vi.waitFor(() => expect(printed()).toContain('Scan to open on mobile:'));
    expect(printed()).toContain('Tunnel:');
    expect(printed()).toContain('https://calm-otter.ngrok-free.app');
    // The QR code itself, not just the label announcing one.
    expect(printed()).toMatch(/[█▀▄]/);
  });

  it('prints an address that was already up before it attached', async () => {
    const manager = new FakeTunnelManager();
    manager.status = connectedTo('https://already-up.ngrok-free.app');

    attachTunnelPrintout(manager);

    await vi.waitFor(() => expect(printed()).toContain('https://already-up.ngrok-free.app'));
  });

  it('prints an address once, however many times it is announced', async () => {
    const manager = new FakeTunnelManager();
    const up = connectedTo('https://steady.ngrok-free.app');
    attachTunnelPrintout(manager);

    manager.change(up);
    await vi.waitFor(() => expect(printed()).toContain('https://steady.ngrok-free.app'));

    // A drop and a reconnect: the same tunnel, at the same address.
    manager.change({ ...up, connected: false });
    manager.change(up);
    await vi.waitFor(() => expect(printed()).toContain('Scan to open on mobile:'));

    const occurrences = lines.filter((line) => line.includes('Tunnel:')).length;
    expect(occurrences).toBe(1);
  });

  it('prints a new address when the tunnel comes back on a different one', async () => {
    const manager = new FakeTunnelManager();
    attachTunnelPrintout(manager);

    manager.change(connectedTo('https://first.ngrok-free.app'));
    await vi.waitFor(() => expect(printed()).toContain('https://first.ngrok-free.app'));

    manager.change(connectedTo('https://second.ngrok-free.app'));
    await vi.waitFor(() => expect(printed()).toContain('https://second.ngrok-free.app'));

    expect(lines.filter((line) => line.includes('Tunnel:')).length).toBe(2);
  });

  it('says nothing while the tunnel is off, or connected without an address', async () => {
    const manager = new FakeTunnelManager();
    attachTunnelPrintout(manager);

    manager.change(OFF);
    manager.change({ ...OFF, enabled: true, connected: true, isRunning: true });

    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(printed()).not.toContain('Tunnel:');
  });
});
