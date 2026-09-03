/**
 * Whether this browser is on the machine DorkOS runs on.
 *
 * Some actions can only ever happen there — signing a runtime in, pasting an API
 * key, installing a runtime — because they spawn a program or write a secret on
 * that machine. Their endpoints are loopback-only and answer everyone else with
 * a 403, so a surface that offers them from a phone is offering a button that
 * cannot work (DOR-1655).
 *
 * The answer is the SERVER's, not a guess assembled from `window.location`.
 * `GET /api/config` reports `isLocalCaller` per request, computed by the very
 * reader those endpoints refuse with (`apps/server/src/lib/caller-authority.ts`), so
 * what this hook says and what the endpoint would do cannot drift apart. A
 * hostname check here would drift immediately: `localhost` names whichever
 * machine is looking at the page, a LAN address and a reverse-proxy name look
 * nothing alike, and none of them knows about `DORKOS_ALLOW_INSECURE_BIND`.
 *
 * @module entities/config/model/use-local-caller
 */
import { useConfig } from './use-config';

/**
 * Read whether this browser can run the actions that only work on the machine
 * DorkOS runs on.
 *
 * ## An unknown answer reads as local, deliberately
 *
 * Before the config read lands — and if it fails outright — this returns `true`.
 * The only thing a surface does with a `false` is tell someone their action has
 * to happen on a different computer, and saying that on the strength of a
 * missing answer would be a guess dressed as a fact. A server too old to report
 * the field lands here too, and gets exactly the behaviour it had before.
 *
 * What that costs is a moment: a remote surface renders its local form until
 * the answer arrives, then swaps. It is a moment nobody meets in practice —
 * `useConfig` is read at boot and shared through one cache entry, so by the
 * time a transcript can show an auth error the answer is already sitting there
 * — and the endpoint's own honest refusal is the floor underneath it either
 * way. Holding every such surface blank until the read settles would have bought
 * nothing real and made each of them wait on a query it otherwise never blocks
 * on.
 *
 * @returns `true` when this browser is on the machine DorkOS runs on, or when
 *   that is not yet known.
 */
export function useLocalCaller(): boolean {
  return useConfig().data?.isLocalCaller !== false;
}
