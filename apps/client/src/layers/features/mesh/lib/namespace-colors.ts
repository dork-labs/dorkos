/** Muted namespace accent colors that work in both light and dark mode. */
const NAMESPACE_PALETTE = [
  '#6366f1', // indigo
  '#f59e0b', // amber
  '#10b981', // emerald
  '#ec4899', // pink
  // Fuchsia, not violet: violet sat too close to indigo to tell two namespaces
  // apart (DOR-3154).
  '#d946ef', // fuchsia
  '#14b8a6', // teal
  'hsl(var(--chart-1))', // orange
  '#06b6d4', // cyan
] as const;

/** Returns a deterministic accent color for a namespace by index. */
export function getNamespaceColor(index: number): string {
  return NAMESPACE_PALETTE[index % NAMESPACE_PALETTE.length];
}
