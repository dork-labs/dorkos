/** Muted namespace accent colors that work in both light and dark mode. */
const NAMESPACE_PALETTE = [
  '#6366f1', // indigo
  '#f59e0b', // amber
  '#10b981', // emerald
  '#ec4899', // pink
  '#8b5cf6', // violet
  '#14b8a6', // teal
  '#f97316', // orange
  '#06b6d4', // cyan
] as const;

/** Returns a deterministic accent color for a namespace by index. */
export function getNamespaceColor(index: number): string {
  return NAMESPACE_PALETTE[index % NAMESPACE_PALETTE.length];
}
