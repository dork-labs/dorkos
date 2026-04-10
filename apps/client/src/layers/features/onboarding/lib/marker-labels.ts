/** Marker label mapping for display-friendly badge text. */
export const MARKER_LABELS: Record<string, string> = {
  'AGENTS.md': 'AGENTS.md',
  '.cursor': '.cursor',
  '.github/copilot': 'Copilot',
  '.dork': 'DorkOS',
};

/** Format a marker string into a user-friendly badge label. */
export function formatMarker(marker: string): string {
  return MARKER_LABELS[marker] ?? marker;
}
