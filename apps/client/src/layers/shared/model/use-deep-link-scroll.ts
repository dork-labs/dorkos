import { useEffect } from 'react';

/**
 * Scroll the element with `[data-section="<section>"]` into view when the section
 * matches the deep-link target. Optionally fires a callback to expand collapsibles.
 *
 * @param section - Current section anchor from `useSettingsDeepLink().section`
 * @param onMatch - Optional callback fired when a section matches (use to expand collapsibles)
 */
export function useDeepLinkScroll(section: string | null, onMatch?: (id: string) => void) {
  useEffect(() => {
    if (!section) return;
    // Sanitize to prevent CSS selector injection (spec §10 mitigation)
    const safeSection = section.replace(/[^a-zA-Z0-9-]/g, '');
    if (!safeSection) return;
    requestAnimationFrame(() => {
      const el = document.querySelector(`[data-section="${safeSection}"]`);
      if (el) {
        el.scrollIntoView({ behavior: 'smooth', block: 'start' });
        onMatch?.(safeSection);
      }
    });
  }, [section, onMatch]);
}
