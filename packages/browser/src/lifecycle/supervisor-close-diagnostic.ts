import { supervisorUncertaintyCodes } from '../runtime/supervisor-uncertainty-diagnostic.js';
/** Preserve only fixed original worker failure codes, never its diagnostic text. */
export function captureOriginalSupervisorCloseDiagnostic(
  supervisor: { diagnostics(): string },
  write?: (value: string) => unknown
): () => void {
  let read: (() => string) | undefined;
  let sink: ((value: string) => unknown) | undefined;
  try {
    sink = write ?? process.stderr.write.bind(process.stderr);
  } catch {
    // Capturing an optional diagnostic sink cannot affect original ownership.
  }
  try {
    const original = supervisor.diagnostics;
    if (typeof original === 'function') read = original.bind(supervisor);
  } catch {
    // A diagnostic getter has no authority over the original close.
  }
  let emitted = false;
  return () => {
    if (emitted) return;
    emitted = true;
    try {
      let value: unknown;
      let readable = !!read;
      try {
        value = read?.();
      } catch {
        readable = false;
      }
      const rows: { source: 'close' | 'child-return' | 'uncertainty'; code: string }[] = [];
      let state: 'observed' | 'absent' | 'invalid' | 'unavailable' = readable
        ? 'absent'
        : 'unavailable';
      if (readable && (typeof value !== 'string' || value.length > 262144)) state = 'invalid';
      else if (readable && typeof value === 'string') {
        for (const line of value.split('\n')) {
          const match =
            /^(SUPERVISOR_CLOSE|SUPERVISOR_CHILD_RETURN|SUPERVISOR_UNCERTAIN): (.*)$/.exec(line);
          if (!match) continue;
          state = 'observed';
          if (rows.length < 16)
            rows.push({
              source:
                match[1] === 'SUPERVISOR_CLOSE'
                  ? 'close'
                  : match[1] === 'SUPERVISOR_CHILD_RETURN'
                    ? 'child-return'
                    : 'uncertainty',
              code: originalCodes.has(match[2]!) ? match[2]! : 'other',
            });
        }
      }
      sink?.(
        'Browser original supervisor close diagnostic ' + JSON.stringify({ state, rows }) + '\n'
      );
    } catch {
      // Original producer, reentrant sink and falsy sink failures cannot replace cleanup.
    }
  };
}
const originalCodes = new Set<string>([
  'unknown',
  ...supervisorUncertaintyCodes,
  'CHILD_ACQUISITION_UNCERTAIN',
  'CHILD_BIRTH_UNAVAILABLE',
  'CHILD_ERROR',
  'CHILD_EXIT_FAILED',
  'CHILD_NATIVE_RETURN_UNAVAILABLE',
  'CHILD_PIPE_EOF_UNAVAILABLE',
  'CHILD_PIPE_ERROR',
  'CHILD_PIPE_OVERFLOW',
  'CHILD_PIPE_RETENTION_UNAVAILABLE',
  'CHILD_PIPE_UNAVAILABLE',
  'CHILD_RETURN_UNCERTAIN',
  'CHILD_SIGNALED',
  'CHILD_TERMINAL_UNCERTAIN',
  'CHROME_FIXTURE_ADMISSION_CLOSED',
  'CHROME_FIXTURE_AUTH_ROOT_ACK_INVALID',
  'CHROME_FIXTURE_AUTH_ROOT_ACK_UNKNOWN',
  'CHROME_FIXTURE_COMPLETE_TARGET_METADATA_REQUIRED',
  'CHROME_FIXTURE_CONTEXT_CHANGED',
  'CHROME_FIXTURE_DISTINCT_WIRES_REQUIRED',
  'CHROME_FIXTURE_ENDPOINT_INVALID',
  'CHROME_FIXTURE_FETCH_EVENT_INVALID',
  'CHROME_FIXTURE_FETCH_OWNER_UNKNOWN',
  'CHROME_FIXTURE_LATE_METADATA_REFUSED',
  'CHROME_FIXTURE_MISSED_FIRST_INITIALIZATION',
  'CHROME_FIXTURE_ORIGINAL_ACK_INVALID',
  'CHROME_FIXTURE_ORIGINAL_ACK_UNKNOWN',
  'CHROME_FIXTURE_ORIGINAL_ATTACHMENT_INVALID',
  'CHROME_FIXTURE_ORIGINAL_CLOSE_UNKNOWN',
  'CHROME_FIXTURE_ORIGINAL_MESSAGE_INVALID',
  'CHROME_FIXTURE_ORIGINAL_PARENT_RETIRED',
  'CHROME_FIXTURE_ORIGINAL_REPLY_CHANGED',
  'CHROME_FIXTURE_ORIGINAL_RESUME_REFUSED',
  'CHROME_FIXTURE_ORIGINAL_SHARED_DETACH_ACK_INVALID',
  'CHROME_FIXTURE_ORIGINAL_SHARED_DETACH_EVENT_INVALID',
  'CHROME_FIXTURE_ORIGINAL_SHARED_DETACH_REFUSED',
  'CHROME_FIXTURE_ORIGINAL_SHARED_DETACH_UNKNOWN',
  'CHROME_FIXTURE_ORIGINAL_TARGET_REPLACED',
  'CHROME_FIXTURE_ORIGINAL_TARGET_RETURN_UNKNOWN',
  'CHROME_FIXTURE_ORIGINAL_WIRE_CLOSED',
  'CHROME_FIXTURE_POPUP_OPENER_UNKNOWN',
  'CHROME_FIXTURE_REPLY_CAPACITY',
  'CHROME_FIXTURE_SDK_COMMAND_INVALID',
  'CHROME_FIXTURE_SEND_RECEIVER_REPLACED',
  'CHROME_FIXTURE_TARGET_UNSUPPORTED',
  'CHROME_FIXTURE_WIRE_ACQUISITION_UNKNOWN',
  'CHROME_FIXTURE_WIRE_ADMISSION_CLOSED',
  'CHROME_FIXTURE_WIRE_ALREADY_OWNED',
  'CHROME_FIXTURE_WIRE_CAPACITY',
  'CHROME_FIXTURE_WIRE_CLOSED_BEFORE_OPEN',
  'CHROME_FIXTURE_WIRE_FRAME_INVALID',
  'CHROME_FIXTURE_WIRE_OPEN_FAILED',
  'CHROME_FIXTURE_WIRE_OPEN_UNKNOWN',
  'CHROME_FIXTURE_WIRE_UNAVAILABLE',
  'CHROME_FIXTURE_WIRE_UNEXPECTED_CLOSE',
  'DEVTOOLS_CLOSE_UNCERTAIN',
  'DEVTOOLS_ENDPOINT_CHANGED',
  'DEVTOOLS_ENDPOINT_STALE',
  'DEVTOOLS_ENDPOINT_UNAVAILABLE',
  'DEVTOOLS_ROOT_MISMATCH',
  'IDENTITY_ACCEPTANCE_CONFIGURATION_REFUSED',
  'IDENTITY_MODE_UNAVAILABLE',
  'PERSISTENT_CONTEXT_UNAVAILABLE',
  'PROCESS_OBSERVATION_UNAVAILABLE',
  'PROXY_AUTH_CHANNEL_CLOSED',
  'PROXY_AUTH_CHANNEL_UNAVAILABLE',
  'PROXY_AUTH_CUSTODY_UNCERTAIN',
  'PROXY_AUTH_METHOD_REFUSED',
  'PROXY_AUTH_METHOD_TIMEOUT',
  'PROXY_AUTH_OPEN_FAILED',
  'PROXY_AUTH_OPEN_TIMEOUT',
  'PROXY_AUTH_PEER_INVALID',
  'PROXY_AUTH_SEND_FAILED',
  'PROXY_AUTH_TARGET_UNAVAILABLE',
  'PROXY_AUTH_WORKER_PARENT_UNAVAILABLE',
  'SUPERVISOR_ADMISSION_CLOSED',
  'SUPERVISOR_AUTH_ACK_FOREIGN',
  'SUPERVISOR_AUTH_ACK_UNOBSERVED',
  'SUPERVISOR_AUTH_ADMISSION_CLOSED',
  'SUPERVISOR_AUTH_ATTEMPTS_EXHAUSTED',
  'SUPERVISOR_AUTH_CHALLENGE_INVALID',
  'SUPERVISOR_AUTH_HANDLER_UNAVAILABLE',
  'SUPERVISOR_AUTH_MESSAGE_INVALID',
  'SUPERVISOR_AUTH_ORIGINALS_PENDING',
  'SUPERVISOR_AUTH_ORIGINAL_REFUSED',
  'SUPERVISOR_AUTH_TARGET_IDENTITY_UNOBSERVED',
  'SUPERVISOR_AUTH_UNEXPECTED_CLOSE',
  'SUPERVISOR_IDENTITY_CONTEXT_CHANGED',
  'SUPERVISOR_IDENTITY_ORIGINALS_PENDING',
  'SUPERVISOR_IDENTITY_OWNER_UNAVAILABLE',
  'SUPERVISOR_IDENTITY_UNAVAILABLE',
  'SUPERVISOR_ORIGINAL_BROWSER_ATTACH_REFUSED',
  'SUPERVISOR_ORIGINAL_BROWSER_ATTACH_REPLY_REFUSED',
  'SUPERVISOR_ORIGINAL_BROWSER_ATTACH_REPLY_REPEATED',
  'SUPERVISOR_ORIGINAL_BROWSER_CLOSE_REFUSED',
  'SUPERVISOR_ORIGINAL_BROWSER_CLOSE_REPLY_CHANGED',
  'SUPERVISOR_ORIGINAL_BROWSER_DETACH_UNCAPTURED',
  'SUPERVISOR_ORIGINAL_BROWSER_SEND_UNCAPTURED',
  'SUPERVISOR_ORIGINAL_BROWSER_SESSION_MISSING',
  'SUPERVISOR_ORIGINAL_BROWSER_SESSION_REUSED',
  'SUPERVISOR_ORIGINAL_BROWSER_SESSION_UNOBSERVED',
  'SUPERVISOR_PROCESS_REQUIRED',
  'SUPERVISOR_PROFILE_UNCERTAIN',
  'SUPERVISOR_WAIT_EXPIRED',
]);
