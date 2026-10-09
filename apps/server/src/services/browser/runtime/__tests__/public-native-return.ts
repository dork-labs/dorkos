/** Original installed CLI cleanup and physical reads are separate duties.
 * A failed body cannot skip either; a held original close cannot manufacture a return. */
export async function joinOriginalPublicNativeReturn(
  options: Readonly<{
    body: Promise<void>;
    close(): Promise<void>;
    observe(): Promise<void>;
  }>
) {
  const body = options.body,
    close = options.close.bind(options),
    observe = options.observe.bind(options);
  let first: Readonly<{ value: unknown }> | undefined;
  try {
    await body;
  } catch (value) {
    first = { value };
  }
  try {
    await close();
  } catch (value) {
    first ??= { value };
  }
  try {
    await observe();
  } catch (value) {
    first ??= { value };
  }
  if (first) throw first.value;
}
