/** Deterministic scalar authentication bytes only; this encoder never signs or grants authority. */
import type { OriginalStoredDocTokenData, OriginalNativeDocTokenHeader } from './token-store.js';
const stringifyScalar = JSON.stringify;
const applyScalar = Reflect.apply;
function stringArray(values: readonly string[]): string {
  let text = '[';
  for (let index = 0; index < values.length; index++) {
    if (typeof values[index] !== 'string')
      throw new Error('Invalid original token authentication data.');
    text += (index ? ',' : '') + applyScalar(stringifyScalar, JSON, [values[index]]);
  }
  return text + ']';
}
function encode(fields: readonly (string | number | null)[]): string {
  let text = '[';
  for (let index = 0; index < fields.length; index++) {
    const value = fields[index];
    if (value !== null && typeof value !== 'string' && value !== 1)
      throw new Error('Invalid original token authentication data.');
    text += (index ? ',' : '') + applyScalar(stringifyScalar, JSON, [value]);
  }
  return text + ']';
}
/** Encode the original token issuance fields for authentication. */
export function encodeOriginalDocTokenIssuanceAuthentication(
  data: OriginalStoredDocTokenData
): string {
  const r = data.record,
    b = data.binding;
  return encode([
    r.tokenId,
    r.tokenHash,
    r.documentId,
    stringArray(r.allowedTypes),
    stringArray(r.directions),
    stringArray(r.permissions),
    r.creatorId,
    r.createdAt,
    r.expiresAt,
    b.scope,
    b.generation,
    b.birthJson,
    b.incarnationJson,
    b.declarationHash,
    b.approvedGrantsJson,
    b.issuerJson,
    b.manifestHash,
    r.revokedAt,
    b.version,
  ]);
}
/** Encode the native token header fields for authentication. */
export function encodeOriginalDocTokenHeaderAuthentication(
  h: OriginalNativeDocTokenHeader,
  payloadJson: string
): string {
  return encode([
    h.tokenId,
    h.tokenHash,
    h.documentId,
    h.allowedTypesJson,
    h.directionsJson,
    h.permissionsJson,
    h.creatorId,
    h.createdAt,
    h.expiresAt,
    h.scope,
    h.generation,
    h.birthJson,
    h.incarnationJson,
    h.declarationHash,
    h.approvedGrantsJson,
    payloadJson,
    h.manifestHash,
    h.revokedAt,
    h.bindingVersion,
  ]);
}
