/**
 * The ONE place `zod` is taught `.openapi()`, and the one place a memory bug in
 * that teaching is repaired.
 *
 * Every `*-schemas.ts` module in this package used to import
 * `extendZodWithOpenApi` straight from `@asteasolutions/zod-to-openapi` and call
 * it itself. That is still what happens underneath — the call is idempotent and
 * patches a prototype on the single `zod` instance — but it now happens here,
 * once, so the repair below cannot be forgotten by the next schema file.
 *
 * ## The repair
 *
 * `@asteasolutions/zod-to-openapi@9.1.0` BUNDLES its own copy of zod's
 * `$ZodRegistry`, frozen at a revision where the schema map was a strong `Map`.
 * Zod's own copy has since become a `WeakMap` (`zod@4.4.3`,
 * `v4/core/registries.js`), but the bundled one did not follow, and the package
 * keeps a module-level `zodToOpenAPIRegistry` built from it. So every schema
 * `.openapi()` is ever called on — and `.openapi()` is called on nested schemas
 * too — is pinned in that map for the lifetime of the process. Nothing ever
 * iterates the map (`add`/`get`/`has`/`remove` only, all keyed by the schema
 * object), so the strong reference buys nothing and costs everything.
 *
 * In production that is invisible: the schema modules evaluate once and the
 * registry holds exactly one generation. In the test suite it is not, because
 * `vi.resetModules()` re-evaluates the schema modules while the registry — being
 * a node_modules singleton that no reset can reach — keeps every generation
 * before it. `apps/server/src/routes/__tests__/config.test.ts` re-imports the
 * config router 91 times and measured a linear ~31 MB per import, ~21 MB of it
 * this map, peaking at 4,015 MB against V8's ~4 GB ceiling. That is DOR-1577:
 * a worker fork dying with `FATAL ERROR: JavaScript heap out of memory`, on this
 * machine and intermittently in CI, on a file whose authors had already been
 * forced to merge tests together to stay under the limit.
 *
 * Swapping the map for a `WeakMap` is behaviour-preserving by inspection: the
 * keys are always schema objects, and every reader already holds the schema it
 * is asking about, so an entry can only vanish once nobody could ask for it.
 * Existing entries are carried across rather than dropped, and the swap is
 * skipped if it already happened, so importing this module twice — which the
 * server's test aliases genuinely cause, once from `src/` and once from
 * `dist/` — cannot lose metadata.
 *
 * Remove this when the upstream package stops bundling its own registry, or
 * bundles one whose map is weak. `zod-openapi-registry.test.ts` fails loudly if
 * an upgrade changes the shape this reaches into.
 *
 * @module shared/zod-openapi
 */
import { z } from 'zod';
import { extendZodWithOpenApi, zodToOpenAPIRegistry } from '@asteasolutions/zod-to-openapi';

/** The bundled registry's private shape, as far as this repair needs it. */
interface RegistryInternals {
  _map: Map<object, unknown> | WeakMap<object, unknown>;
}

/**
 * Replace the bundled registry's strong schema map with a weak one, carrying
 * any entries already in it across. A no-op once the map is already weak.
 */
function weakenOpenApiRegistry(): void {
  const internals = zodToOpenAPIRegistry as unknown as RegistryInternals;
  const strong = internals._map;
  if (!(strong instanceof Map)) return;
  const weak = new WeakMap<object, unknown>();
  for (const [schema, metadata] of strong) weak.set(schema, metadata);
  internals._map = weak;
}

/**
 * Teach `zod` the `.openapi()` method the schema modules annotate with, and
 * repair the metadata leak described in this module's docs.
 *
 * Call it at the top of any module that uses `.openapi()`. Both halves are
 * idempotent, so calling it from every such module is correct and cheap — and
 * is what keeps a module that is loaded on its own from depending on some other
 * module having been imported first.
 */
export function extendZodWithOpenApiOnce(): void {
  extendZodWithOpenApi(z);
  weakenOpenApiRegistry();
}
