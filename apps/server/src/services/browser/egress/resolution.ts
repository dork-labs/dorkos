import { canonicalHostname } from './destination.js';
import { isIP } from 'node:net';
import { classifyAddress, type NumericAddress } from './addresses.js';
import { EgressPolicyError } from './errors.js';

/** Complete A/AAAA/CNAME observation from an injected trusted resolver, never a browser reply. */
export interface DnsObservation {
  readonly a: readonly string[];
  readonly aaaa: readonly string[];
  readonly cname: readonly string[];
}
/** Resolver ownership remains outside this private policy; even ignored aborts have host deadlines. */
export type DestinationResolver = (
  hostname: string,
  signal: AbortSignal
) => Promise<DnsObservation>;
const CALLBACK_TIMEOUT_MS = 500;
const TOTAL_TIMEOUT_MS = 2000;
const MAX_DEPTH = 8;
const MAX_ANSWERS = 64;
const MAX_IN_FLIGHT_CALLBACKS = 32;

/** Retain admission slots until the actual callback settles, even after its policy timeout. */
export function boundedResolver(resolver: DestinationResolver): DestinationResolver {
  let active = 0;
  return async (hostname, signal) => {
    if (active >= MAX_IN_FLIGHT_CALLBACKS) throw new EgressPolicyError('DNS_LIMIT');
    active++;
    try {
      return await resolver(hostname, signal);
    } finally {
      active--;
    }
  };
}

function observation(value: unknown): DnsObservation {
  if (!value || typeof value !== 'object') throw new EgressPolicyError('DNS_FAILED');
  const item = value as Record<string, unknown>;
  if (Object.keys(item).sort().join(',') !== 'a,aaaa,cname')
    throw new EgressPolicyError('DNS_FAILED');
  const arrays = ['a', 'aaaa', 'cname'].map((key) => {
    const list = item[key];
    if (
      !Array.isArray(list) ||
      list.length > MAX_ANSWERS ||
      list.some((entry) => typeof entry !== 'string' || entry.length > 254)
    )
      throw new EgressPolicyError('DNS_LIMIT');
    return [...list] as string[];
  });
  if (arrays[2]!.length > 1) throw new EgressPolicyError('DNS_LIMIT');
  return { a: arrays[0]!, aaaa: arrays[1]!, cname: arrays[2]! };
}

async function callback(
  resolve: DestinationResolver,
  host: string,
  parent: AbortSignal
): Promise<DnsObservation> {
  const expires = performance.now() + CALLBACK_TIMEOUT_MS;
  const abort = new AbortController();
  let timeout: ReturnType<typeof setTimeout> | undefined;
  let rejectAbort: () => void = () => {};
  try {
    const cancelled = new Promise<never>((_, reject) => {
      rejectAbort = () => {
        abort.abort();
        reject(new EgressPolicyError('ABORTED'));
      };
      parent.addEventListener('abort', rejectAbort, { once: true });
      if (parent.aborted) rejectAbort();
      timeout = setTimeout(() => {
        abort.abort();
        reject(new EgressPolicyError('DNS_TIMEOUT'));
      }, CALLBACK_TIMEOUT_MS);
    });
    const value = await Promise.race([
      Promise.resolve().then(() => {
        if (abort.signal.aborted) throw new EgressPolicyError('ABORTED');
        return resolve(host, abort.signal);
      }),
      cancelled,
    ]);
    if (parent.aborted) throw new EgressPolicyError('ABORTED');
    if (performance.now() >= expires) throw new EgressPolicyError('DNS_TIMEOUT');
    return observation(value);
  } catch (error) {
    if (error instanceof EgressPolicyError) throw error;
    throw new EgressPolicyError('DNS_FAILED');
  } finally {
    clearTimeout(timeout);
    parent.removeEventListener('abort', rejectAbort);
    abort.abort();
  }
}

/** Validate every record at every bounded CNAME hop before selecting any numeric endpoint. */
export async function resolveDestination(options: {
  hostname: string;
  resolver: DestinationResolver;
  checkHostname: (hostname: string) => void;
  checkAddress: (address: NumericAddress) => void;
  signal?: AbortSignal;
}): Promise<readonly NumericAddress[]> {
  const abort = new AbortController();
  const expires = performance.now() + TOTAL_TIMEOUT_MS;
  const expire = setTimeout(() => abort.abort(), TOTAL_TIMEOUT_MS);
  const cancel = () => abort.abort();
  options.signal?.addEventListener('abort', cancel, { once: true });
  if (options.signal?.aborted) cancel();
  try {
    const seen = new Set<string>();
    const addresses = new Map<string, NumericAddress>();
    let host = options.hostname;
    let count = 0;
    for (let depth = 0; depth <= MAX_DEPTH; depth++) {
      if (seen.has(host)) throw new EgressPolicyError('DNS_CYCLE');
      seen.add(host);
      options.checkHostname(host);
      const answer = await callback(options.resolver, host, abort.signal);
      if (performance.now() >= expires) throw new EgressPolicyError('DNS_TIMEOUT');
      count += answer.a.length + answer.aaaa.length + answer.cname.length;
      if (count > MAX_ANSWERS) throw new EgressPolicyError('DNS_LIMIT');
      for (const [family, list] of [
        [4, answer.a],
        [6, answer.aaaa],
      ] as const) {
        for (const value of list) {
          const address = classifyAddress(value);
          if (address.family !== family) throw new EgressPolicyError('DNS_FAILED');
          options.checkAddress(address);
          addresses.set(address.address, address);
        }
      }
      if (!answer.cname.length) {
        if (!addresses.size) throw new EgressPolicyError('DNS_EMPTY');
        return Object.freeze([...addresses.values()]);
      }
      host = canonicalHostname(answer.cname[0]!);
      if (isIP(host)) throw new EgressPolicyError('DNS_FAILED');
    }
    throw new EgressPolicyError('DNS_LIMIT');
  } catch (error) {
    if (error instanceof EgressPolicyError) throw error;
    throw new EgressPolicyError('DNS_FAILED');
  } finally {
    clearTimeout(expire);
    options.signal?.removeEventListener('abort', cancel);
    abort.abort();
  }
}
