/**
 * The Capability Registry catalog, as the cockpit reads it.
 *
 * One entity because the catalog answers a question no other slice owns: what
 * the server's capabilities DECLARE. The per-runtime capability matrix in
 * `entities/runtime` answers what a RUNTIME can do and shares only a word.
 *
 * @module entities/capability
 */
export {
  capabilityCatalogKey,
  useCapabilityCatalog,
  useToolNamesForGroup,
} from './model/use-capability-catalog';
