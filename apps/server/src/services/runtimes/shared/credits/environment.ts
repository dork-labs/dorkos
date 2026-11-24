/** The credits provider key and Doe's existing frozen inference source. */
export const CREDITS_PROVIDER_ID = 'dorkos-credits';

/**
 * Remove the names one runtime excludes from its projected credits environment.
 *
 * @param projected - The already projected environment, before credits overrides.
 * @param exclude - The adapter's own per-name policy for exclusion.
 * @returns A fresh map with the original spelling and values of the retained names.
 */
export function scrubForCredits(
  projected: Readonly<Record<string, string>>,
  exclude: (name: string) => boolean
): Record<string, string> {
  const kept: Record<string, string> = {};
  for (const [name, value] of Object.entries(projected)) {
    if (!exclude(name)) kept[name] = value;
  }
  return kept;
}
