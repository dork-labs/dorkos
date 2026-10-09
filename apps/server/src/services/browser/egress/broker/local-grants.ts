import type { createEgressPolicy } from '../policy.js';
import { parseDestination } from '../destination.js';
import type { LocalDestinationGrant } from '../grants.js';
import type { BrokerIssuer, RunHandle } from './issuer.js';
import { BrokerError } from './errors.js';
import type { Charge } from './ledger.js';
/** Transport scope is bound to trusted issuance, never inferred from CONNECT TLS contents. */
export type LocalTransport = 'http' | 'websocket' | 'websocket-connect' | 'opaque-connect';
/** Principal-scoped local adapter; permanent denies remain enforced by the original policy. */
export function brokerLocalGrants(
  issuer: BrokerIssuer,
  run: RunHandle,
  policy: ReturnType<typeof createEgressPolicy>,
  onGap: () => void = () => {}
) {
  const records = new Map<
    string,
    {
      grant: LocalDestinationGrant;
      deadline: number;
      revision: number;
      charge: Charge;
    }
  >();
  const key = (url: string, transport: LocalTransport) =>
    `${transport}:${parseDestination({ url }).authority}`;
  const revoke = () => {
    for (const r of records.values()) {
      policy.revokeLocalGrant(r.grant);
      issuer.ledger.release(r.charge);
    }
    records.clear();
  };
  const covered = (revision: number) => {
    try {
      const i = issuer.inventory(),
        state = issuer.snapshot(run);
      if (
        state.state !== 'active' ||
        state.inventoryRevision !== revision ||
        !i.localCoverageComplete ||
        i.revision !== revision
      )
        throw new BrokerError('AUTHORITY_REFUSED');
    } catch (error) {
      revoke();
      onGap();
      throw error;
    }
  };
  return Object.freeze({
    issue(
      url: string,
      transport: LocalTransport,
      ttl: number,
      onOriginalDenial?: (value: BrokerError) => void
    ) {
      const report = onOriginalDenial;
      const denial = (reason: 'AUTHORITY_REFUSED' | 'PERMIT_REFUSED') => {
        const original = new BrokerError(reason);
        report?.(original);
        return original;
      };
      const state = issuer.check(run),
        target = parseDestination({ url }),
        i = issuer.inventory();
      covered(i.revision);
      if (
        !['http', 'websocket', 'websocket-connect', 'opaque-connect'].includes(transport) ||
        i.revision !== state.inventory ||
        !i.localCoverageComplete ||
        !['127.0.0.1', '::1'].includes(target.hostname) ||
        !Number.isSafeInteger(ttl) ||
        ttl <= 0 ||
        ttl > 300000 ||
        i.protectedEndpoints.some((e) => e.address === target.hostname && e.port === target.port) ||
        (transport === 'http' && target.scheme !== 'http') ||
        ((transport === 'websocket' || transport === 'websocket-connect') &&
          target.scheme !== 'ws') ||
        (transport === 'opaque-connect' && target.scheme !== 'https')
      )
        throw denial('AUTHORITY_REFUSED');
      const id = key(url, transport);
      if (records.has(id)) throw denial('PERMIT_REFUSED');
      const charge = issuer.ledger.reserve('permit');
      try {
        const deadline = issuer.now() + ttl;
        const grant = policy.issueLocalGrant(state.binding, url, deadline);
        try {
          issuer.check(run);
          covered(i.revision);
        } catch (error) {
          policy.revokeLocalGrant(grant);
          throw error;
        }
        records.set(id, { grant, deadline, revision: i.revision, charge });
      } catch (error) {
        issuer.ledger.release(charge);
        throw error;
      }
    },
    get(url: string, transport: LocalTransport) {
      const r = records.get(key(url, transport));
      if (!r) return undefined;
      const current = issuer.now();
      issuer.check(run);
      covered(r.revision);
      if (records.get(key(url, transport)) !== r || current >= r.deadline)
        throw new BrokerError('EXPIRED');
      return r.grant;
    },
    check: covered,
    revoke,
  });
}
