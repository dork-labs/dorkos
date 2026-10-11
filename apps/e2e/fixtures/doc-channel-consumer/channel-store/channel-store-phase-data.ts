const create = Object.create;
const descriptors = Object.getOwnPropertyDescriptors;
const define = Object.defineProperties;
/** Preserve fixed prior-phase getters without copying their mutable values. No custody is issued. */
export function extendOriginalConsumerPhase<P extends object, N extends object>(
  prior: P,
  next: N
): P & N {
  return define(create(prior), descriptors(next)) as P & N;
}
