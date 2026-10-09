/** Original close producers that can still be pending at the existing whole-close deadline. */
export const originalClosePendingCodes = Object.freeze([
  'NATIVE_CLOSE_PENDING_TREE',
  'NATIVE_CLOSE_PENDING_AUTH_ENTRY',
  'NATIVE_CLOSE_PENDING_AUTH_TERMINAL',
  'NATIVE_CLOSE_PENDING_BROWSER',
  'NATIVE_CLOSE_PENDING_PROXY',
  'NATIVE_CLOSE_PENDING_CHROME_AUTH',
  'NATIVE_CLOSE_PENDING_CHILD',
  'NATIVE_CLOSE_PENDING_GONE',
  'NATIVE_CLOSE_PENDING_DOWNLOADS',
  'NATIVE_CLOSE_PENDING_WIRES',
  'NATIVE_CLOSE_PENDING_ROOT_FORWARD',
] as const);
type OriginalClosePendingCode = (typeof originalClosePendingCodes)[number];

/** Observe the same original promises without replacing them or inspecting rejection values. */
export function createOriginalClosePendingDiagnostic(write?: (value: string) => unknown) {
  const pending = new Set<OriginalClosePendingCode>();
  let emitted = false;
  let sink: ((value: string) => unknown) | undefined;
  try {
    sink = write ?? process.stderr.write.bind(process.stderr);
  } catch {
    /* Diagnostics only. */
  }
  return Object.freeze({
    observe<T>(code: OriginalClosePendingCode, original: Promise<T>): Promise<T> {
      pending.add(code);
      try {
        Promise.prototype.then.call(
          original,
          () => pending.delete(code),
          () => pending.delete(code)
        );
      } catch {
        /* An observation failure cannot replace the original producer. */
      }
      return original;
    },
    enter(code: OriginalClosePendingCode) {
      pending.add(code);
      return () => {
        pending.delete(code);
      };
    },
    emit() {
      if (emitted) return;
      emitted = true;
      const rows = originalClosePendingCodes.filter((code) => pending.has(code));
      for (const code of rows) {
        try {
          sink?.('SUPERVISOR_UNCERTAIN: ' + code + '\n');
        } catch {
          /* Original close stays primary. */
        }
      }
    },
  });
}

/** Closed proxy challenge/ACK decisions; no request IDs, addresses or credentials. */
export const originalProxyAuthenticationCodes = Object.freeze([
  'PROXY_AUTH_OWNER_ENTERED',
  'PROXY_AUTH_TARGET_ATTACHED',
  'PROXY_AUTH_FETCH_ENABLED',
  'PROXY_AUTH_READY',
  'PROXY_AUTH_REQUEST_PAUSED',
  'PROXY_AUTH_EVENT_INVALID',
  'PROXY_AUTH_EVENT_SESSION_UNKNOWN',
  'PROXY_AUTH_MESSAGE_INVALID',
  'PROXY_AUTH_CHALLENGE_EXACT',
  'PROXY_AUTH_CHALLENGE_REPEAT',
  'PROXY_AUTH_CHALLENGE_NOT_PROXY',
  'PROXY_AUTH_CHALLENGE_ORIGIN_INVALID',
  'PROXY_AUTH_CHALLENGE_ORIGIN_MISMATCH',
  'PROXY_AUTH_ACK_OBSERVED',
  'PROXY_AUTH_ACK_REFUSED',
] as const);
type OriginalProxyAuthenticationCode = (typeof originalProxyAuthenticationCodes)[number];

/** Capture one original sink; reserve each fixed code before reentrant publication. */
export function createOriginalProxyAuthenticationDiagnostic(write?: (value: string) => unknown) {
  const emitted = new Set<OriginalProxyAuthenticationCode>();
  let sink: ((value: string) => unknown) | undefined;
  try {
    sink = write ?? process.stderr.write.bind(process.stderr);
  } catch {
    /* No diagnostic authority. */
  }
  return Object.freeze({
    emit(code: OriginalProxyAuthenticationCode) {
      if (emitted.has(code)) return;
      emitted.add(code);
      try {
        sink?.('SUPERVISOR_UNCERTAIN: ' + code + '\n');
      } catch {
        /* Original auth result stays primary. */
      }
    },
  });
}

/** Fixed native identity refusal branches; no process identity or native error text. */
export const journalIdentityRefusalCodes = [
  'JOURNAL_IDENTITY_NATIVE_BIRTH_CHANGED',
  'JOURNAL_IDENTITY_NATIVE_PARENT_CHANGED',
  'JOURNAL_IDENTITY_NATIVE_ALIVE_TO_ZOMBIE',
  'JOURNAL_IDENTITY_NATIVE_ZOMBIE_TO_ALIVE',
  'JOURNAL_IDENTITY_NATIVE_MEMBERSHIP_DISAPPEARED',
  'JOURNAL_IDENTITY_NATIVE_MEMBERSHIP_APPEARED',
  'JOURNAL_IDENTITY_NATIVE_MEMBERSHIP_ABSENT_WITH_PRESENT_READS',
  'JOURNAL_IDENTITY_NATIVE_EAGAIN',
  'JOURNAL_IDENTITY_NATIVE_ESRCH',
  'JOURNAL_IDENTITY_NATIVE_PERMISSION',
  'JOURNAL_IDENTITY_NATIVE_IO',
  'JOURNAL_IDENTITY_NATIVE_OTHER',
  'JOURNAL_IDENTITY_MISSING_FACT',
  'JOURNAL_IDENTITY_BOOT_MISMATCH',
  'JOURNAL_IDENTITY_TERMINAL_CONTRADICTION',
] as const;
export type JournalIdentityRefusalCode = (typeof journalIdentityRefusalCodes)[number];

/** Fixed private close evidence; it has no participant reads or admission authority. */
export const supervisorUncertaintyCodes = [
  ...originalProxyAuthenticationCodes,
  ...originalClosePendingCodes,
  'WIRE_SEND_CALL',
  'WIRE_MESSAGE_CALLBACK',
  'WIRE_MESSAGE_PAYLOAD',
  'WIRE_UNEXPECTED_CLOSE',
  'WIRE_CLOSE_CALLBACK',
  'WIRE_OPEN_WAIT',
  'WIRE_SOCKET_ERROR_OPENING',
  'WIRE_SOCKET_ERROR_COOPERATIVE',
  'WIRE_SOCKET_ERROR_LOCAL_CLOSE',
  'WIRE_SOCKET_ERROR_ACTIVE',
  'WIRE_OPEN_PROMISE',
  'WIRE_OPEN_JOIN',
  'WIRE_STOP_CALL',
  'WIRE_CLOSE_PROMISE',

  'NATIVE_CHILD_EXIT',
  'NATIVE_CHROME_AUTH_LOSS',
  'NATIVE_PROXY_AUTH_LOSS',
  'NATIVE_DOWNLOAD_LOSS',
  'NATIVE_RECONCILIATION_LOSS',
  'NATIVE_STARTUP_FAILURE',
  'NATIVE_TREE_QUERY',
  'NATIVE_TREE_INCOMPLETE',
  'NATIVE_STOP_JOIN',
  'NATIVE_GONE_QUERY',
  'NATIVE_DOWNLOAD_CLOSE',
  'NATIVE_SDK_WIRE_CLOSE',
  'NATIVE_AUTH_WIRE_CLOSE',
  'NATIVE_CHROME_BARRIER_CLOSE',
  'NATIVE_IDENTITY_CLOSE',
  'NATIVE_RECONCILIATION_CLOSE',
  'NATIVE_WIRE_JOIN_THROW',
  'NATIVE_ROOT_FORWARD',
  'NATIVE_FINAL_CUSTODY',
  'NATIVE_CLOSE_WAIT',
  'CLIENT_REFUSED',
  'CLIENT_ROOT_FORWARD_REFUSED',
  ...journalIdentityRefusalCodes,
  'CLIENT_ROOT_FAILURE',
  'CLIENT_CUSTODY_FAULT',
  'CLIENT_REPLY_REFUSED',
  'CLIENT_EXIT',
  'CLIENT_TERMINAL',
  'CLIENT_PIPE_MISSING',
  'CLIENT_PIPE_OVERFLOW',
  'CLIENT_PIPE_ERROR',
  'CLIENT_PIPE_EOF',
  'CLIENT_BASELINE_MISSING',
  'CLIENT_BASELINE_RETURN',
  'CLIENT_ROOT_FORWARD',
  'CLIENT_SENDS_PENDING',
  'CLIENT_CLOSED_REPORT',
  'CLIENT_CLOSE_REQUEST',
  'WORKER_OWNER_REJECT',
  'WORKER_OWNER_FALSE',
  'WORKER_TAIL_REJECT',
  'WORKER_METADATA_REJECT',
  'WORKER_SEMANTIC_REJECT',
  'WORKER_SENDS_PENDING',
] as const;
export type SupervisorUncertaintyCode = (typeof supervisorUncertaintyCodes)[number];

/** Retain the first original branch without introducing a callback at that branch. */
export function createSupervisorUncertaintyDiagnostic(write?: (value: string) => unknown) {
  let first: SupervisorUncertaintyCode | undefined;
  let emitted = false;
  let sink: ((value: string) => unknown) | undefined;
  try {
    sink = write ?? process.stderr.write.bind(process.stderr);
  } catch {
    // Diagnostic capture cannot alter original cleanup.
  }
  const line = () => (first ? 'SUPERVISOR_UNCERTAIN: ' + first + '\n' : '');
  return Object.freeze({
    note(code: SupervisorUncertaintyCode) {
      first ??= code;
    },
    line,
    emit() {
      if (emitted || !first) return;
      emitted = true;
      try {
        sink?.(line());
      } catch {
        // A falsy or reentrant sink cannot replace the already-decided original outcome.
      }
    },
  });
}
