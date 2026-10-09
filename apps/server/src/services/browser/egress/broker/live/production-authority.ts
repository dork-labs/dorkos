import { createBrowserAuthorityCore } from './authority-core.js';
import { createProductionBrowserRuntimeOwner } from '../../../runtime/production-owner.js';

const originals = new WeakSet<ProductionBrowserAuthority>();
/** Genuine SQL/session/workspace authority plus exact fresh native owner; no fixture constructor.
 * This grants neither config opt-in nor controller/view authority, which remain separately owned. */
export function createProductionBrowserAuthority(
  options: Omit<Parameters<typeof createBrowserAuthorityCore>[0], 'checkOwnedOrigins'>
) {
  const runtime = createProductionBrowserRuntimeOwner();
  const authority = createBrowserAuthorityCore(options, runtime);
  const stopAndJoin = authority.stopAndJoin.bind(authority);
  const closeRuntime = runtime.close.bind(runtime);
  let closing: Promise<void> | undefined;
  const original = Object.freeze({
    ...authority,
    runtime,
    close(): Promise<void> {
      if (closing) return closing;
      let done!: () => void, reject!: (reason: unknown) => void;
      closing = new Promise<void>((yes, no) => {
        done = yes;
        reject = no;
      });
      let failed = false,
        first: unknown;
      const fail = (reason: unknown) => {
        if (!failed) {
          failed = true;
          first = reason;
        }
      };
      const jobs: Promise<unknown>[] = [];
      // Enter both original fences independently before waiting for either natural settlement.
      for (const effect of [stopAndJoin, closeRuntime]) {
        try {
          jobs.push(Promise.resolve(effect()));
        } catch (error) {
          fail(error);
        }
      }
      void Promise.allSettled(jobs).then((results) => {
        for (const result of results) if (result.status === 'rejected') fail(result.reason);
        if (failed) reject(first);
        else done();
      });
      return closing;
    },
  });
  originals.add(original);
  return original;
}
export type ProductionBrowserAuthority = ReturnType<typeof createProductionBrowserAuthority>;
/** Only the exact genuine factory object can participate in production settings publication. */
export function isOriginalProductionBrowserAuthority(
  value: unknown
): value is ProductionBrowserAuthority {
  return (
    typeof value === 'object' &&
    value !== null &&
    originals.has(value as ProductionBrowserAuthority)
  );
}
