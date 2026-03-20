import { useState, useEffect, useRef } from 'react';

/**
 * Track which section is currently visible using IntersectionObserver.
 *
 * @param sectionIds - Array of section element IDs to observe
 * @returns The ID of the currently active (topmost visible) section, or null
 */
export function useTocScrollspy(sectionIds: string[]): string | null {
  const [activeId, setActiveId] = useState<string | null>(null);
  const intersectingRef = useRef(new Set<string>());

  useEffect(() => {
    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (entry.isIntersecting) {
            intersectingRef.current.add(entry.target.id);
          } else {
            intersectingRef.current.delete(entry.target.id);
          }
        }
        // First ID in document order that is currently intersecting
        const first = sectionIds.find((id) => intersectingRef.current.has(id));
        setActiveId(first ?? null);
      },
      {
        // Top offset accounts for sticky header (36px) + breathing room.
        // Bottom 60% exclusion prevents rapid flickering as sections scroll through.
        rootMargin: '-48px 0px -60% 0px',
        threshold: 0,
      }
    );

    for (const id of sectionIds) {
      const el = document.getElementById(id);
      if (el) observer.observe(el);
    }

    return () => observer.disconnect();
  }, [sectionIds]);

  return activeId;
}
