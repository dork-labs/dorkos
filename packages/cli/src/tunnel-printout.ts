/**
 * The startup printout for the tunnel address — the public URL someone opens
 * DorkOS on from their phone, and a QR code for getting there without typing.
 *
 * Lives in its own module because it has to be handed the tunnel manager the
 * RUNNING server owns rather than reaching for one itself. `packages/cli` ships
 * as two bundles — `dist/bin/cli.js` and `dist/server/index.js` — and every
 * `apps/server/src` module the CLI imports directly is INLINED into the CLI
 * bundle. So importing `services/core/tunnel-manager.js` here would build a
 * second, private `TunnelManager` that nothing ever starts, and the address
 * would never print (DOR-1745). `../server/index.js` is the one specifier that
 * stays external, so the live manager comes through there and is passed in.
 *
 * @module tunnel-printout
 */
import type { TunnelStatus } from '@dorkos/shared/types';
import { link } from './terminal-link.js';

/**
 * The part of the server's tunnel manager this printout needs: the current
 * status, and notice when it changes.
 *
 * Deliberately narrower than `TunnelManager` — the CLI reports on the tunnel,
 * it does not open or close one.
 */
export interface TunnelStatusSource {
  /** The tunnel's status right now. */
  readonly status: TunnelStatus;
  /**
   * Subscribe to status changes.
   *
   * @param event - Always `status_change`.
   * @param listener - Called with the new status.
   */
  on(event: 'status_change', listener: (status: TunnelStatus) => void): unknown;
}

/**
 * Print the tunnel address whenever there is one, for as long as this process
 * runs — the tunnel started at boot with `--tunnel`, and one turned on later
 * from Remote Access in the app, both arrive here.
 *
 * The SUBSCRIPTION is the path that does the work, including at boot. The
 * server's `start()` is never awaited, so importing the server hands control
 * back long before a tunnel could be up, and every address in practice arrives
 * as a change. Reading the current status is only there to close the gap
 * between constructing this and subscribing — which is why it happens second.
 *
 * Each address prints once: the manager announces a dropped tunnel and its
 * reconnect as two more changes, and reprinting an address that never changed
 * would read as a second tunnel.
 *
 * @param source - The tunnel manager belonging to the running server.
 */
export function attachTunnelPrintout(source: TunnelStatusSource): void {
  let printedUrl: string | null = null;

  const print = async (status: TunnelStatus): Promise<void> => {
    if (!status.connected || !status.url || status.url === printedUrl) return;
    printedUrl = status.url;
    const url = status.url;

    console.log('');
    console.log(`  Tunnel:  ${link(url, url)}`);

    // The QR code is a convenience on top of the address, so a `qrcode-terminal`
    // that will not load costs the convenience and nothing else.
    try {
      const qrcode = await import('qrcode-terminal');
      // Called as a METHOD, deliberately. `generate` reads `this.error_level`,
      // so a detached `const generate = qrcode.generate` throws "bad rs block
      // @ typeNumber:1/errorCorrectLevel:undefined" — which the catch below
      // then swallowed, so no QR code has ever printed (DOR-1745).
      const generator = qrcode.default ?? qrcode;
      console.log('');
      console.log('  Scan to open on mobile:');
      generator.generate(url, { small: true }, (code: string) => {
        // Indent each line of the QR code to match the rest of the banner.
        console.log(
          code
            .split('\n')
            .map((line: string) => `  ${line}`)
            .join('\n')
        );
      });
    } catch {
      // qrcode-terminal not available — skip the QR code.
    }
    console.log('');
  };

  source.on('status_change', (status) => void print(status));
  void print(source.status);
}
