/**
 * The last pass over a generated OpenAPI document: every operation gets its
 * `operationId` (`operation-ids.ts`), the `security` it needs where that
 * differs from the default (`security-schemes.ts`) and its `x-stability`
 * (`stability.ts`), in that order, and every nullable `$ref` is written as
 * `anyOf` (`nullable-refs.ts`).
 *
 * @module services/core/openapi/finish-document
 */
import { fixNullableRefs } from './nullable-refs.js';
import { assignOperationIds, type OperationIdDocument } from './operation-ids.js';
import { assignOperationSecurity } from './security-schemes.js';
import { assignStability } from './stability.js';

/**
 * Finish a generated document in place.
 *
 * @param document - The generated OpenAPI document; changed in place.
 * @param capabilityRoutes - The `METHOD /path` keys a capability projected
 *   (`registerCapabilitiesInOpenApi`), which take a capability's default
 *   stability when they declare none.
 * @throws If two operations share an `operationId`, or an operation's
 *   stability cannot be worked out.
 */
export function finishDocument(
  document: OperationIdDocument,
  capabilityRoutes: ReadonlySet<string>
): void {
  assignOperationIds(document);
  assignOperationSecurity(document);
  assignStability(document, capabilityRoutes);
  fixNullableRefs(document);
}
