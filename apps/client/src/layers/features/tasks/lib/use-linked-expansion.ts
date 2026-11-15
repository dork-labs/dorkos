import { useState } from 'react';

/**
 * Which schedule row is open to its run history, starting from a link's
 * `expandId` (`/tasks?expand=<id>`, the Needs you card's Open schedule,
 * DOR-4121). A new link opens its row even while the page is already showing;
 * after that the person's own clicks decide.
 *
 * Render-time adjustment, not an effect:
 * https://react.dev/learn/you-might-not-need-an-effect
 *
 * @param expandId - The schedule a link asked to open, if any.
 * @returns The open row's id, and a toggle for one row.
 */
export function useLinkedExpansion(expandId: string | undefined) {
  const [expandedId, setExpandedId] = useState<string | null>(expandId ?? null);
  const [linkedId, setLinkedId] = useState(expandId);
  if (expandId !== linkedId) {
    setLinkedId(expandId);
    if (expandId) setExpandedId(expandId);
  }
  const toggle = (id: string) => setExpandedId((current) => (current === id ? null : id));
  return { expandedId, toggle };
}
