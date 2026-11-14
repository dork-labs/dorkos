import { lookup } from 'node:dns/promises';
import http from 'node:http';

/**
 * Whether this machine can stage the DOR-4294 failure: `localhost` resolves to
 * IPv6 loopback, and something can listen there.
 *
 * That is the macOS default, and the shape that broke the shell's live updates:
 * the server bound `localhost`, got `::1` alone, and the shell dialled
 * `127.0.0.1`. A machine with no IPv6 loopback (some CI containers) cannot
 * reproduce it, and a server there would never have bound `::1` either, so the
 * tests that need it skip rather than fail.
 *
 * @returns `true` when a server listening only on `::1` is reachable as `localhost`.
 */
export async function canStageIpv6OnlyLocalhost(): Promise<boolean> {
  const addresses = await lookup('localhost', { all: true }).catch(() => []);
  if (!addresses.some((entry) => entry.address === '::1')) return false;
  const probe = http.createServer();
  return await new Promise<boolean>((resolve) => {
    probe.once('error', () => resolve(false));
    probe.listen(0, '::1', () => probe.close(() => resolve(true)));
  });
}
