/** Original import custody: publish availability only after restore and original close both succeed. */
export async function importNewBrowserProfile<T>(
  options: Readonly<{
    open(): Promise<T>;
    close(original: T): Promise<void>;
    current(): boolean;
    finish(observed: boolean): void;
  }>
): Promise<void> {
  const open = options.open.bind(options),
    close = options.close.bind(options),
    current = options.current.bind(options),
    finish = options.finish.bind(options);
  let original: Readonly<{ value: T }> | undefined;
  let first: Readonly<{ value: unknown }> | undefined;
  try {
    if (!current()) throw new Error('BROWSER_PROFILE_IMPORT_UNAVAILABLE');
    original = { value: await open() };
    if (!current()) throw new Error('BROWSER_PROFILE_IMPORT_UNAVAILABLE');
  } catch (value) {
    first = { value };
  }
  if (original) {
    try {
      await close(original.value);
    } catch (value) {
      first ??= { value };
    }
  }
  if (!first) {
    try {
      if (!current()) throw new Error('BROWSER_PROFILE_IMPORT_UNAVAILABLE');
    } catch (value) {
      first = { value };
    }
  }
  try {
    finish(!first);
  } catch (value) {
    first ??= { value };
  }
  if (first) throw first.value;
}
