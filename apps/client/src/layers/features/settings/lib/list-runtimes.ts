/**
 * Naming runtimes inside a sentence, in the Settings tab's voice.
 *
 * Lifted out of the retired settings trust-stop section when that setting split
 * into the shared `GlobalTrustRow` and each card's `TrustRow`: both halves
 * of that split can end up saying "New sessions on X and Y run at full power",
 * and two copies of the comma-and-conjunction rule would drift the first time
 * either surface reworded it.
 *
 * @module features/settings/lib/list-runtimes
 */

/**
 * Name runtimes in a sentence: "Codex", "Codex and OpenCode", "A, B and C".
 *
 * Takes anything carrying a `label`, so a caller passes its own row type
 * straight in rather than mapping to strings first.
 *
 * @param entries - The runtimes to name, in the order they should read.
 * @returns The joined names, or an empty string when there are none.
 */
export function listRuntimes(entries: readonly { label: string }[]): string {
  const names = entries.map((entry) => entry.label);
  if (names.length <= 1) return names[0] ?? '';
  return `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
}
