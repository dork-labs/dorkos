/** Fail-closed JSON validation at the document-channel persistence boundary. */
import {
  inspectCanvasChannelJson,
  CANVAS_CHANNEL_STATE_BYTES,
  CANVAS_CHANNEL_ENVELOPE_BYTES,
  CanvasChannelStateSchema,
} from '@dorkos/shared/canvas-channel-schemas';

/** A stored record failed JSON decoding or structural validation. */
export class DocChannelCorruptionError extends Error {
  readonly code = 'DOC_CHANNEL_CORRUPT_ROW';
  /** Build an error containing identity only, never stored payload text. */
  constructor(
    readonly table: string,
    readonly recordId: string,
    options?: ErrorOptions
  ) {
    super(`Invalid stored document channel record: ${table}/${recordId}`, options);
    this.name = 'DocChannelCorruptionError';
  }
}

/** Validate each persisted JSON column before Drizzle serializes or readers expose it. */
export function assertJson(value: unknown, maxBytes = 16 * 1024 * 1024): void {
  const problem = inspectCanvasChannelJson(value, maxBytes);
  if (problem) throw new TypeError(problem);
}

/** Column bounds differ from the complete wire envelope and exclude row metadata nesting. */
export function assertRowJson(row: object): void {
  const descriptors = Object.getOwnPropertyDescriptors(row);
  for (const [key, descriptor] of Object.entries(descriptors)) {
    if (!('value' in descriptor) || !descriptor.enumerable)
      throw new TypeError('Invalid stored row');
    const bytes =
      key === 'state'
        ? CANVAS_CHANNEL_STATE_BYTES
        : key === 'effectivePayload'
          ? 80 * 1024
          : key === 'payload' || key === 'provenance'
            ? CANVAS_CHANNEL_ENVELOPE_BYTES
            : 16 * 1024 * 1024;
    assertJson(descriptor.value, bytes);
    if (
      [
        'nextDocSeq',
        'retentionFloor',
        'docSeq',
        'stateRev',
        'revision',
        'grantRevision',
        'attempt',
      ].includes(key)
    ) {
      const minimum = ['stateRev', 'attempt'].includes(key) ? 0 : 1;
      if (!Number.isSafeInteger(descriptor.value) || descriptor.value < minimum)
        throw new TypeError('Invalid stored sequence or revision');
    }
    if (key === 'state' && !CanvasChannelStateSchema.safeParse(descriptor.value).success)
      throw new TypeError('Invalid stored state object');
    if (
      (key === 'allowedTypes' || key === 'inputEventIds') &&
      (!Array.isArray(descriptor.value) ||
        descriptor.value.some((value: unknown) => typeof value !== 'string'))
    )
      throw new TypeError('Invalid stored string list');
  }
}

/** Read a JSON-bearing row without tolerating payload corruption. */
export function readChecked<T>(table: string, recordId: string, read: () => T): T {
  let result: T;
  try {
    result = read();
  } catch (cause) {
    // Drizzle decodes JSON during row mapping; native SQLite errors remain native.
    if (cause instanceof SyntaxError)
      throw new DocChannelCorruptionError(table, recordId, { cause });
    throw cause;
  }
  try {
    if (result !== undefined && result !== null) {
      for (const row of Array.isArray(result) ? result : [result]) assertRowJson(row as object);
    }
  } catch (cause) {
    throw new DocChannelCorruptionError(table, recordId, { cause });
  }
  return result;
}
