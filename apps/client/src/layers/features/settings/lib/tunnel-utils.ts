/**
 * Determine quality color from latency.
 *
 * Reads from the cockpit's dot vocabulary (`shared/ui/status-dot.ts`) rather
 * than the raw palette, so the latency dot moves with the theme like every
 * other coloured dot. `-dot` on the amber is the variant tuned to 3:1 against a
 * light surface, which is what a colour-only graphic needs.
 *
 * `friendlyErrorMessage` used to sit beside this and now lives in
 * `@/layers/entities/tunnel` — the Control Center row needs the same sentence
 * the dialog shows, and a widget cannot reach into a feature's `lib/`.
 */
export function latencyColor(ms: number | null): string {
  if (ms === null) return 'bg-muted-foreground/40';
  if (ms < 200) return 'bg-status-success';
  if (ms < 500) return 'bg-status-warning-dot';
  return 'bg-status-error';
}
