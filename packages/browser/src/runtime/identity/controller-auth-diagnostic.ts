/** Fixed original authentication decisions; diagnostics never acquire protocol authority. */
export function createControllerAuthDiagnostic(diagnosticWrite?: (value: string) => unknown) {
  type Decision =
    | 'provide'
    | 'repeat'
    | 'session'
    | 'authority'
    | 'source'
    | 'origin-type'
    | 'origin-mismatch'
    | 'origin-invalid'
    | 'challenge-invalid'
    | 'ack-observed'
    | 'ack-refused'
    | 'original-fault'
    | 'send-refused'
    | 'ack-unobserved';
  const emitted = new Set<Decision>();
  let diagnosticSink: ((value: string) => unknown) | undefined;
  try {
    diagnosticSink = diagnosticWrite ?? process.stderr.write.bind(process.stderr);
  } catch {
    /* Diagnostics have no authority. */
  }
  const emit = (decision: Decision) => {
    try {
      if (emitted.has(decision) || emitted.size >= 16) return;
      emitted.add(decision);
      diagnosticSink?.(
        'Browser original controller proxy authentication diagnostic ' +
          JSON.stringify({ ordinal: emitted.size, decision }) +
          '\n'
      );
    } catch {
      /* The original decision and producer cause stay unchanged. */
    }
  };
  return { emit, write: (value: string) => diagnosticSink?.(value) };
}
