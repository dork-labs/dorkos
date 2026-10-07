type Observation = Readonly<{
  sequence: number;
  parent: Readonly<{ pid: number; birth: string }>;
  stage: string;
  batch: unknown;
  cause: unknown;
}>;
export type OriginalTreeDiagnosticBank = {
  primary?: Readonly<{ cause: unknown }>;
  diagnosticFailure?: Readonly<{ cause: unknown }>;
};
/** Diagnostic output never replaces the original failed tree decision or enters cause getters. */
export function retainOriginalTreeDiagnostic(
  original: unknown,
  read: () => Observation | undefined,
  manager: Readonly<{ pid: number; birth: string }>,
  bank: OriginalTreeDiagnosticBank,
  publish: (bytes: string) => unknown
): unknown {
  bank.primary ??= Object.freeze({ cause: original });
  try {
    const diagnostic = read();
    const cause = diagnostic?.cause;
    const primitive =
      cause === null
        ? { type: 'null' }
        : typeof cause === 'string'
          ? { type: 'string', value: cause.slice(0, 512) }
          : typeof cause === 'boolean'
            ? { type: 'boolean', value: cause }
            : typeof cause === 'number' && Number.isFinite(cause)
              ? { type: 'number', value: cause }
              : { type: typeof cause };
    // The exact original boxed cause remains on the native observer; objects are opaque here.
    const receipt = JSON.stringify({
      fixture: 'production-public-native-original-tree-failure',
      manager,
      sequence: diagnostic?.sequence,
      parent: diagnostic?.parent,
      stage: diagnostic?.stage,
      batch: diagnostic?.batch,
      reason: primitive,
    });
    if (Buffer.byteLength(receipt) > 256 * 1024)
      throw new Error('PUBLIC_NATIVE_TREE_DIAGNOSTIC_OVERFLOW');
    publish(receipt);
  } catch (cause) {
    bank.diagnosticFailure ??= Object.freeze({ cause });
  }
  return bank.primary.cause;
}
