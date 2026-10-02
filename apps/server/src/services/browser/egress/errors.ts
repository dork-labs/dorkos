/** Closed refusal reasons exclude destination strings and resolver/socket errors. */
const codes = [
  'INVALID_DESTINATION',
  'HOST_MISMATCH',
  'FORBIDDEN_SCHEME',
  'FORBIDDEN_PORT',
  'ADMIN_DENIED',
  'ADDRESS_DENIED',
  'DNS_FAILED',
  'DNS_TIMEOUT',
  'DNS_LIMIT',
  'DNS_CYCLE',
  'DNS_EMPTY',
  'ABORTED',
  'INVALID_POLICY',
  'INVALID_BINDING',
  'GRANT_REFUSED',
] as const;
export type EgressPolicyCode = (typeof codes)[number];

/** A private fixed-code policy refusal without URL, credential or resolver details. */
export class EgressPolicyError extends Error {
  readonly code: EgressPolicyCode;
  constructor(code: EgressPolicyCode) {
    const fixed = codes.includes(code) ? code : 'INVALID_POLICY';
    super(`Browser destination refused: ${fixed}`);
    this.code = fixed;
    this.name = 'EgressPolicyError';
    Object.freeze(this);
  }
}
