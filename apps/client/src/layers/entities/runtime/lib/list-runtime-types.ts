/**
 * Which runtimes a whole-fleet surface lists, and in what order.
 *
 * One rule, read by both surfaces that draw every runtime at once: the setup
 * panel's overview mode and the Runtimes settings tab. Written twice it would
 * drift the day a fourth runtime shipped, and the two would then disagree about
 * what this machine can run.
 *
 * @module entities/runtime/lib/list-runtime-types
 */
import { PRIMARY_RUNTIME_TYPES } from '../config/runtime-descriptors';

/**
 * DorkOS's three sibling runtimes, then every other registered one.
 *
 * The order is stable on purpose: the primaries always come first, in the
 * product's own order, and anything else is appended in registration order — so
 * a recheck that flips one runtime's state never reshuffles the list under
 * somebody's cursor. `test-mode` is left out: it is the e2e harness runtime, not
 * something a person connects.
 *
 * @param registeredTypes - Runtime types the capability map reports.
 */
export function listRuntimeTypes(registeredTypes: readonly string[]): string[] {
  const extras = registeredTypes.filter(
    (type) => !(PRIMARY_RUNTIME_TYPES as readonly string[]).includes(type) && type !== 'test-mode'
  );
  return [...PRIMARY_RUNTIME_TYPES, ...extras];
}
