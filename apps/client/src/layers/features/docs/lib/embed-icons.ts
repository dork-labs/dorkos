/**
 * Slash-menu icons for the Docs embeds, as the inline SVG strings Blintz's
 * `EmbedDefinition.icon` takes. They are Lucide icons (ISC), the same set the
 * app and Blintz draw with; strings rather than components because Blintz
 * puts them into its own menu markup.
 *
 * @module features/docs/lib/embed-icons
 */
import type { DocEmbedName } from '@dorkos/shared/doc-embeds';

/** Wraps Lucide's 24px stroke frame around an icon's inner shapes. */
function lucide(inner: string): string {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${inner}</svg>`;
}

/** One icon per embed, keyed by directive name. */
export const DOC_EMBED_ICONS: Readonly<Record<DocEmbedName, string>> = {
  // chart-column
  chart: lucide(
    '<path d="M3 3v16a2 2 0 0 0 2 2h16"/><path d="M18 17V9"/><path d="M13 17V5"/><path d="M8 17v-3"/>'
  ),
  // trending-up
  stat: lucide('<path d="M16 7h6v6"/><path d="m22 7-8.5 8.5-5-5L2 17"/>'),
  // table-2
  table: lucide(
    '<path d="M9 3H5a2 2 0 0 0-2 2v4m6-6h10a2 2 0 0 1 2 2v4M9 3v18m0 0h10a2 2 0 0 0 2-2V9M9 21H5a2 2 0 0 1-2-2V9m0 0h18"/>'
  ),
  // gauge
  progress: lucide('<path d="m12 14 4-4"/><path d="M3.34 19a10 10 0 1 1 17.32 0"/>'),
  // list-tree
  keyValue: lucide(
    '<path d="M8 5h13"/><path d="M13 12h8"/><path d="M13 19h8"/><path d="M3 10a2 2 0 0 0 2 2h3"/><path d="M3 5v12a2 2 0 0 0 2 2h3"/>'
  ),
  // milestone
  timeline: lucide(
    '<path d="M12 13v8"/><path d="M12 3v3"/><path d="M18.172 6a2 2 0 0 1 1.414.586l2.06 2.06a1.207 1.207 0 0 1 0 1.708l-2.06 2.06a2 2 0 0 1-1.414.586H4a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1z"/>'
  ),
  // columns-2
  compare: lucide('<rect width="18" height="18" x="3" y="3" rx="2"/><path d="M12 3v18"/>'),
  // star
  rating: lucide(
    '<path d="M11.525 2.295a.53.53 0 0 1 .95 0l2.31 4.679a2.123 2.123 0 0 0 1.595 1.16l5.166.756a.53.53 0 0 1 .294.904l-3.736 3.638a2.123 2.123 0 0 0-.611 1.878l.882 5.14a.53.53 0 0 1-.771.56l-4.618-2.428a2.122 2.122 0 0 0-1.973 0L6.396 21.01a.53.53 0 0 1-.77-.56l.881-5.139a2.122 2.122 0 0 0-.611-1.879L2.16 9.795a.53.53 0 0 1 .294-.906l5.165-.755a2.122 2.122 0 0 0 1.597-1.16z"/>'
  ),
  // tag
  badge: lucide(
    '<path d="M12.586 2.586A2 2 0 0 0 11.172 2H4a2 2 0 0 0-2 2v7.172a2 2 0 0 0 .586 1.414l8.704 8.704a2.426 2.426 0 0 0 3.42 0l6.58-6.58a2.426 2.426 0 0 0 0-3.42z"/><circle cx="7.5" cy="7.5" r=".5" fill="currentColor"/>'
  ),
  // list
  list: lucide(
    '<path d="M3 5h.01"/><path d="M3 12h.01"/><path d="M3 19h.01"/><path d="M8 5h13"/><path d="M8 12h13"/><path d="M8 19h13"/>'
  ),
};
