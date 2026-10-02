/** Closed broker failures never include credentials, addresses or native error text. */
export type BrokerCode =
  | 'UNAVAILABLE'
  | 'AUTHORITY_REFUSED'
  | 'CLOCK_UNVERIFIED'
  | 'QUOTA'
  | 'CLOSED'
  | 'EXPIRED'
  | 'PERMIT_REFUSED'
  | 'CREDENTIAL_REFUSED'
  | 'FRAMING_REFUSED'
  | 'PEER_REFUSED'
  | 'BYTE_LIMIT'
  | 'TIMEOUT'
  | 'CLEANUP_UNVERIFIED'
  | 'UPGRADE_REFUSED';
const codes: readonly BrokerCode[] = [
  'UNAVAILABLE',
  'AUTHORITY_REFUSED',
  'CLOCK_UNVERIFIED',
  'QUOTA',
  'CLOSED',
  'EXPIRED',
  'PERMIT_REFUSED',
  'CREDENTIAL_REFUSED',
  'FRAMING_REFUSED',
  'PEER_REFUSED',
  'BYTE_LIMIT',
  'TIMEOUT',
  'CLEANUP_UNVERIFIED',
  'UPGRADE_REFUSED',
];
/** Fixed private errors; caller text is deliberately not retained. */
export class BrokerError extends Error {
  readonly code: BrokerCode;
  constructor(code: BrokerCode) {
    const fixed = codes.includes(code) ? code : 'UNAVAILABLE';
    super(`Browser broker refused: ${fixed}`);
    this.code = fixed;
    this.name = 'BrokerError';
  }
}
