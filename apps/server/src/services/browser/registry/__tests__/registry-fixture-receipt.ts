/** Diagnostic output failure preserves an existing primary error, including falsy values. */
export function emitRegistryFixtureReceipt(
  primary: Readonly<{ failed: boolean; first: unknown }>,
  serialize: () => string,
  write: (line: string) => number
): Readonly<{ failed: boolean; first: unknown; emitted: boolean }> {
  try {
    const line = serialize();
    const bytes = Buffer.byteLength(line);
    if (bytes > 2048 || write(line) !== bytes) throw new Error('REGISTRY_RECEIPT_WRITE_REFUSED');
    return { ...primary, emitted: true };
  } catch (error) {
    return primary.failed
      ? { ...primary, emitted: false }
      : { failed: true, first: error, emitted: false };
  }
}
