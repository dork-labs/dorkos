/** Strict query parsing shared by managed linked-instance GET routes. */

/** Reject duplicate and unknown query keys before schema validation. */
export function strictManagedQuery(
  request: Request,
  allowed: readonly string[]
): Record<string, string> {
  const params = new URL(request.url).searchParams;
  const result: Record<string, string> = {};
  for (const key of new Set(params.keys())) {
    if (!allowed.includes(key) || params.getAll(key).length !== 1) {
      throw new Error('invalid_managed_query');
    }
    result[key] = params.get(key)!;
  }
  return result;
}

/** Convert one required decimal integer without accepting alternate spellings. */
export function managedQueryInteger(value: string | undefined): number | undefined {
  if (value === undefined || !/^(0|[1-9]\d*)$/.test(value)) return undefined;
  return Number(value);
}
