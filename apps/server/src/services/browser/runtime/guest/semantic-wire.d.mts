export function encodeSemanticChunk(
  value: Readonly<{ request: number; tabId: string; sequence: number }>,
  original: Uint8Array
): Uint8Array;
