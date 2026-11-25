/**
 * The sizes a hosted-space move is refused over, said in words: the server's
 * room check and the app's reading of a refused move say them the same way.
 * The refusal itself carries only numbers (DOR-4979); these sentences are
 * built from them where a person reads them.
 *
 * @module shared/move-sizes
 */

/**
 * A size in the units a person's own computer shows (powers of 1000, as
 * macOS Finder and most file managers count): GB with one decimal from a
 * gigabyte up, then whole MB, KB or bytes.
 *
 * @param bytes - The size in bytes.
 * @param round - `up` for space needed, `down` for space on hand, so a
 *   shortfall never reads as two equal numbers.
 */
export function describeBytes(bytes: number, round: 'up' | 'down'): string {
  const fit = round === 'up' ? Math.ceil : Math.floor;
  if (bytes >= 1e9) return `${(fit(bytes / 1e8) / 10).toFixed(1)} GB`;
  if (bytes >= 1e6) return `${fit(bytes / 1e6)} MB`;
  if (bytes >= 1e3) return `${fit(bytes / 1e3)} KB`;
  return `${bytes} bytes`;
}

/**
 * What a person reads when this computer has no room to hold an export.
 *
 * @param neededBytes - The free space the export needs.
 * @param freeBytes - The free space there is.
 */
export function noRoomSentence(neededBytes: number, freeBytes: number): string {
  return `This computer doesn’t have room to hold the export. It needs ${describeBytes(neededBytes, 'up')} free and has ${describeBytes(freeBytes, 'down')}. Free up some space, then try again.`;
}

/**
 * What a person reads when an export is larger than DorkOS moves.
 *
 * @param archiveBytes - The export's size.
 * @param limitBytes - The most the space's host takes.
 */
export function tooLargeSentence(archiveBytes: number, limitBytes: number): string {
  return `This export is too large to move. It is ${describeBytes(archiveBytes, 'up')}, and the most DorkOS takes is ${describeBytes(limitBytes, 'down')}.`;
}
