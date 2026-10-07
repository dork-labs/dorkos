import { readOriginalNavigationRefusal } from '@dorkos/browser/server-owner';
import { logger } from '../../../../lib/logger.js';

const originalRefusal = readOriginalNavigationRefusal;
const originalDescriptor = Object.getOwnPropertyDescriptor;
const originalHasOwn = Object.prototype.hasOwnProperty;
const codes = Object.freeze([
  'BROWSER_LAUNCH_TIMEOUT',
  'BROWSER_STOPPED',
  'CAPTURE_FAILED',
  'CAPTURE_LIMIT',
  'CAPTURE_QUEUE_FULL',
  'CAPTURE_TIMEOUT',
  'COMMAND_UNSUPPORTED',
  'CONTEXT_CLOSE_TIMEOUT',
  'COUNTER_EXHAUSTED',
  'ENGINE_STOPPED',
  'EXECUTABLE_UNAVAILABLE',
  'FIXTURE_PROXY_CLOSE_FAILED',
  'FIXTURE_PROXY_UNAVAILABLE',
  'IDENTITY_MODE_UNAVAILABLE',
  'INITIAL_NAVIGATION_FAILED',
  'LIBRARY_UNAVAILABLE',
  'NETWORK_POLICY_UNSUPPORTED',
  'OPEN_FAILED',
  'OPERATION_FAILED',
  'PAGE_UNAVAILABLE',
  'PLATFORM_UNSUPPORTED',
  'POLICY_REFUSED',
  'POLICY_UNAVAILABLE',
  'PROCESS_ATTRIBUTION_UNAVAILABLE',
  'PROCESS_OBSERVATION_UNAVAILABLE',
  'PROFILE_IN_USE',
  'PROFILE_SETUP_FAILED',
  'PROFILE_UNCERTAIN',
  'RUNTIME_UNAVAILABLE',
  'STALE_BINDING',
  'UNKNOWN_NATIVE_HOLDER',
  'UNSAFE_DIRECTORY',
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
  'unavailable',
  'unauthenticated',
  'inaccessible',
] as const);
const nativeErrors = Object.freeze([
  'ERR_ABORTED',
  'ERR_FAILED',
  'ERR_TIMED_OUT',
  'ERR_CONNECTION_CLOSED',
  'ERR_CONNECTION_RESET',
  'ERR_CONNECTION_REFUSED',
  'ERR_CONNECTION_FAILED',
  'ERR_NAME_NOT_RESOLVED',
  'ERR_INTERNET_DISCONNECTED',
  'ERR_PROXY_CONNECTION_FAILED',
  'ERR_TUNNEL_CONNECTION_FAILED',
  'ERR_INVALID_AUTH_CREDENTIALS',
  'ERR_HTTP_RESPONSE_CODE_FAILURE',
  'ERR_CERT_AUTHORITY_INVALID',
  'ERR_CERT_COMMON_NAME_INVALID',
  'ERR_CERT_DATE_INVALID',
  'ERR_SSL_PROTOCOL_ERROR',
  'ERR_TOO_MANY_REDIRECTS',
  'ERR_BLOCKED_BY_CLIENT',
] as const);
type Row = Readonly<{
  ordinal: number;
  phase: NonNullable<ReturnType<typeof readOriginalNavigationRefusal>>['phase'] | 'unknown';
  decision: 'original' | 'custody' | 'canonical' | 'authority' | 'state' | 'unknown';
  code: (typeof codes)[number] | 'unknown';
  nativeError: (typeof nativeErrors)[number] | 'unknown';
}>;
function ownData(value: unknown, key: string): unknown {
  if ((typeof value !== 'object' || value === null) && typeof value !== 'function') return;
  try {
    const descriptor = originalDescriptor(value, key);
    return descriptor && Reflect.apply(originalHasOwn, descriptor, ['value'])
      ? descriptor.value
      : undefined;
  } catch {
    // A hostile descriptor producer cannot become operational failure or expose data.
  }
}
function classify(value: unknown): Pick<Row, 'code' | 'nativeError'> {
  const code = ownData(value, 'code');
  const matchedCode = codes.find((fixed) => fixed === code);
  if (matchedCode) return { code: matchedCode, nativeError: 'unknown' };
  const reason = ownData(value, 'reason');
  const matchedReason = codes.find((fixed) => fixed === reason);
  if (matchedReason) return { code: matchedReason, nativeError: 'unknown' };
  const message = ownData(value, 'message');
  // Only the first fixed Chromium token is projected. No URI, stack or arbitrary text leaves.
  const token =
    typeof message === 'string' && message.length <= 8192
      ? /^page\.goto: (?:net::)?(ERR_[A-Z_]+)(?: at |$)/u.exec(message.split('\n', 1)[0]!)?.[1]
      : undefined;
  return {
    code: 'unknown',
    nativeError: nativeErrors.find((fixed) => fixed === token) ?? 'unknown',
  };
}
/** Bounded private original refusal projection; never changes cause, admission or public output. */
export function createBrowserNavigationRefusalDiagnostic(emit: (row: Row) => void) {
  let count = 0;
  let first: Readonly<{ value: unknown }> | undefined;
  return Object.freeze({
    failure(value: unknown): unknown {
      first ??= Object.freeze({ value });
      if (count >= 16) return value;
      const ordinal = ++count; // Reserve before any descriptor trap or sink can reenter.
      try {
        const original = originalRefusal(value);
        const row = Object.freeze({
          ordinal,
          phase: original?.phase ?? 'unknown',
          decision: original?.decision ?? 'unknown',
          ...classify(value),
        });
        emit(row);
      } catch {
        // Lookup, classifier, row construction and original sink are all non-authoritative.
      }
      return value;
    },
    originalFailure: () => first,
  });
}
/** Capture initialized original logger once; publish only fixed diagnostic scalars after refusal. */
export function createOriginalBrowserNavigationRefusalDiagnostic() {
  let info: typeof logger.info | undefined;
  try {
    const original = logger;
    info = original.info.bind(original);
  } catch {
    /* Optional sink only. */
  }
  return createBrowserNavigationRefusalDiagnostic((row) =>
    info?.('Browser original navigation refusal', row)
  );
}
