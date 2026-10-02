import { parseDestination, type CanonicalDestination } from './destination.js';
import { classifyAddress, type NumericAddress } from './addresses.js';
import { settings, binding, type EgressPolicyOptions, type EgressBinding } from './settings.js';
import { resolveDestination } from './resolution.js';
import { localGrants, type LocalDestinationGrant } from './grants.js';
import { EgressPolicyError } from './errors.js';

/** A numeric socket endpoint; future forwarding must use it without another hostname lookup. */
export interface PinnedEndpoint {
  readonly address: string;
  readonly family: 4 | 6;
  readonly port: number;
}
/** A validated decision, not a live broker lease or permission to launch a production browser. */
export interface DestinationDecision {
  readonly revision: number;
  readonly binding: Readonly<EgressBinding>;
  readonly destination: CanonicalDestination;
  readonly endpoints: readonly PinnedEndpoint[];
  readonly scope: 'public' | 'local';
  readonly expiresAt?: number;
}

/** Construct complete inert policy primitives; no resolver defaults, sockets or browser activation. */
export function createEgressPolicy(options: EgressPolicyOptions) {
  const policy = settings(options);
  const grants = localGrants(policy.now);
  const publicPort = (target: CanonicalDestination) => {
    if (target.port !== 80 && target.port !== 443) throw new EgressPolicyError('FORBIDDEN_PORT');
  };
  const checkAddress = (address: NumericAddress, target: CanonicalDestination) => {
    policy.checkAddress(address.address, target);
    if (address.kind !== 'global') throw new EgressPolicyError('ADDRESS_DENIED');
  };
  return Object.freeze({
    issueLocalGrant(context: EgressBinding, url: string, expiresAt: number): LocalDestinationGrant {
      const target = parseDestination({ url });
      policy.checkAdmin(target);
      policy.checkAddress(target.hostname, target);
      if (!target.family || classifyAddress(target.hostname).kind !== 'loopback')
        throw new EgressPolicyError('GRANT_REFUSED');
      const parsed = new URL(url);
      if (parsed.pathname !== '/' || parsed.search || parsed.hash)
        throw new EgressPolicyError('GRANT_REFUSED');
      return grants.issue(binding(context), target, expiresAt);
    },
    revokeLocalGrant(grant: LocalDestinationGrant): void {
      grants.revoke(grant);
    },
    async authorize(input: {
      url: string;
      hostHeader?: string;
      context: EgressBinding;
      grant?: LocalDestinationGrant;
      signal?: AbortSignal;
    }): Promise<DestinationDecision> {
      const context = binding(input.context);
      const target = parseDestination(input);
      policy.checkAdmin(target);
      if (input.signal?.aborted) throw new EgressPolicyError('ABORTED');
      let addresses: readonly NumericAddress[];
      let expiresAt: number | undefined;
      if (target.family) {
        const address = classifyAddress(target.hostname);
        policy.checkAddress(address.address, target);
        if (address.kind === 'loopback') expiresAt = grants.validate(input.grant, context, target);
        else {
          publicPort(target);
          checkAddress(address, target);
        }
        addresses = [address];
      } else {
        publicPort(target);
        addresses = await resolveDestination({
          hostname: target.hostname,
          resolver: policy.resolver,
          signal: input.signal,
          checkHostname: (hostname) =>
            policy.checkAdmin({ ...target, hostname, authority: `${hostname}:${target.port}` }),
          checkAddress: (address) => checkAddress(address, target),
        });
      }
      return Object.freeze({
        revision: policy.revision,
        binding: context,
        destination: target,
        endpoints: Object.freeze(
          addresses.map((address) =>
            Object.freeze({ address: address.address, family: address.family, port: target.port })
          )
        ),
        scope: expiresAt === undefined ? 'public' : 'local',
        ...(expiresAt === undefined ? {} : { expiresAt }),
      });
    },
  });
}
