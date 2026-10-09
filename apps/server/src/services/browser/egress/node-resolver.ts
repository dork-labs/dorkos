import { Resolver } from 'node:dns';
import { isIP } from 'node:net';
import { canonicalHostname } from './destination.js';
import { EgressPolicyError } from './errors.js';
import type { DestinationResolver, DnsObservation } from './resolution.js';

type OriginalCancellation = {
  returned: boolean;
  callbacks: Readonly<{ value: unknown; expected: boolean }>[];
  duplicate: boolean;
};
type OriginalFamily = { pending: boolean; cancellation?: OriginalCancellation };
type OriginalResolution = {
  work: Promise<DnsObservation>;
  families: Set<OriginalFamily>;
  cancel?: () => void;
  remove?: () => void;
  abort?: Readonly<{ value: unknown }>;
  fault?: Readonly<{ value: unknown }>;
};
/** Genuine Node resolver ownership; original callbacks remain joined through cancellation. */
export function createProductionDestinationResolver() {
  const owners = new Set<OriginalResolution>();
  let stopped = false;
  let first: Readonly<{ value: unknown }> | undefined;
  let closing: Promise<void> | undefined;
  const resolve: DestinationResolver = (name, signal) => {
    if (first) return Promise.reject(first.value);
    if (stopped || owners.size >= 32) return Promise.reject(new EgressPolicyError('DNS_LIMIT'));
    let done!: (value: DnsObservation) => void, reject!: (value: unknown) => void;
    const work = new Promise<DnsObservation>((yes, no) => {
      done = yes;
      reject = no;
    });
    const owner: OriginalResolution = { work, families: new Set() };
    owners.add(owner); // Whole original work precedes constructor, method and signal getters.
    const guard = () => {
      if (stopped || signal.aborted) {
        owner.abort ??= Object.freeze({
          value: signal.aborted ? signal.reason : new EgressPolicyError('ABORTED'),
        });
        throw owner.abort;
      }
    };
    const cancel = () => {
      if (!owner.abort)
        owner.abort = Object.freeze({
          value: signal.aborted ? signal.reason : new EgressPolicyError('ABORTED'),
        });
      try {
        owner.cancel?.();
      } catch (value) {
        first ??= Object.freeze({ value });
      }
    };
    void (async () => {
      let failure: Readonly<{ value: unknown }> | undefined;
      let result: DnsObservation | undefined;
      try {
        const hostname = canonicalHostname(name);
        if (isIP(hostname)) throw new EgressPolicyError('DNS_FAILED');
        guard();
        const original = new Resolver({ timeout: 500, tries: 1 });
        const cancelOriginal = original.cancel.bind(original);
        owner.cancel = () => {
          const cancellation: OriginalCancellation = {
            returned: false,
            callbacks: [],
            duplicate: false,
          };
          // Stamp only original callbacks still pending at this exact owned cancel entry.
          for (const family of owner.families)
            if (family.pending) family.cancellation ??= cancellation;
          try {
            cancelOriginal();
            cancellation.returned = true;
            for (const fault of cancellation.callbacks)
              if (!fault.expected) {
                owner.fault ??= fault;
                first ??= fault;
              }
          } catch (value) {
            // Synchronous callbacks preceded this thrown original cancel; none was qualified.
            for (const failure of cancellation.callbacks) {
              owner.fault ??= failure;
              first ??= failure;
            }
            throw value;
          }
        };
        // A close entered through a getter must still cancel this exact returned resolver.
        if (stopped || signal.aborted) {
          cancel();
          guard();
        }
        const a = original.resolve4.bind(original);
        guard();
        const aaaa = original.resolve6.bind(original);
        guard();
        const cname = original.resolveCname.bind(original);
        guard();
        const add = signal.addEventListener.bind(signal);
        guard();
        const remove = signal.removeEventListener.bind(signal);
        guard();
        owner.remove = () => remove('abort', cancel);
        add('abort', cancel, { once: true });
        guard();
        const read = (
          method: (
            hostname: string,
            callback: (error: NodeJS.ErrnoException | null, values: string[]) => void
          ) => void
        ) =>
          Promise.resolve().then(async () => {
            guard();
            const family: OriginalFamily = { pending: true };
            owner.families.add(family);
            let invocationFailure: Readonly<{ value: unknown }> | undefined;
            let callbackFailure:
              | Readonly<{
                  value: unknown;
                  code: unknown;
                  cancellation: OriginalCancellation | undefined;
                }>
              | undefined;
            const originalWork = new Promise<string[]>((yes, no) => {
              const callback = (error: unknown, values: string[]) => {
                if (!family.pending) {
                  const fault = Object.freeze({
                    value: new EgressPolicyError('DNS_FAILED'),
                    expected: false,
                  });
                  if (family.cancellation && !family.cancellation.returned) {
                    if (!family.cancellation.duplicate) family.cancellation.callbacks.push(fault);
                    family.cancellation.duplicate = true;
                  } else {
                    owner.fault ??= fault;
                    first ??= fault;
                  }
                  return;
                }
                family.pending = false;
                owner.families.delete(family);
                if (error !== null) {
                  let code: unknown;
                  try {
                    if (typeof error === 'object' && error !== null)
                      code = Object.getOwnPropertyDescriptor(error, 'code')?.value;
                  } catch {
                    /* Preserve the original callback value. */
                  }
                  callbackFailure = Object.freeze({
                    value: error,
                    code,
                    cancellation: family.cancellation,
                  });
                  if (code !== 'ENODATA' && code !== 'ENOTFOUND') {
                    const fault = Object.freeze({ value: error, expected: code === 'ECANCELLED' });
                    if (family.cancellation && !family.cancellation.returned)
                      family.cancellation.callbacks.push(fault);
                    else if (!(code === 'ECANCELLED' && family.cancellation?.returned)) {
                      owner.fault ??= fault;
                      first ??= fault;
                    }
                  }
                  no(error);
                } else yes(values);
              };
              try {
                method(hostname, callback);
              } catch (value) {
                family.pending = false;
                owner.families.delete(family);
                invocationFailure = Object.freeze({ value });
                owner.fault ??= invocationFailure;
                first ??= invocationFailure;
                no(value);
              }
            });
            try {
              const values = await originalWork;
              if (invocationFailure) throw invocationFailure.value;
              return values;
            } catch (value) {
              if (invocationFailure) {
                if (
                  callbackFailure &&
                  callbackFailure.code !== 'ENODATA' &&
                  callbackFailure.code !== 'ENOTFOUND'
                )
                  throw callbackFailure.value;
                throw invocationFailure.value;
              }
              // Only the genuine callback can establish family absence or owned cancellation.
              const code = callbackFailure?.code;
              if (
                code === 'ECANCELLED' &&
                owner.abort &&
                callbackFailure &&
                Object.is(callbackFailure.value, value) &&
                callbackFailure.cancellation?.returned
              )
                throw owner.abort;
              if (code === 'ENODATA' || code === 'ENOTFOUND') return [];
              throw value;
            }
          });
        const jobs = [read(a), read(aaaa), read(cname)];
        const facts = await Promise.allSettled(jobs);
        failure ??= owner.fault;
        for (const fact of facts)
          if (fact.status === 'rejected') failure ??= Object.freeze({ value: fact.reason });
        if (!failure) {
          guard();
          const values = facts.map((fact) => (fact.status === 'fulfilled' ? fact.value : []));
          if (
            values.some((value) => value.length > 64) ||
            values[2]!.length > 1 ||
            values[0]!.some((value) => isIP(value) !== 4) ||
            values[1]!.some((value) => isIP(value) !== 6)
          )
            throw new EgressPolicyError('DNS_LIMIT');
          result = Object.freeze({
            a: Object.freeze([...values[0]!]),
            aaaa: Object.freeze([...values[1]!]),
            cname: Object.freeze(values[2]!.map(canonicalHostname)),
          });
        }
      } catch (value) {
        failure ??= Object.freeze({ value });
      }
      try {
        owner.remove?.();
      } catch (value) {
        first ??= Object.freeze({ value });
        failure ??= Object.freeze({ value });
      }
      // Expected cancellation is identified by this owner's exact retained token, never an error class.
      if (failure && (!owner.abort || failure.value !== owner.abort)) first ??= failure;
      if (failure)
        throw owner.abort && failure.value === owner.abort ? owner.abort.value : failure.value;
      return result!;
    })().then(done, reject);
    void work.then(
      () => owners.delete(owner),
      () => owners.delete(owner)
    );
    return work;
  };
  return Object.freeze({
    resolve,
    /** Fence synchronously, cancel each original independently, then join every admitted operation. */
    close(): Promise<void> {
      if (closing) return closing;
      let done!: () => void, reject!: (value: unknown) => void;
      closing = new Promise<void>((yes, no) => {
        done = yes;
        reject = no;
      });
      stopped = true;
      const originals = [...owners];
      for (const owner of originals) {
        owner.abort ??= Object.freeze({ value: new EgressPolicyError('ABORTED') });
        try {
          owner.cancel?.();
        } catch (value) {
          first ??= Object.freeze({ value });
        }
      }
      void Promise.allSettled(originals.map((owner) => owner.work)).then(() => {
        if (first) reject(first.value);
        else done();
      }, reject);
      return closing;
    },
  });
}
