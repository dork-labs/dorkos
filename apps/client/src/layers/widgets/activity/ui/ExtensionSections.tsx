/**
 * "From your extensions" — the extension half of the `dashboard.sections` slot,
 * re-homed to the top of the Activity tab.
 *
 * The slot id is unchanged, so extensions in the wild keep working with no
 * manifest change; only the surface that draws them moved, because the
 * dashboard page they used to live on is gone (team-room-home spec D3.5). The
 * built-in half of the slot went with it, so this filter now guards a case
 * nothing produces — kept because the slot is public and a first-party
 * contribution could join it again, and this tab is not where one would belong.
 *
 * @module widgets/activity/ui/ExtensionSections
 */
import { useId, useMemo } from 'react';
import { useSlotContributions, isExtensionContributionId } from '@/layers/shared/model';

/** Extension-contributed dashboard sections, or nothing at all when there are none. */
export function ExtensionSections() {
  const headingId = useId();
  const contributions = useSlotContributions('dashboard.sections');

  const visible = useMemo(
    () =>
      contributions.filter(
        (c) => isExtensionContributionId(c.id) && (!c.visibleWhen || c.visibleWhen())
      ),
    [contributions]
  );

  // Zero DOM when no extension contributes — no empty heading, no placeholder.
  if (visible.length === 0) return null;

  return (
    <section className="space-y-3" aria-labelledby={headingId}>
      <h2
        id={headingId}
        className="text-muted-foreground text-xs font-medium tracking-widest uppercase"
      >
        From your extensions
      </h2>
      <div className="space-y-4">
        {visible.map((section) => (
          <section.component key={section.id} />
        ))}
      </div>
    </section>
  );
}
