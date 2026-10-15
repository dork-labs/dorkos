/** Token scalar serialization only; callers supply their original captured intrinsics. */
export function encodeOriginalScalarArray(
  values: readonly string[],
  cap: number,
  originalApply: typeof Reflect.apply,
  scalarJson: typeof JSON.stringify,
  utf8Bytes: typeof Buffer.byteLength
): string {
  let text = '[';
  for (let index = 0; index < values.length; index++) {
    const value = values[index];
    if (typeof value !== 'string') throw new Error('Document token evidence invalid.');
    // Original engine arrays have frozen own scalar entries; never dispatch array toJSON/iterator/join.
    text += (index === 0 ? '' : ',') + originalApply(scalarJson, JSON, [value]);
    if (originalApply(utf8Bytes, Buffer, [text, 'utf8']) > cap)
      throw new Error('Document token evidence invalid.');
  }
  text += ']';
  if (originalApply(utf8Bytes, Buffer, [text, 'utf8']) > cap)
    throw new Error('Document token evidence invalid.');
  return text;
}
